import { OperationError } from "#errors.ts";
import type { HarnessId } from "#harness/ids.ts";
import { AllAdapters, selectAdapters } from "#harness/registry.ts";
import type { Adapter } from "#harness/registry.ts";
import type { LockedServer } from "#lock/agents-lock.ts";
import { describeLocation } from "#manifest/load.ts";
import type { McpEntry } from "#manifest/schema.ts";
import { createServer, getPackageName, hashEntry } from "#mcp/entry.ts";
import type { McpServer } from "#mcp/entry.ts";
import { isVersionInRange, resolveVersion } from "#mcp/npm.ts";
import { isSameValue } from "#util/config-value.ts";
import type { Workspace } from "#workspace.ts";

/** One change to one harness config. */
export type Action =
  | { kind: "add"; adapter: Adapter; server: McpServer; reason: "missing" | "modified" | "forced" }
  | { kind: "remove"; adapter: Adapter; name: string };

export type Status = "ok" | "modified" | "missing" | "untracked" | "unsupported";

/** One server, as `list` shows it. */
export interface ServerRow {
  name: string;
  source: string;
  status: Status;
  harnesses: HarnessId[];
  /** The manifest that declares the server. Unset for an untracked server. */
  declaredIn: string | undefined;
  /** Rendering failures reported by list; installation still rejects them. */
  issues?: { harness: HarnessId; message: string }[];
}

export interface Plan {
  actions: Action[];
  /** What `lock.mcp` must hold after the plan is applied. */
  locked: Record<string, LockedServer>;
  /** True when the lock on disk differs from `locked`. */
  isLockStale: boolean;
  rows: ServerRow[];
  /** False when no harness is set or detected, so there is nowhere to install. */
  hasTargets: boolean;
  /** Servers that a harness already holds and agentsrc did not install. Empty with `force`. */
  clashes: string[];
}

export interface PlanOptions {
  /** Rewrite every entry, and replace unmanaged servers of the same name. */
  force: boolean;
  /** Package entries to move to the newest version in range. */
  update: "none" | "all" | string[];
  /**
   * Resolve a package version that the lock does not pin. `list` turns this off so it needs no
   * network; an unpinned package is then reported as `missing`.
   */
  resolve: boolean;
  /** List incompatible targets instead of failing on an adapter's render error. */
  reportUnsupported?: boolean;
}

/**
 * Compares the manifest with the lock and the harness files. It reads harness files and the npm
 * registry, and writes nothing. Every server is rendered for every target here, so an entry that a
 * harness cannot express stops the command before any file changes.
 */
export async function planServers(workspace: Workspace, options: PlanOptions): Promise<Plan> {
  const declared = Object.entries(workspace.manifest.mcp);
  const acting = getActingAdapters(workspace);
  const actions: Action[] = [];
  const locked: Record<string, LockedServer> = {};
  const rows: ServerRow[] = [];
  const clashes: string[] = [];
  let hasTargets = false;

  for (const [name, { declaredIn, entry }] of declared) {
    const targets = getTargets(workspace, entry);
    hasTargets ||= targets.length > 0;

    const row = {
      declaredIn: describeLocation(declaredIn),
      harnesses: targets.map((adapter) => adapter.id),
      name,
      source: describeEntry(entry),
    };

    // One entry at a time keeps registry errors in manifest order.
    // oxlint-disable-next-line no-await-in-loop
    const pin = await lockEntry(workspace, name, entry, options);

    if (pin === "unpinned") {
      rows.push({ ...row, status: "missing" });
      continue;
    }

    locked[name] = pin;
    const server = createServer(name, entry, pin.version);
    // oxlint-disable-next-line no-await-in-loop
    const found = await planServer(workspace, server, targets, options);
    actions.push(...found.actions);
    clashes.push(...found.clashes);
    const result: ServerRow = { ...row, status: found.status };

    if (found.issues.length > 0) {
      result.issues = found.issues;
    }

    rows.push(result);
  }

  const cleanup = await planCleanup(workspace, acting);
  const untracked = await findUntracked(workspace, acting);
  // A limited cleanup must retain ownership while another harness still holds the server.
  const excluded = AllAdapters.filter((adapter) => !acting.includes(adapter));
  const remaining = await Promise.all(excluded.map((adapter) => adapter.mcp.list(workspace.scope)));

  for (const server of remaining.flat()) {
    const previous = workspace.lock.mcp[server.name];

    if (previous !== undefined && locked[server.name] === undefined) {
      locked[server.name] = previous;
    }
  }

  return {
    actions: [...cleanup, ...actions],
    clashes,
    hasTargets,
    isLockStale: !isSameLock(workspace.lock.mcp, locked),
    locked,
    rows: [...rows, ...untracked],
  };
}

/** The adapters this run may change: all of them, or the ones `--agent` names. */
function getActingAdapters(workspace: Workspace) {
  const limit = workspace.flags.agents;

  return limit ? AllAdapters.filter((adapter) => limit.includes(adapter.id)) : AllAdapters;
}

function getTargets(workspace: Workspace, entry: McpEntry) {
  return selectAdapters({
    entry: entry.agents,
    flag: workspace.flags.agents,
    manifest: workspace.manifest.agents,
  });
}

/** The harnesses that should hold the entry when no `--agent` flag limits the run. */
function getDeclaredTargets(workspace: Workspace, entry: McpEntry) {
  return selectAdapters({
    entry: entry.agents,
    flag: undefined,
    manifest: workspace.manifest.agents,
  });
}

/** Decides the lock record of an entry: its hash and, for a package, the pinned version. */
async function lockEntry(
  workspace: Workspace,
  name: string,
  entry: McpEntry,
  options: PlanOptions
): Promise<LockedServer | "unpinned"> {
  const hash = hashEntry(entry);
  const packageName = getPackageName(entry);

  if (packageName === undefined || !("package" in entry)) {
    return { hash };
  }

  const previous = workspace.lock.mcp[name];
  const isUpdated = options.update === "all" || options.update.includes(name);

  const canKeep =
    !isUpdated &&
    previous?.version !== undefined &&
    previous.package === entry.package &&
    isVersionInRange(previous.version, entry.version);

  if (canKeep) {
    return { hash, package: entry.package, version: previous.version };
  }

  if (!options.resolve) {
    return "unpinned";
  }

  if (workspace.flags.frozen) {
    throw new OperationError(
      `The lock has no usable version for mcp.${name}. A frozen run does not resolve versions.`
    );
  }

  const version = await resolveVersion(packageName, entry.version);

  return { hash, package: entry.package, version };
}

async function planServer(
  workspace: Workspace,
  server: McpServer,
  targets: Adapter[],
  options: PlanOptions
) {
  const isManaged = server.name in workspace.lock.mcp;
  const actions: Action[] = [];
  const clashes: string[] = [];
  const statuses: Status[] = [];
  const issues: NonNullable<ServerRow["issues"]> = [];

  for (const adapter of targets) {
    let rendered;

    try {
      rendered = adapter.mcp.render(server);
    } catch (error) {
      if (!options.reportUnsupported || !(error instanceof OperationError)) {
        throw error;
      }

      issues.push({ harness: adapter.id, message: error.message });
      continue;
    }

    // Harness files are few and local; reading them in order keeps the plan deterministic.
    // oxlint-disable-next-line no-await-in-loop
    const existing = await adapter.mcp.find(workspace.scope, server.name);

    const reason = getReason(existing?.config, rendered, options.force);
    const isClash = existing !== undefined && !isManaged && !options.force;

    if (isClash) {
      clashes.push(`${adapter.id}: ${server.name}`);
    } else if (reason !== undefined) {
      actions.push({ adapter, kind: "add", reason, server });
    }

    statuses.push(reason === "forced" || reason === undefined ? "ok" : reason);
  }

  return {
    actions,
    clashes,
    issues,
    status: issues.length > 0 ? ("unsupported" as const) : summarize(statuses),
  };
}

function getReason(
  existing: HarnessConfig,
  rendered: HarnessConfig,
  force: boolean
): "missing" | "modified" | "forced" | undefined {
  if (existing === undefined) {
    return "missing";
  }

  if (force) {
    return "forced";
  }

  return isSameValue(existing, rendered) ? undefined : "modified";
}

type HarnessConfig = Parameters<typeof isSameValue>[0];

/** One status for a server that several harnesses hold: the most urgent one. */
function summarize(statuses: Status[]): Status {
  if (statuses.includes("missing")) {
    return "missing";
  }

  return statuses.includes("modified") ? "modified" : "ok";
}

/**
 * Finds managed servers in harnesses that should no longer hold them: the entry left the manifest,
 * or the harness is no longer a target. It asks every adapter, because the lock holds no harness
 * data.
 */
async function planCleanup(workspace: Workspace, acting: Adapter[]): Promise<Action[]> {
  const actions: Action[] = [];

  for (const adapter of acting) {
    // oxlint-disable-next-line no-await-in-loop
    const servers = await adapter.mcp.list(workspace.scope);

    for (const server of servers) {
      const isManaged = server.name in workspace.lock.mcp;
      const declared = workspace.manifest.mcp[server.name];

      const isTarget =
        declared !== undefined &&
        (getDeclaredTargets(workspace, declared.entry).includes(adapter) ||
          getTargets(workspace, declared.entry).includes(adapter));

      if (isManaged && !isTarget) {
        actions.push({ adapter, kind: "remove", name: server.name });
      }
    }
  }

  return actions;
}

/** Servers in harness files that agentsrc neither manages nor declares. */
async function findUntracked(workspace: Workspace, acting: Adapter[]): Promise<ServerRow[]> {
  const harnesses = new Map<string, HarnessId[]>();

  for (const adapter of acting) {
    // oxlint-disable-next-line no-await-in-loop
    const servers = await adapter.mcp.list(workspace.scope);

    for (const server of servers) {
      const isKnown = server.name in workspace.lock.mcp || server.name in workspace.manifest.mcp;

      if (!isKnown) {
        harnesses.set(server.name, [...(harnesses.get(server.name) ?? []), adapter.id]);
      }
    }
  }

  return [...harnesses].map(([name, ids]) => ({
    declaredIn: undefined,
    harnesses: ids,
    name,
    source: "",
    status: "untracked",
  }));
}

function describeEntry(entry: McpEntry) {
  if ("package" in entry) {
    return entry.version ? `${entry.package}@${entry.version}` : entry.package;
  }

  return "url" in entry ? entry.url : [entry.command, ...(entry.args ?? [])].join(" ");
}

function isSameLock(current: Record<string, LockedServer>, next: Record<string, LockedServer>) {
  const names = Object.keys(next);

  return (
    names.length === Object.keys(current).length &&
    names.every((name) => {
      const before = current[name];
      const after = next[name];

      return (
        before?.hash === after?.hash &&
        before?.package === after?.package &&
        before?.version === after?.version
      );
    })
  );
}

/** A line of the plan, for `--dry-run` and for a frozen failure. */
export function describeAction(action: Action) {
  return action.kind === "add"
    ? `${action.adapter.id}: write ${action.server.name} (${action.reason})`
    : `${action.adapter.id}: remove ${action.name}`;
}
