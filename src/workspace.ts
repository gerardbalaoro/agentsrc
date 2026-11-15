import { OperationError } from "#errors.ts";
import type { HarnessId } from "#harness/ids.ts";
import { createAgentsLock, readAgentsLock, writeAgentsLock } from "#lock/agents-lock.ts";
import type { AgentsLock } from "#lock/agents-lock.ts";
import { resolveLayers } from "#manifest/extends.ts";
import { mergeLayers } from "#manifest/merge.ts";
import type { ResolvedManifest } from "#manifest/merge.ts";
import { manifestPath, resolveScope } from "#scope.ts";
import type { Scope } from "#scope.ts";
import { Ui } from "#ui.ts";

/** The flags that every command accepts. */
export interface CommonFlags {
  global: boolean;
  /** `--agent`: limits the run to these harnesses. */
  agents: HarnessId[] | undefined;
  yes: boolean;
  dryRun: boolean;
  /** Fail, and write nothing, when the manifest and the locks disagree. */
  frozen: boolean;
}

/** Everything a command needs to know about the scope it runs in. */
export interface Workspace {
  scope: Scope;
  /** The scope's own manifest. `add` and `remove` write only to this file. */
  manifestFile: string;
  manifest: ResolvedManifest;
  /** The lock on disk, or an empty one when the scope has none. */
  lock: AgentsLock;
  /** False when the scope has no `agents.lock` yet. */
  hasLock: boolean;
  /** SHA-256 of every remote manifest that this run read, by URL. */
  remoteHashes: Record<string, string>;
  flags: CommonFlags;
}

/**
 * Reads the manifest, everything it extends, and the lock. A remote manifest whose content differs
 * from the lock needs the user's approval, because it can declare commands that harnesses run.
 */
export async function loadWorkspace(flags: CommonFlags, cwd = process.cwd()): Promise<Workspace> {
  const scope = resolveScope({ cwd, global: flags.global });
  const manifestFile = manifestPath(scope);
  const existing = await readAgentsLock(scope);
  const lock = existing ?? createAgentsLock();

  const lockedHashes = Object.fromEntries(
    Object.entries(lock.extends).map(([url, pin]) => [url, pin.sha256])
  );

  const current = await resolveLayers(manifestFile, lockedHashes, "network");
  const manifest = mergeLayers(current.layers);

  const remoteUrls = new Set([...Object.keys(lockedHashes), ...Object.keys(current.remoteHashes)]);

  const hasRemoteDrift = [...remoteUrls].some(
    (url) => lockedHashes[url] !== current.remoteHashes[url]
  );

  if (flags.frozen && hasRemoteDrift) {
    throw new OperationError(
      "A frozen run does not accept added, removed or changed remote manifest pins."
    );
  }

  const changed = Object.keys(lockedHashes).filter((url) => {
    const hash = current.remoteHashes[url];

    return hash !== undefined && hash !== lockedHashes[url];
  });

  if (changed.length > 0) {
    const locked = await resolveLockedManifest(manifestFile, lockedHashes);
    await approveRemoteChange(changed, describeChange(locked, manifest), flags);
  }

  return {
    flags,
    hasLock: existing !== undefined,
    lock,
    manifest,
    manifestFile,
    remoteHashes: current.remoteHashes,
    scope,
  };
}

/**
 * Writes the lock with this run's remote manifest hashes, and makes it the workspace's lock, so a
 * later step in the same command starts from it. On a dry run it writes nothing.
 */
export async function saveLock(workspace: Workspace, lock: AgentsLock) {
  if (workspace.flags.dryRun) {
    return;
  }

  const pins = Object.entries(workspace.remoteHashes).map(([url, sha256]) => [url, { sha256 }]);
  const saved = { ...lock, extends: Object.fromEntries(pins) };
  await writeAgentsLock(workspace.scope, saved);
  workspace.lock = saved;
  workspace.hasLock = true;
}

/** The manifest as the lock pins it, or `unavailable` when a pinned copy is no longer cached. */
async function resolveLockedManifest(manifestFile: string, lockedHashes: Record<string, string>) {
  try {
    const locked = await resolveLayers(manifestFile, lockedHashes, "lock");

    return mergeLayers(locked.layers);
  } catch {
    return "unavailable";
  }
}

async function approveRemoteChange(urls: string[], change: string[], flags: CommonFlags) {
  const summary = [
    "These extended manifests changed since they were locked:",
    ...urls.map((url) => `  ${url}`),
    ...change,
  ].join("\n");

  if (flags.frozen) {
    throw new OperationError(`${summary}\nA frozen run does not accept the change.`);
  }

  Ui.info(summary);

  if (flags.yes) {
    return;
  }

  if (!Ui.isInteractive()) {
    throw new OperationError("Run the command again with --yes to accept the change.");
  }

  const isAccepted = await Ui.confirm("Accept the change and update the lock?");

  if (!isAccepted) {
    throw new OperationError("The change was not accepted. Nothing was written.");
  }
}

function describeChange(locked: ResolvedManifest | "unavailable", current: ResolvedManifest) {
  if (locked === "unavailable") {
    return ["The locked copy is not in the cache, so the difference cannot be shown."];
  }

  const lines = [
    ...describeTable("skills", locked.skills, current.skills),
    ...describeTable("mcp", locked.mcp, current.mcp),
  ];

  return lines.length > 0 ? lines : ["No skill or MCP entry changed."];
}

function describeTable<Entry>(
  table: string,
  locked: Record<string, { entry: Entry }>,
  current: Record<string, { entry: Entry }>
) {
  const names = [...new Set([...Object.keys(locked), ...Object.keys(current)])].toSorted();

  return names.flatMap((name) => {
    const before = locked[name]?.entry;
    const after = current[name]?.entry;

    if (before === undefined) {
      return [`  + ${table}.${name}: ${JSON.stringify(after)}`];
    }

    if (after === undefined) {
      return [`  - ${table}.${name}`];
    }

    const isSame = JSON.stringify(before) === JSON.stringify(after);

    return isSame ? [] : [`  ~ ${table}.${name}: ${JSON.stringify(after)}`];
  });
}

/**
 * Reads the manifest again after a command edited it. The lock in memory is kept, and a changed
 * remote manifest is not asked about twice in one command.
 */
export async function reloadWorkspace(workspace: Workspace): Promise<Workspace> {
  const current = await resolveLayers(workspace.manifestFile, workspace.remoteHashes, "lock");

  return {
    ...workspace,
    manifest: mergeLayers(current.layers),
    remoteHashes: current.remoteHashes,
  };
}
