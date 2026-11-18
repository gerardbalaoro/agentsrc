import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";

import { OperationError } from "#errors.ts";
import { AllAdapters } from "#harness/registry.ts";
import { requireEntry, readInventory, describeEntry } from "#interactive/inventory.ts";
import type { Inventory, InventoryItem } from "#interactive/inventory.ts";
import { readAgentsLock, createAgentsLock } from "#lock/agents-lock.ts";
import { collectSkillFiles } from "#lock/hash.ts";
import { readSkillsLock, writeSkillsLock } from "#lock/skills-lock.ts";
import { commitManifestChange, prepareManifestEntries } from "#manifest/edit.ts";
import { resolveLayers } from "#manifest/extends.ts";
import type { ManifestLocation } from "#manifest/load.ts";
import { parseManifest } from "#manifest/load.ts";
import { mergeLayers } from "#manifest/merge.ts";
import type { McpEntry, SkillEntry } from "#manifest/schema.ts";
import { applyActions } from "#mcp/apply.ts";
import { planServers } from "#mcp/plan.ts";
import { agentsLockPath, skillsDir, skillsLockPath } from "#scope.ts";
import { applySkills, getPinnedEntry, prepareSkills } from "#skills/apply.ts";
import { assertSkillName } from "#skills/discover.ts";
import { createSourceCache } from "#skills/fetch.ts";
import type { SourceCache } from "#skills/fetch.ts";
import { declareSkills, planSkills } from "#skills/plan.ts";
import { parseSource } from "#skills/source.ts";
import { Ui } from "#ui.ts";
import type { UiMessage } from "#ui.ts";
import { readText } from "#util/read-text.ts";
import { removeTomlValue, setTomlValue } from "#util/toml-edit.ts";
import { saveLock } from "#workspace.ts";
import type { Workspace } from "#workspace.ts";

export type BatchAction = "update" | "repair" | "remove" | "import" | "add" | "sync";

export interface BatchEntry {
  item: InventoryItem;
  lines: string[];
  problem?: string;
  apply?: (workspace: Workspace) => Promise<void>;
}

export interface Batch {
  action: BatchAction;
  inventory: Inventory;
  entries: BatchEntry[];
  problems: string[];
  warnings: string[];
  fingerprint: string;
  applied: boolean;
}

export interface BatchResult {
  id: string;
  name: string;
  status: "success" | "failed";
  message: string;
}

/** Fetches and resolves the entire selection before exposing an apply action. */
export async function prepareBatch(
  inventory: Inventory,
  action: BatchAction,
  items: InventoryItem[]
): Promise<Batch> {
  const warnings = [
    ...inventory.warnings,
    ...(inventory.workspace.remoteChanges ?? []).map(
      (url) => `Accept changed remote manifest pin: ${url}`
    ),
  ];

  const entries: BatchEntry[] = [];
  await assertInventoryCurrent(inventory, action, items);
  const cache = createSourceCache();
  const fingerprint = await workspaceFingerprint(inventory.workspace, items);
  const seen = new Set<string>();

  try {
    await Ui.capture(
      (message) => warnings.push(message.text),
      async () => {
        for (const item of items) {
          const entry: BatchEntry = { item, lines: [] };
          entries.push(entry);

          try {
            const name = `${item.kind}:${item.name}`;

            if (seen.has(name)) {
              throw new OperationError(`${item.name}: choose one origin for this name.`);
            }

            seen.add(name);
            const operation = entryAction(action, item);
            validateAction(item, operation);

            if (action === "add" || action === "import") {
              warnLiteralValues(item);
            }

            // Plans share the fetch cache, but each entry owns its files and result.
            // oxlint-disable-next-line no-await-in-loop
            const prepared = await prepareEntry(inventory.workspace, operation, item, cache);
            entry.lines = prepared.lines;
            entry.apply = prepared.apply;
          } catch (error) {
            entry.problem = errorMessage(error);
          }
        }
      }
    );
  } finally {
    await cache.dispose();
  }

  return {
    action,
    inventory,
    entries,
    warnings,
    fingerprint,
    applied: false,
    problems:
      items.length === 0
        ? ["Select at least one entry."]
        : entries.flatMap((entry) =>
            entry.problem ? [`${entry.item.name}: ${entry.problem}`] : []
          ),
  };
}

/** Applies the approved buffers/plans; failures remain distinct and are never silently skipped. */
export async function applyBatch(batch: Batch, progress?: (message: UiMessage) => void) {
  const output = (message: UiMessage) => progress?.(message);

  if (batch.applied) {
    throw new OperationError("This batch has already been applied. Prepare a new preview.");
  }

  if (batch.problems.length > 0) {
    throw new OperationError(batch.problems.join("\n"));
  }

  const { workspace } = batch.inventory;

  if (
    (await workspaceFingerprint(
      workspace,
      batch.entries.map((entry) => entry.item)
    )) !== batch.fingerprint
  ) {
    throw new OperationError(
      "Configuration or installed content changed after this preview. Refresh and prepare the batch again."
    );
  }

  batch.applied = true;
  const results: BatchResult[] = [];
  await Ui.capture(output, async () => {
    for (const entry of batch.entries) {
      output({ kind: "info", text: `${batch.action}: ${entry.item.name}` });

      try {
        // Each operation reloads the current lock so earlier successes cannot be overwritten.
        // oxlint-disable-next-line no-await-in-loop
        const lock = await readAgentsLock(workspace.scope);
        // oxlint-disable-next-line no-await-in-loop
        await entry.apply?.({
          ...workspace,
          lock: lock ?? createAgentsLock(),
          hasLock: lock !== undefined,
        });
        results.push({
          id: entry.item.id,
          name: entry.item.name,
          status: "success",
          message: "Completed",
        });
      } catch (error) {
        results.push({
          id: entry.item.id,
          name: entry.item.name,
          status: "failed",
          message: errorMessage(error),
        });
      }
    }
  });

  return results;
}

function entryAction(action: BatchAction, item: InventoryItem): BatchAction {
  if (action !== "sync") {
    return action;
  }

  return item.declared ? "repair" : "remove";
}

function warnLiteralValues(item: InventoryItem) {
  const { entry } = item;

  if (!entry) {
    return;
  }

  const values: Record<string, string> = {};

  if ("env" in entry) {
    Object.assign(values, entry.env);
  }

  if ("headers" in entry) {
    Object.assign(values, entry.headers);
  }

  const names = Object.entries(values).flatMap(([name, value]) =>
    value.includes("${") ? [] : [name]
  );

  if (names.length) {
    Ui.warn(
      `${item.name}: literal values for ${names.join(", ")} will be stored in the manifest. Prefer environment references for secrets.`
    );
  }
}

function validateAction(item: InventoryItem, action: BatchAction) {
  if (item.kind === "skills") {
    assertSkillName(item.name, "The skill name");
  }

  if (action === "import") {
    if (item.managed) {
      throw new OperationError("Already managed. Use repair or update.");
    }

    requireEntry(item);

    return;
  }

  if (action === "add") {
    requireEntry(item);

    return;
  }

  if (!item.managed && !item.declared) {
    throw new OperationError("Unmanaged entry: import it before changing its files.");
  }

  if (action !== "remove" && !item.declared) {
    throw new OperationError("No longer declared. Remove it, or add its source again.");
  }
}

function selectedWorkspace(workspace: Workspace, action: BatchAction, item: InventoryItem) {
  const removing = action === "remove";
  const takingOver = action === "import";
  const adding = takingOver || action === "add";
  const own: ManifestLocation = { kind: "file", path: workspace.manifestFile };
  const definition = workspace.manifest[item.kind][item.name];

  if (action === "add" && definition) {
    throw new OperationError("The manifest already declares this name.");
  }

  if (takingOver && definition && !item.declared) {
    throw new OperationError(
      "The manifest already declares this name. Choose a different origin or name."
    );
  }

  const entry = definition?.entry ?? (adding ? requireEntry(item) : undefined);
  const pin = workspace.lock.mcp[item.name];

  const selected: Workspace = {
    ...workspace,
    manifest: { ...workspace.manifest, skills: {}, mcp: {} },
    lock: {
      ...workspace.lock,
      skills:
        item.kind === "skills" && workspace.lock.skills.includes(item.name) ? [item.name] : [],
      mcp: item.kind === "mcp" && pin ? { [item.name]: pin } : {},
    },
  };

  if (!removing && entry) {
    setDefinition(selected, item, entry, definition?.declaredIn ?? own);
  }

  return { selected, entry };
}

function setDefinition(
  selected: Workspace,
  item: InventoryItem,
  entry: SkillEntry | McpEntry,
  declaredIn: ManifestLocation
) {
  if (item.kind === "skills" && "source" in entry) {
    const parsed = parseSource(entry.source, { cwd: path.dirname(selected.manifestFile) });
    selected.manifest.skills[item.name] = {
      declaredIn,
      entry: { ...entry, source: parsed.type === "local" ? parsed.url : entry.source },
    };

    return;
  }

  if (item.kind === "mcp" && !("source" in entry)) {
    selected.manifest.mcp[item.name] = { declaredIn, entry };

    return;
  }

  throw new OperationError("The entry has an invalid definition.");
}

async function assertInventoryCurrent(
  inventory: Inventory,
  action: BatchAction,
  items: InventoryItem[]
) {
  const before = inventory.workspace;
  const fresh = await readInventory(before.flags.global, before.scope.root);

  if (
    JSON.stringify(fresh.workspace.manifest) !== JSON.stringify(before.manifest) ||
    JSON.stringify(fresh.workspace.lock) !== JSON.stringify(before.lock) ||
    fresh.workspace.scope.root !== before.scope.root
  ) {
    throw new OperationError(
      "Configuration changed since inventory was loaded. Refresh before preparing a batch."
    );
  }

  if (action === "add") {
    return;
  }

  for (const item of items) {
    const current = fresh.items.find((candidate) => candidate.id === item.id);

    if (
      !current ||
      JSON.stringify(current.entry) !== JSON.stringify(item.entry) ||
      current.managed !== item.managed
    ) {
      throw new OperationError(
        `${item.name} changed since inventory was loaded. Refresh before preparing a batch.`
      );
    }
  }
}

async function prepareEntry(
  workspace: Workspace,
  action: BatchAction,
  item: InventoryItem,
  cache: SourceCache
) {
  const { selected, entry } = selectedWorkspace(workspace, action, item);
  const edit = await prepareEdit(workspace, action, item, entry);

  if (item.kind === "skills") {
    return await prepareSkillOperation(selected, action, item, cache, edit);
  }

  return await prepareServerOperation(selected, action, item, edit);
}

type PreparedEdit = Awaited<ReturnType<typeof prepareEdit>>;

async function prepareSkillOperation(
  workspace: Workspace,
  action: BatchAction,
  item: InventoryItem,
  cache: SourceCache,
  edit: PreparedEdit
) {
  const selected = workspace;
  const takingOver = action === "import";
  const removing = action === "remove";
  const lines = [...edit.lines, ...describeEntry(item)];

  const plan = await planSkills(selected, declareSkills(selected), {
    force: takingOver,
    refresh: action === "update" ? new Set([item.name]) : new Set(),
  });

  const prepared = await prepareSkills(workspace.scope, plan.lock, plan.actions, cache);

  for (const step of plan.actions) {
    if (step.kind === "keep") {
      continue;
    }

    lines.push(`${step.kind}: ${path.join(skillsDir(workspace.scope), item.name)}`);

    if (step.kind === "remove") {
      for (const adapter of step.holders) {
        lines.push(`remove: ${path.join(adapter.skills.directory(workspace.scope), item.name)}`);
      }
    }
  }

  for (const [name, adapters] of plan.links) {
    for (const adapter of adapters) {
      lines.push(`write: ${path.join(adapter.skills.directory(workspace.scope), name)}`);
    }
  }

  for (const [name, adapters] of plan.unlinks) {
    for (const adapter of adapters) {
      lines.push(`remove: ${path.join(adapter.skills.directory(workspace.scope), name)}`);
    }
  }

  for (const preparedSkill of prepared) {
    const pinned = getPinnedEntry(preparedSkill);

    if (pinned?.hash) {
      lines.push(`previous hash: ${pinned.hash}`);
    }

    lines.push(`resolved hash: ${preparedSkill.fields.hash}`);

    if (
      preparedSkill.action.kind === "restore" &&
      pinned?.hash &&
      pinned.hash !== preparedSkill.fields.hash
    ) {
      lines.push(
        "Warning: the source no longer matches the locked content. Its new content will be installed and locked."
      );
    }
  }

  if (plan.hasNoHarness) {
    lines.push("No harness selected; the canonical skill is still installed.");
  }

  lines.push(
    ...plan.universalLeaks.map(
      (leak) => `${leak.harnesses.join(", ")} also reads the shared skills directory.`
    ),
    `ownership: ${agentsLockPath(workspace.scope)}`
  );

  return {
    lines: lines.length ? lines : ["Already in sync."],
    async apply(current: Workspace) {
      await edit.commit(async () => {
        const latest = await readSkillsLock(current.scope);
        plan.lock = latest;
        let failure: unknown;

        try {
          await applySkills(current.scope, plan, prepared, {
            now: new Date(),
            isUnchanged: () => false,
          });
        } catch (error) {
          failure = error;
        }

        // Canonical content can be installed before a harness write fails. Preserve its ownership.
        await writeSkillsLock(plan.lock);

        const owns = removing
          ? failure !== undefined && current.lock.skills.includes(item.name)
          : plan.lock.skills[item.name] !== undefined;

        const names = new Set(current.lock.skills);

        if (owns) {
          names.add(item.name);
        } else {
          names.delete(item.name);
        }

        await saveLock(current, { ...current.lock, skills: [...names] });

        if (failure !== undefined) {
          throw failure;
        }
      });
    },
  };
}

async function prepareServerOperation(
  workspace: Workspace,
  action: BatchAction,
  item: InventoryItem,
  edit: PreparedEdit
) {
  const selected = workspace;
  const takingOver = action === "import";
  const removing = action === "remove";
  const lines = [...edit.lines, ...describeEntry(item)];

  const plan = await planServers(selected, {
    force: takingOver,
    resolve: true,
    update: action === "update" ? [item.name] : "none",
  });

  if (plan.clashes.length) {
    throw new OperationError(
      `Unmanaged name conflict: ${plan.clashes.join(", ")}. Use import to take ownership.`
    );
  }

  if (!removing && !plan.hasTargets) {
    throw new OperationError("Choose at least one target harness before installing an MCP server.");
  }

  const writing = new Set(
    plan.actions.flatMap((step) => (step.kind === "add" ? [step.adapter] : []))
  );

  await Promise.all([...writing].map((adapter) => adapter.mcp.prepare?.(workspace.scope)));

  for (const step of plan.actions) {
    lines.push(
      `${step.kind === "add" ? "write" : "remove"}: ${step.adapter.mcp.location(workspace.scope)} → ${item.name}`
    );
  }

  const nextPin = plan.locked[item.name];

  if (nextPin?.version) {
    lines.push(`resolved version: ${nextPin.version}`);
  }

  return {
    lines: lines.length ? lines : ["Already in sync."],
    async apply(current: Workspace) {
      await edit.commit(async () => {
        const locked = { ...current.lock.mcp };

        for (const step of plan.actions) {
          // Harness changes may share a file; ownership is persisted after each successful write.
          // oxlint-disable-next-line no-await-in-loop
          await applyActions(current.scope, [step]);

          if (step.kind === "add" && nextPin) {
            locked[item.name] = nextPin;
            // oxlint-disable-next-line no-await-in-loop
            await saveLock(current, { ...current.lock, mcp: locked });
          }
        }

        if (nextPin) {
          locked[item.name] = nextPin;
        } else {
          Reflect.deleteProperty(locked, item.name);
        }

        await saveLock(current, { ...current.lock, mcp: locked });
      });
    },
  };
}

async function prepareEdit(
  workspace: Workspace,
  action: BatchAction,
  item: InventoryItem,
  entry: SkillEntry | McpEntry | undefined
) {
  const adding = (action === "import" || action === "add") && !item.declared;
  const removing = action === "remove";

  if (!adding && !removing) {
    return {
      lines: new Array<string>(),
      commit: async (apply: () => Promise<void>) => {
        await apply();
      },
    };
  }

  const layers = await resolveLayers(workspace.manifestFile, workspace.remoteHashes, "lock");
  const inherited = mergeLayers(layers.layers.slice(0, -1));

  const render = async () => {
    if (adding && entry) {
      return await prepareManifestEntries(
        workspace.manifestFile,
        item.kind,
        [{ name: item.name, entry }],
        { force: true }
      );
    }

    const original = await readText(workspace.manifestFile);

    const text = inherited[item.kind][item.name]
      ? setTomlValue(original ?? "", [item.kind, item.name], false, {
          sectionDepth: item.kind === "skills" ? 1 : 2,
        })
      : removeTomlValue(original ?? "", [item.kind, item.name]);

    parseManifest(text, { kind: "file", path: workspace.manifestFile });

    return { file: workspace.manifestFile, original, text };
  };

  await render();

  return {
    lines: [
      `${removing ? "remove declaration / override" : "add declaration and take ownership"}: ${workspace.manifestFile} → ${item.kind}.${item.name}`,
    ],
    async commit(apply: () => Promise<void>) {
      await commitManifestChange(await render(), apply);
    },
  };
}

/** Includes raw layer/lock bytes, harness entries, link ownership and installed content. */
async function workspaceFingerprint(workspace: Workspace, items: InventoryItem[]) {
  const hash = createHash("sha256");
  const layers = await resolveLayers(workspace.manifestFile, workspace.remoteHashes, "lock");

  const rawLayers = await Promise.all(
    layers.layers.map(async (layer) => {
      const raw = layer.location.kind === "file" ? await readText(layer.location.path) : "";

      return JSON.stringify(layer) + (raw ?? "missing");
    })
  );

  for (const raw of rawLayers) {
    hash.update(raw);
  }

  const locks = await Promise.all(
    [agentsLockPath(workspace.scope), skillsLockPath(workspace.scope)].map((file) => readText(file))
  );

  for (const raw of locks) {
    hash.update(raw ?? "missing");
  }

  for (const adapter of AllAdapters) {
    // oxlint-disable-next-line no-await-in-loop
    hash.update(JSON.stringify(await adapter.mcp.list(workspace.scope)));
  }

  const dirs = new Set<string>();

  for (const item of items.filter((entry) => entry.kind === "skills")) {
    assertSkillName(item.name, "The skill name");
    dirs.add(path.join(skillsDir(workspace.scope), item.name));

    for (const adapter of AllAdapters) {
      dirs.add(path.join(adapter.skills.directory(workspace.scope), item.name));
    }
  }

  const signatures = await Promise.all([...dirs].map((dir) => directoryFingerprint(dir)));

  for (const signature of signatures) {
    hash.update(signature);
  }

  return hash.digest("hex");
}

async function directoryFingerprint(dir: string) {
  const hash = createHash("sha256").update(dir);

  const stats = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });

  if (!stats) {
    return hash.update("missing").digest("hex");
  }

  if (stats.isSymbolicLink()) {
    hash.update(await readlink(dir));
  }

  hash.update((await readText(path.join(dir, "metadata.json"))) ?? "");

  try {
    const files = await collectSkillFiles(dir);

    for (const file of files.toSorted((a, b) => a.path.localeCompare(b.path))) {
      hash.update(file.path).update(String(file.mode)).update(file.content);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }

    hash.update("dangling");
  }

  return hash.digest("hex");
}

// Filesystem, registry, and UI boundaries may reject with any JavaScript value.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
