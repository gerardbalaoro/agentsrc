import { OperationError, UsageError } from "#errors.ts";
import {
  commitManifestChange,
  prepareManifestEntries,
  disableManifestEntry,
  removeManifestEntry,
} from "#manifest/edit.ts";
import type { ManifestChange } from "#manifest/edit.ts";
import { applyActions } from "#mcp/apply.ts";
import { parseEnvValue, hasReference } from "#mcp/env.ts";
import { describeAction, planServers } from "#mcp/plan.ts";
import type { Plan, PlanOptions } from "#mcp/plan.ts";
import type { NamedEntry } from "#mcp/spec.ts";
import { Ui } from "#ui.ts";
import { reloadWorkspace, saveLock } from "#workspace.ts";
import type { Workspace } from "#workspace.ts";

/** Makes every harness config match the manifest. */
export async function installServers(workspace: Workspace, options: { force: boolean }) {
  await install(workspace, { force: options.force, resolve: true, update: "none" });
}

/** Adds a server to the scope's own manifest, then installs it. */
export async function addServer(
  workspace: Workspace,
  { name, entry }: NamedEntry,
  options: { force: boolean }
) {
  warnAboutSecrets(name, ("url" in entry ? entry.headers : entry.env) ?? {});

  const { agents } = workspace.flags;
  const recorded = agents ? { ...entry, agents } : entry;

  const change = await prepareManifestEntries(
    workspace.manifestFile,
    "mcp",
    [{ name, entry: recorded }],
    options
  );

  const candidate = {
    ...workspace,
    manifest: {
      ...workspace.manifest,
      mcp: {
        ...workspace.manifest.mcp,
        [name]: {
          declaredIn: { kind: "file", path: workspace.manifestFile } as const,
          entry: recorded,
        },
      },
    },
  };

  await install(candidate, { force: options.force, resolve: true, update: "none" }, change);
}

/** Moves package entries to the newest version their range allows. Never edits the manifest. */
export async function updateServers(workspace: Workspace, names: string[]) {
  const unknown = names.filter((name) => !(name in workspace.manifest.mcp));

  if (unknown.length > 0) {
    throw new UsageError(`No MCP server named ${unknown.join(", ")} in the manifest.`);
  }

  const update = names.length > 0 ? names : "all";
  await install(workspace, { force: false, resolve: true, update });
}

export async function listServers(workspace: Workspace, options: { json: boolean }) {
  const plan = await planServers(workspace, {
    force: false,
    resolve: false,
    update: "none",
    reportUnsupported: true,
  });

  if (options.json) {
    Ui.json(plan.rows.map((row) => ({ ...row, declaredIn: row.declaredIn ?? null })));

    return;
  }

  for (const row of plan.rows) {
    const harnesses = row.harnesses.join(", ");
    const origin = row.declaredIn === workspace.manifestFile ? "" : (row.declaredIn ?? "");

    const issues =
      row.issues?.map((issue) => `${issue.harness}: ${issue.message}`).join("; ") ?? "";

    Ui.print(
      [row.status.padEnd(9), row.name, row.source, harnesses, origin, issues].join("\t").trimEnd()
    );
  }
}

/** Removes servers from the manifest, then from the harness configs and the lock. */
export async function removeServers(workspace: Workspace, names: string[]) {
  const unknown = names.filter((name) => !(name in workspace.manifest.mcp));

  if (unknown.length > 0) {
    throw new UsageError(`No MCP server named ${unknown.join(", ")} in the manifest.`);
  }

  if (workspace.flags.dryRun) {
    Ui.info(`Would remove from ${workspace.manifestFile}: ${names.join(", ")}`);

    return;
  }

  for (const name of names) {
    // Each edit rewrites the manifest, so the edits must run in order.
    // oxlint-disable-next-line no-await-in-loop
    await removeFromManifest(workspace, name);
  }

  const reloaded = await reloadWorkspace(workspace);
  await install(reloaded, { force: false, resolve: true, update: "none" });
}

async function removeFromManifest(workspace: Workspace, name: string) {
  const isRemoved = await removeManifestEntry(workspace.manifestFile, "mcp", name);
  const reloaded = await reloadWorkspace(workspace);
  const isInherited = name in reloaded.manifest.mcp;

  // An extended manifest still declares it, so this manifest must turn it off.
  if (!isRemoved || isInherited) {
    await disableManifestEntry(workspace.manifestFile, "mcp", name);
  }
}

async function install(workspace: Workspace, options: PlanOptions, change?: ManifestChange) {
  const plan = await planServers(workspace, options);
  const hasDeclared = Object.keys(workspace.manifest.mcp).length > 0;

  if (hasDeclared && !plan.hasTargets) {
    Ui.warn(
      "No harness is set in `agents` and none was detected, so no MCP server was installed. Set `agents` in the manifest."
    );

    if (change !== undefined && !workspace.flags.dryRun && !workspace.flags.frozen) {
      await commitManifestChange(change, async () => {
        // No harness is selected; only the manifest is committed.
      });
    }

    return;
  }

  if (plan.clashes.length > 0) {
    throw new OperationError(
      `These MCP servers are already in a harness config and agentsrc did not install them:\n${plan.clashes.map((clash) => `  ${clash}`).join("\n")}\nRename one of them, or use --force to replace them.`
    );
  }

  const steps = plan.actions.map((action) => `  ${describeAction(action)}`);

  if (workspace.flags.frozen) {
    failIfOutOfDate(workspace, plan, steps);

    return;
  }

  if (workspace.flags.dryRun) {
    Ui.info(steps.length > 0 ? `MCP plan:\n${steps.join("\n")}` : "MCP servers are up to date.");

    return;
  }

  const writing = new Set(
    plan.actions.flatMap((action) => (action.kind === "add" ? [action.adapter] : []))
  );

  await Promise.all([...writing].map((adapter) => adapter.mcp.prepare?.(workspace.scope)));

  const apply = async () => {
    await applyActions(workspace.scope, plan.actions);
    await saveLock(workspace, { ...workspace.lock, mcp: plan.locked });
  };

  await (change === undefined ? apply() : commitManifestChange(change, apply));

  if (plan.actions.length === 0) {
    Ui.info("MCP servers are up to date.");
  }
}

/** A frozen run changes nothing. It fails when a normal run would change something. */
function failIfOutOfDate(workspace: Workspace, plan: Plan, steps: string[]) {
  const isManaging = Object.keys(plan.locked).length > 0 || plan.actions.length > 0;

  if (isManaging && !workspace.hasLock) {
    throw new OperationError("There is no agents.lock. A frozen run needs one.");
  }

  if (plan.isLockStale) {
    throw new OperationError("The manifest and agents.lock disagree about the MCP servers.");
  }

  if (steps.length > 0) {
    throw new OperationError(
      `The harness configs are out of date. A normal run would do this:\n${steps.join("\n")}`
    );
  }
}

/** A literal secret on the command line ends up in the manifest. Suggest a reference. */
function warnAboutSecrets(name: string, values: Record<string, string>) {
  const literal = Object.entries(values).flatMap(([key, value]) =>
    hasReference(parseEnvValue(value, key)) ? [] : [key]
  );

  if (literal.length > 0) {
    Ui.warn(
      `mcp.${name}: ${literal.join(", ")} is written to the manifest as given. For a secret, use a reference such as \${${literal[0]}}.`
    );
  }
}
