import path from "node:path";

import { OperationError, UsageError } from "#errors.ts";
import { listSkillDirs } from "#harness/skill-dirs.ts";
import { writeSkillsLock } from "#lock/skills-lock.ts";
import {
  commitManifestChange,
  prepareManifestEntries,
  disableManifestEntry,
  removeManifestEntry,
} from "#manifest/edit.ts";
import type { ManifestChange } from "#manifest/edit.ts";
import { describeLocation } from "#manifest/load.ts";
import type { SkillEntry } from "#manifest/schema.ts";
import { skillsDir } from "#scope.ts";
import { applySkills, getPinnedEntry, prepareSkills } from "#skills/apply.ts";
import type { PreparedSkill } from "#skills/apply.ts";
import { assertSkillName, discoverSkills, filterSkills, sanitizeName } from "#skills/discover.ts";
import type { DiscoveredSkill } from "#skills/discover.ts";
import { createSourceCache } from "#skills/fetch.ts";
import type { SourceCache } from "#skills/fetch.ts";
import { declareSkills, getSkillState, loadSkillsLock, planSkills } from "#skills/plan.ts";
import type { SkillAction, SkillPlan } from "#skills/plan.ts";
import { parseSource, toManifestSource } from "#skills/source.ts";
import type { ParsedSource } from "#skills/source.ts";
import { Ui } from "#ui.ts";
import { getValue, isTable } from "#util/config-value.ts";
import type { ConfigTable } from "#util/config-value.ts";
import { readText } from "#util/read-text.ts";
import { parseToml } from "#util/toml-edit.ts";
import { reloadWorkspace, saveLock } from "#workspace.ts";
import type { Workspace } from "#workspace.ts";

/** One row of `skills list`. */
export interface SkillRow {
  name: string;
  /** The declared source, or the locked one for an untracked skill. Unset when nothing records it. */
  source: string | undefined;
  status: "ok" | "modified" | "missing" | "untracked";
  /** The manifest that declared the skill, for an entry that comes from `extends`. */
  declaredIn: string | undefined;
}

/**
 * Makes the installed skills match the resolved manifest: installs what is missing or changed,
 * restores what was edited, and removes managed skills that are no longer declared.
 */
export async function installSkills(workspace: Workspace, options: { force: boolean }) {
  await runInstall(workspace, { force: options.force, refresh: new Set() });
}

/** Adds the skills of `source` to the manifest, one entry per skill, then installs. */
export async function addSkills(
  workspace: Workspace,
  source: string,
  options: {
    skills: string[] | undefined;
    rename: string | undefined;
    copy: boolean;
    list: boolean;
    force: boolean;
  }
) {
  if (options.rename !== undefined) {
    assertSkillName(options.rename, "--rename");
  }

  const parsed = parseSource(source, { cwd: process.cwd() });
  const cache = createSourceCache();

  try {
    const fetched = await cache.fetch(parsed, parsed.ref);

    const requested =
      options.skills ?? (parsed.skillFilter === undefined ? undefined : [parsed.skillFilter]);

    const found = await discoverSkills(fetched.root, { requested, subpath: parsed.subpath });

    if (found.length === 0) {
      throw new OperationError(`No skills found in ${source}.`);
    }

    if (options.list) {
      for (const skill of found) {
        Ui.print(`${skill.name}  ${skill.description}`);
      }

      return;
    }

    const selected = await selectSkills(found, requested);

    if (options.rename !== undefined && selected.length !== 1) {
      throw new UsageError(
        `--rename needs exactly one skill, but ${selected.length} are selected.`
      );
    }

    const entries = selected.map((skill) => {
      const name = options.rename ?? sanitizeName(skill.name);

      const entry = createEntry(workspace, parsed, {
        copy: options.copy,
        skill: options.rename === undefined ? undefined : skill.name,
      });

      return { entry, name };
    });

    const change = await prepareManifestEntries(workspace.manifestFile, "skills", entries, options);
    const updated = withDeclaredEntries(workspace, entries);
    await runInstall(updated, { cache, force: options.force, refresh: new Set(), change });
  } finally {
    await cache.dispose();
  }
}

/** Resolves `ref` again for the named skills, or for every managed skill, and installs what changed. */
export async function updateSkills(workspace: Workspace, names: string[]) {
  const declared = new Set(Object.keys(workspace.manifest.skills));
  const unknown = names.filter((name) => !declared.has(name));

  if (unknown.length > 0) {
    throw new UsageError(`The manifest declares no skill named ${unknown.join(", ")}.`);
  }

  const targets =
    names.length > 0 ? names : workspace.lock.skills.filter((name) => declared.has(name));

  await runInstall(workspace, { force: false, refresh: new Set(targets) });
}

/** Prints each skill with its source and status. */
export async function listSkills(workspace: Workspace, options: { json: boolean }) {
  const rows = await getSkillRows(workspace);

  if (options.json) {
    Ui.json(rows.map(toJsonRow));

    return;
  }

  if (rows.length === 0) {
    Ui.info("No skills.");

    return;
  }

  const width = Math.max(...rows.map((row) => row.name.length));
  const statusWidth = Math.max(...rows.map((row) => row.status.length));

  for (const row of rows) {
    const from = row.declaredIn === undefined ? "" : `  (from ${row.declaredIn})`;
    Ui.print(
      `${row.name.padEnd(width)}  ${row.status.padEnd(statusWidth)}  ${row.source ?? "-"}${from}`
    );
  }
}

/**
 * Deletes each skill from the scope's manifest, or writes `name = false` for an inherited one,
 * then installs, which removes the files and the lock entries.
 */
export async function removeSkills(workspace: Workspace, names: string[]) {
  if (names.length === 0) {
    throw new UsageError("Name at least one skill to remove.");
  }

  const ownNames = await Promise.all(names.map((name) => hasOwnEntry(workspace, name)));

  const unknown = names.filter(
    (name, index) => !ownNames[index] && workspace.manifest.skills[name] === undefined
  );

  if (unknown.length > 0) {
    throw new UsageError(`The manifest declares no skill named ${unknown.join(", ")}.`);
  }

  if (workspace.flags.dryRun) {
    Ui.info(names.map((name) => `Would remove ${name} from ${workspace.manifestFile}.`).join("\n"));

    const skills = Object.fromEntries(
      Object.entries(workspace.manifest.skills).filter(([name]) => !names.includes(name))
    );

    await runInstall(
      { ...workspace, manifest: { ...workspace.manifest, skills } },
      { force: false, refresh: new Set() }
    );

    return;
  }

  for (const name of names) {
    // Each edit reads and replaces the same manifest, so writes must run in order.
    // oxlint-disable-next-line no-await-in-loop
    await removeManifestEntry(workspace.manifestFile, "skills", name);
  }

  const reloaded = await reload(workspace);
  // An entry that an extended manifest also declares is still there, so it is disabled.
  const inherited = names.filter((name) => reloaded.manifest.skills[name] !== undefined);

  for (const name of inherited) {
    // oxlint-disable-next-line no-await-in-loop
    await disableManifestEntry(workspace.manifestFile, "skills", name);
  }

  const updated = inherited.length > 0 ? await reload(workspace) : reloaded;
  await runInstall(updated, { force: false, refresh: new Set() });
}

interface InstallOptions {
  force: boolean;
  /** Skills whose `ref` is resolved again. */
  refresh: Set<string>;
  /** Sources that this command has already fetched. */
  cache?: SourceCache;
  change?: ManifestChange;
}

async function runInstall(workspace: Workspace, options: InstallOptions) {
  const { flags } = workspace;
  const declared = declareSkills(workspace);
  const plan = await planSkills(workspace, declared, options);
  warnAboutHarnesses(plan);

  if (flags.frozen && plan.problems.length > 0) {
    throw frozenError(plan.problems);
  }

  if (flags.dryRun) {
    printPlan(plan);

    return;
  }

  if (flags.frozen) {
    return;
  }

  const cache = options.cache ?? createSourceCache();

  try {
    const prepared = await prepareSkills(workspace.scope, plan.lock, plan.actions, cache);
    warnChangedSources(prepared);
    const isUnchanged = (item: PreparedSkill) => isUpToDate(item);

    const apply = async () => {
      await applySkills(workspace.scope, plan, prepared, { isUnchanged, now: new Date() });
      const names = declared.map((skill) => skill.name);

      if (plan.lock.exists || Object.keys(plan.lock.skills).length > 0) {
        await writeSkillsLock(plan.lock);
      }

      if (workspace.hasLock || names.length > 0) {
        await saveLock(workspace, { ...workspace.lock, skills: names });
      }
    };

    await (options.change === undefined ? apply() : commitManifestChange(options.change, apply));
  } finally {
    if (options.cache === undefined) {
      await cache.dispose();
    }
  }
}

/** Warns when a mutable source can no longer restore its locked content. */
function warnChangedSources(prepared: PreparedSkill[]) {
  const changed = prepared.flatMap((item) => {
    const pinned = getPinnedEntry(item);
    const isChecked = pinned !== undefined && pinned.hash !== "";

    return isChecked && pinned.hash !== item.fields.hash ? [item] : [];
  });

  for (const item of changed) {
    if (item.action.kind === "restore") {
      Ui.warn(
        `${item.action.skill.name} no longer matches its lock entry at the source. The new content is installed and locked.`
      );
    }
  }
}

/** An update that found nothing new, for a skill that is installed as locked, writes nothing. */
function isUpToDate(item: PreparedSkill) {
  const { action } = item;

  if (action.kind !== "install" || action.reason !== "update" || action.state !== "ok") {
    return false;
  }

  const { previous } = action;

  return previous !== undefined && previous.hash === item.fields.hash;
}

function warnAboutHarnesses(plan: SkillPlan) {
  if (plan.hasNoHarness) {
    Ui.warn(
      "No harness was detected or selected, so skills are installed into .agents/skills only. Set `agents` in the manifest."
    );
  }

  for (const leak of plan.universalLeaks) {
    Ui.warn(
      `${leak.name} sets \`agents\`, but ${leak.harnesses.join(" and ")} ${leak.harnesses.length === 1 ? "reads" : "read"} .agents/skills, so ${leak.harnesses.length === 1 ? "it sees" : "they see"} ${leak.name} anyway.`
    );
  }
}

function frozenError(problems: string[]) {
  return new OperationError(
    [
      "The skills do not match the locks, and --frozen-lockfile allows no change:",
      ...problems.map((problem) => `  ${problem}`),
    ].join("\n")
  );
}

function printPlan(plan: SkillPlan) {
  const lines = [
    ...plan.actions.flatMap((action) => describePlannedAction(action)),
    ...[...plan.links].map(
      ([name, adapters]) =>
        `Would add ${name} to ${adapters.map((adapter) => adapter.id).join(", ")}.`
    ),
    ...[...plan.unlinks].map(
      ([name, adapters]) =>
        `Would remove ${name} from ${adapters.map((adapter) => adapter.id).join(", ")}.`
    ),
  ];

  Ui.info(lines.length > 0 ? lines.join("\n") : "Skills are up to date.");
}

const ReasonText = {
  changed: "the manifest entry changed",
  forced: "--force",
  new: "new",
  update: "update",
} as const;

function describePlannedAction(action: SkillAction) {
  switch (action.kind) {
    case "install": {
      return [
        `Would install ${action.skill.name} from ${action.skill.entry.source} (${ReasonText[action.reason]}).`,
      ];
    }

    case "restore": {
      return [`Would restore ${action.skill.name} (it is ${action.state}).`];
    }

    case "remove": {
      return [`Would remove ${action.name}.`];
    }

    default: {
      return [];
    }
  }
}

async function selectSkills(found: DiscoveredSkill[], requested: string[] | undefined) {
  if (requested?.includes("*")) {
    return found;
  }

  if (requested !== undefined) {
    const missing = requested.filter((name) => filterSkills(found, [name]).length === 0);

    if (missing.length > 0) {
      throw new UsageError(
        `The source has no skill named ${missing.join(", ")}. It has: ${listNames(found)}.`
      );
    }

    return filterSkills(found, requested);
  }

  const [only] = found;

  if (found.length === 1 && only !== undefined) {
    return [only];
  }

  if (!Ui.isInteractive()) {
    throw new UsageError(
      `The source has several skills. Choose with --skill, or use '*' for all: ${listNames(found)}.`
    );
  }

  const chosen = await Ui.select(
    "Which skills do you want to add?",
    found.map((skill) => skill.name)
  );

  return filterSkills(found, chosen);
}

function listNames(skills: DiscoveredSkill[]) {
  return skills.map((skill) => skill.name).join(", ");
}

function createEntry(
  workspace: Workspace,
  parsed: ParsedSource,
  options: { copy: boolean; skill: string | undefined }
): SkillEntry {
  const manifestDir = path.dirname(workspace.manifestFile);

  return withoutUndefined({
    source: toManifestSource(parsed, manifestDir),
    ref: parsed.ref,
    path: parsed.subpath,
    skill: options.skill,
    copy: options.copy ? true : undefined,
    agents: workspace.flags.agents,
  });
}

function withoutUndefined(entry: SkillEntry): SkillEntry {
  const present = Object.entries(entry).filter(([, value]) => value !== undefined);

  return { source: entry.source, ...Object.fromEntries(present) };
}

/** Overlays own entries using the same local-source anchoring as manifest loading. */
function withDeclaredEntries(workspace: Workspace, entries: { name: string; entry: SkillEntry }[]) {
  const declaredIn = { kind: "file", path: workspace.manifestFile } as const;
  const manifestDir = path.dirname(workspace.manifestFile);

  const added = entries.map(({ name, entry }) => {
    const parsed = parseSource(entry.source, { cwd: manifestDir });
    const source = parsed.type === "local" ? parsed.url : entry.source;

    return [name, { declaredIn, entry: { ...entry, source } }] as const;
  });

  return {
    ...workspace,
    manifest: {
      ...workspace.manifest,
      skills: { ...workspace.manifest.skills, ...Object.fromEntries(added) },
    },
  };
}

async function reload(workspace: Workspace) {
  return await reloadWorkspace(workspace);
}

async function hasOwnEntry(workspace: Workspace, name: string) {
  const text = await readText(workspace.manifestFile);

  if (text === undefined) {
    return false;
  }

  const skills = getValue(parseToml(text, workspace.manifestFile), ["skills"]);

  return isTable(skills) && skills[name] !== undefined;
}

async function getSkillRows(workspace: Workspace): Promise<SkillRow[]> {
  const { scope } = workspace;
  const lock = await loadSkillsLock(scope);
  const managed = new Set(workspace.lock.skills);
  const declared = declareSkills(workspace);
  const declaredNames = new Set(declared.map((skill) => skill.name));

  const declaredRows = await Promise.all(
    declared.map(async (item): Promise<SkillRow> => {
      const { name } = item;
      const location = describeLocation(item.declaredIn);

      const isOwn =
        item.declaredIn.kind === "file" && item.declaredIn.path === workspace.manifestFile;

      return {
        declaredIn: isOwn ? undefined : location,
        name,
        source: describeSource(item.entry),
        status: await getSkillState(scope, lock, item),
      };
    })
  );

  const onDisk = await listSkillDirs(skillsDir(scope));

  const untrackedNames = new Set([
    ...Object.keys(lock.skills),
    ...onDisk.map((skill) => skill.name),
  ]);

  const untrackedRows = [...untrackedNames].flatMap((name): SkillRow[] => {
    if (declaredNames.has(name) || managed.has(name)) {
      return [];
    }

    return [
      { declaredIn: undefined, name, source: lock.skills[name]?.source, status: "untracked" },
    ];
  });

  return [...declaredRows, ...untrackedRows].toSorted((left, right) =>
    left.name.localeCompare(right.name)
  );
}

function describeSource(entry: SkillEntry) {
  return entry.ref === undefined ? entry.source : `${entry.source}#${entry.ref}`;
}

function toJsonRow(row: SkillRow): ConfigTable {
  const optional = Object.entries({ declaredIn: row.declaredIn, source: row.source }).filter(
    ([, value]) => value !== undefined
  );

  return { name: row.name, status: row.status, ...Object.fromEntries(optional) };
}
