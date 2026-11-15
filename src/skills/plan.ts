import { existsSync } from "node:fs";
import path from "node:path";

import { OperationError } from "#errors.ts";
import { AllAdapters, selectAdapters } from "#harness/registry.ts";
import type { Adapter } from "#harness/registry.ts";
import { isOwnedSkill } from "#harness/skill-dirs.ts";
import { UniversalSkills } from "#harness/universal.ts";
import {
  collectSkillFiles,
  computeLegacySkillFolderHash,
  computeSkillFolderHash,
} from "#lock/hash.ts";
import { hashLockedFiles, readSkillsLock } from "#lock/skills-lock.ts";
import type { LockedSkill, SkillsLock } from "#lock/skills-lock.ts";
import type { ManifestLocation } from "#manifest/load.ts";
import type { SkillEntry } from "#manifest/schema.ts";
import { skillsDir } from "#scope.ts";
import type { Scope } from "#scope.ts";
import {
  assertSkillName,
  normalizeSkillName,
  renameSkillFiles,
  sanitizeName,
} from "#skills/discover.ts";
import { getLockSource, getLockSourceType, parseSource, sanitizeSubpath } from "#skills/source.ts";
import type { ParsedSource } from "#skills/source.ts";
import { Ui } from "#ui.ts";
import type { Workspace } from "#workspace.ts";

/** A skill that the resolved manifest declares. */
export interface DeclaredSkill {
  /** The installed name: the manifest key. */
  name: string;
  entry: SkillEntry;
  declaredIn: ManifestLocation;
  /** The source with the entry's `ref` and `path` applied. */
  source: ParsedSource;
  /** The skill's name in the source. It differs from `name` when the key renames the skill. */
  sourceName: string;
  /** The harnesses to install into in this run. */
  targets: Adapter[];
  /** The harnesses that the manifest selects, before `--agent` limits the run. */
  declaredTargets: Adapter[];
}

/** How the installed copy of a skill compares with its lock entry. */
export type InstalledState = "ok" | "modified" | "missing";

export type InstallReason = "new" | "changed" | "forced" | "update";

export type SkillAction =
  /** Installed and unchanged. Harnesses that lack it get it. */
  | { kind: "keep"; skill: DeclaredSkill; locked: LockedSkill }
  /** Fetched at the entry's `ref` and installed. */
  | {
      kind: "install";
      skill: DeclaredSkill;
      reason: InstallReason;
      previous: LockedSkill | undefined;
      state: InstalledState;
    }
  /** Fetched again as the lock pins it, because the installed copy is missing or was edited. */
  | { kind: "restore"; skill: DeclaredSkill; locked: LockedSkill; state: "missing" | "modified" }
  /** Managed, but no longer declared. */
  | { kind: "remove"; name: string; holders: Adapter[] };

export interface SkillPlan {
  actions: SkillAction[];
  force: boolean;
  /** Per skill: harnesses to make the skill available in. */
  links: Map<string, Adapter[]>;
  /** Per skill: harnesses that are no longer targets but still have the managed skill. */
  unlinks: Map<string, Adapter[]>;
  lock: SkillsLock;
  /** Why a frozen run must fail. Empty when the manifest and the locks agree. */
  problems: string[];
  /** True when at least one skill has no harness to install into. */
  hasNoHarness: boolean;
  /** Skills whose `agents` leave out a universal harness that still sees them. */
  universalLeaks: { name: string; harnesses: string[] }[];
}

/** The skills the resolved manifest declares, with their sources parsed and their harnesses chosen. */
export function declareSkills(workspace: Workspace): DeclaredSkill[] {
  const { flags, manifest } = workspace;

  return Object.entries(manifest.skills)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, declared]) => {
      assertSkillName(name, "The skill name");
      const { entry } = declared;

      return {
        declaredIn: declared.declaredIn,
        declaredTargets: selectAdapters({
          entry: entry.agents,
          flag: undefined,
          manifest: manifest.agents,
        }),
        entry,
        name,
        source: resolveEntrySource(entry, workspace.scope),
        sourceName:
          entry.skill ??
          parseSource(entry.source, { cwd: workspace.scope.root }).skillFilter ??
          name,
        targets: selectAdapters({
          entry: entry.agents,
          flag: flags.agents,
          manifest: manifest.agents,
        }),
      };
    });
}

/**
 * Compares the declared skills with the locks and the disk. `refresh` names the skills whose `ref`
 * is resolved again, as `update` does.
 */
export async function planSkills(
  workspace: Workspace,
  declared: DeclaredSkill[],
  options: { force: boolean; refresh: Set<string> }
): Promise<SkillPlan> {
  const { scope } = workspace;
  const lock = await loadSkillsLock(scope);
  const managed = new Set(workspace.lock.skills);

  for (const name of managed) {
    assertSkillName(name, "The managed skill name");
  }

  for (const skill of declared) {
    const hasCanonical = existsSync(getCanonicalDir(scope, skill.name));

    // oxlint-disable-next-line no-await-in-loop
    const holders = await Promise.all(
      skill.targets.map((adapter) => adapter.skills.find(scope, skill.name))
    );

    if (
      !options.force &&
      !managed.has(skill.name) &&
      (lock.skills[skill.name] !== undefined ||
        hasCanonical ||
        holders.some((holder) => holder !== undefined))
    ) {
      throw new OperationError(
        `${skill.name} is an untracked skill. Use --force to take it over, or rename it.`
      );
    }
  }

  const declaredNames = new Set(declared.map((skill) => skill.name));
  const problems = getLockProblems(workspace, lock, declared);

  const states = await Promise.all(
    declared.map((skill) => getInstalledState(scope, lock, skill.name, lock.skills[skill.name]))
  );

  const actions: SkillAction[] = declared.map((skill, index) => {
    const locked = lock.skills[skill.name];
    const state = states[index] ?? "missing";
    const action = chooseAction(skill, locked, state, options);

    if (action.kind === "restore" && action.state === "modified") {
      problems.push(`${skill.name} was modified: its files do not match ${lock.file}.`);
    }

    return action;
  });

  const removed = [...managed].filter((name) => !declaredNames.has(name)).toSorted();
  problems.push(...removed.map((name) => `${name} is in agents.lock but not in the manifest.`));

  for (const name of removed) {
    // oxlint-disable-next-line no-await-in-loop
    const holders = await ownedHolders(scope, name, AllAdapters);
    actions.push({ kind: "remove", name, holders });
  }

  const links = await planLinks(scope, lock, actions, options.force);

  const unlinks = await planUnlinks(
    workspace,
    declared.filter((skill) => managed.has(skill.name))
  );

  problems.push(
    ...actions.flatMap((action) =>
      action.kind === "keep"
        ? []
        : [`${action.kind === "remove" ? action.name : action.skill.name} needs ${action.kind}.`]
    ),
    ...[...links.keys()].map((name) => `${name} needs a harness copy or link.`),
    ...[...unlinks.keys()].map((name) => `${name} must be removed from a dropped harness.`)
  );

  return {
    actions,
    force: options.force,
    hasNoHarness: declared.some((skill) => skill.targets.length === 0),
    links,
    lock,
    problems,
    universalLeaks: findUniversalLeaks(workspace, declared),
    unlinks,
  };
}

/** How the installed copy of `name` compares with its lock entry. */
export async function getInstalledState(
  scope: Scope,
  lock: SkillsLock,
  name: string,
  locked: LockedSkill | undefined
): Promise<InstalledState> {
  return await getDirectoryState(getCanonicalDir(scope, name), lock, name, locked);
}

async function getDirectoryState(
  dir: string,
  lock: SkillsLock,
  name: string,
  locked: LockedSkill | undefined
): Promise<InstalledState> {
  if (!existsSync(path.join(dir, "SKILL.md"))) {
    return "missing";
  }

  // An entry without a hash cannot be checked, so its files are not trusted.
  if (locked === undefined || locked.hash === "") {
    return "modified";
  }

  try {
    const files = await collectSkillFiles(dir);
    // The global lock hashes a renamed skill with its source name, so the rename is undone first.
    const isRenamedGlobal = lock.kind === "global" && locked.skillName !== undefined;
    const hashed = isRenamedGlobal ? renameSkillFiles(files, locked.skillName ?? name) : files;

    return hashLockedFiles(lock.kind, locked.sourceType, hashed) === locked.hash
      ? "ok"
      : "modified";
  } catch {
    return "modified";
  }
}

/** Content status across the canonical directory and the selected harnesses. */
export async function getSkillState(scope: Scope, lock: SkillsLock, skill: DeclaredSkill) {
  const locked = lock.skills[skill.name];
  const canonical = await getInstalledState(scope, lock, skill.name, locked);

  const states = await Promise.all(
    skill.targets.map(async (adapter) => {
      const found = await adapter.skills.find(scope, skill.name);

      return found === undefined
        ? "missing"
        : await getDirectoryState(found.dir, lock, skill.name, locked);
    })
  );

  if (canonical === "missing" || states.includes("missing")) {
    return "missing";
  }

  return canonical === "modified" || states.includes("modified") ? "modified" : "ok";
}

/** The canonical copy of a skill: `.agents/skills/<name>`. */
export function getCanonicalDir(scope: Scope, name: string) {
  assertSkillName(name, "The skill name");

  return path.join(skillsDir(scope), name);
}

/**
 * Reads the skills lock. A version 1 local lock is migrated without network access, as skills.sh
 * does: an installed skill that still matches its version 1 hash gets a new hash, any other entry
 * an empty one.
 */
export async function loadSkillsLock(scope: Scope) {
  const lock = await readSkillsLock(scope);

  if (lock.kind !== "project" || lock.version !== 1) {
    return lock;
  }

  const migrated = await Promise.all(
    Object.entries(lock.skills).map(async ([name, entry]) => {
      const dir = path.join(skillsDir(scope), sanitizeName(name));
      const hash = await migrateHash(dir, entry.hash);

      return [name, { ...entry, hash }] as const;
    })
  );

  return { ...lock, skills: Object.fromEntries(migrated) };
}

/** The lock fields that the manifest decides, which a lock entry must match to be current. */
export function isLockCurrent(skill: DeclaredSkill, locked: LockedSkill) {
  const isRenamed = skill.sourceName !== skill.name;

  const isSameName = isRenamed
    ? locked.skillName !== undefined &&
      normalizeSkillName(locked.skillName) === normalizeSkillName(skill.sourceName)
    : locked.skillName === undefined;

  const subpath = skill.source.subpath?.replaceAll("\\", "/").replace(/\/+$/u, "");
  const folder = path.posix.dirname(locked.skillPath ?? "SKILL.md");
  const isInPath = subpath === undefined || folder === subpath || folder.startsWith(`${subpath}/`);

  return (
    locked.source === getLockSource(skill.source) &&
    locked.sourceType === getLockSourceType(skill.source) &&
    locked.ref === skill.source.ref &&
    locked.installMode === (skill.entry.copy === true ? "copy" : undefined) &&
    isSameName &&
    isInPath
  );
}

function chooseAction(
  skill: DeclaredSkill,
  locked: LockedSkill | undefined,
  state: InstalledState,
  options: { force: boolean; refresh: Set<string> }
): SkillAction {
  if (locked === undefined) {
    return { kind: "install", previous: undefined, reason: "new", skill, state };
  }

  if (!isLockCurrent(skill, locked)) {
    return { kind: "install", previous: locked, reason: "changed", skill, state };
  }

  if (options.refresh.has(skill.name)) {
    return { kind: "install", previous: locked, reason: "update", skill, state };
  }

  if (options.force) {
    return { kind: "install", previous: locked, reason: "forced", skill, state };
  }

  if (state !== "ok") {
    return { kind: "restore", locked, skill, state };
  }

  return { kind: "keep", locked, skill };
}

/** Problems that a frozen run reports before it looks at any installed file. */
function getLockProblems(workspace: Workspace, lock: SkillsLock, declared: DeclaredSkill[]) {
  if (declared.length === 0 && workspace.lock.skills.length === 0) {
    return [];
  }

  const managed = new Set(workspace.lock.skills);

  const missingLocks = [
    ...(workspace.hasLock ? [] : ["agents.lock is missing."]),
    ...(lock.exists ? [] : [`${lock.file} is missing.`]),
  ];

  return [
    ...missingLocks,
    ...declared.flatMap((skill) => {
      const locked = lock.skills[skill.name];

      if (locked === undefined) {
        return [`${skill.name} is not in ${lock.file}.`];
      }

      if (!isLockCurrent(skill, locked)) {
        return [`${skill.name} in the manifest does not match its entry in ${lock.file}.`];
      }

      return managed.has(skill.name) ? [] : [`${skill.name} is not in agents.lock.`];
    }),
  ];
}

async function planLinks(scope: Scope, lock: SkillsLock, actions: SkillAction[], force: boolean) {
  const pairs = await Promise.all(
    actions.map(async (action) => {
      if (action.kind === "remove") {
        return [];
      }

      const found = await Promise.all(
        action.skill.targets.map(async (adapter) => {
          const existing = await adapter.skills.find(scope, action.skill.name);

          if (existing === undefined) {
            return "missing";
          }

          if (
            !force &&
            !(await isOwnedSkill(existing.dir, getCanonicalDir(scope, action.skill.name)))
          ) {
            throw new OperationError(
              `Cannot replace unmanaged skill ${existing.dir}. Use --force to take it over.`
            );
          }

          if (action.kind !== "keep") {
            return "modified";
          }

          return await getDirectoryState(existing.dir, lock, action.skill.name, action.locked);
        })
      );

      const missing = action.skill.targets.filter(
        (_, index) => action.kind !== "keep" || found[index] !== "ok"
      );

      return missing.length > 0 ? [[action.skill.name, missing] as const] : [];
    })
  );

  return new Map(pairs.flat());
}

/**
 * Harnesses that hold a managed skill but are no longer its targets. Every adapter is asked, not
 * only the targets. `--agent` limits the run, so only the harnesses it names are changed.
 */
async function planUnlinks(workspace: Workspace, managed: DeclaredSkill[]) {
  const flag = workspace.flags.agents;

  const candidates = AllAdapters.filter(
    (adapter) =>
      adapter.skills !== UniversalSkills && (flag === undefined || flag.includes(adapter.id))
  );

  const pairs = await Promise.all(
    managed.map(async (skill) => {
      const dropped = candidates.filter(
        (adapter) => !skill.declaredTargets.includes(adapter) && !skill.targets.includes(adapter)
      );

      const holders = await ownedHolders(workspace.scope, skill.name, dropped);

      return holders.length > 0 ? [[skill.name, holders] as const] : [];
    })
  );

  return new Map(pairs.flat());
}

async function ownedHolders(scope: Scope, name: string, adapters: Adapter[]) {
  const owned = await Promise.all(
    adapters.map(async (adapter) => {
      const found = await adapter.skills.find(scope, name);

      if (found === undefined) {
        return false;
      }

      if (await isOwnedSkill(found.dir, getCanonicalDir(scope, name))) {
        return true;
      }

      Ui.warn(`Leaving unmanaged skill ${found.dir} in place.`);

      return false;
    })
  );

  return adapters.filter((_, index) => owned[index]);
}

/** A universal harness reads `.agents/skills`, so a skill's `agents` cannot hide the skill from it. */
function findUniversalLeaks(workspace: Workspace, declared: DeclaredSkill[]) {
  const manifestTargets = selectAdapters({
    entry: undefined,
    flag: workspace.flags.agents,
    manifest: workspace.manifest.agents,
  });

  const universal = manifestTargets.filter((adapter) => adapter.skills === UniversalSkills);

  return declared.flatMap((skill) => {
    const { agents } = skill.entry;

    if (agents === undefined) {
      return [];
    }

    const harnesses = universal
      .filter((adapter) => !agents.includes(adapter.id))
      .map((adapter) => adapter.id);

    return harnesses.length > 0 ? [{ harnesses, name: skill.name }] : [];
  });
}

function resolveEntrySource(entry: SkillEntry, scope: Scope): ParsedSource {
  const parsed = parseSource(entry.source, { cwd: scope.root });
  const ref = entry.ref ?? parsed.ref;
  const subpath = entry.path === undefined ? parsed.subpath : sanitizeSubpath(entry.path);

  // A local source records its own directory, so a path inside it becomes part of the source.
  if (parsed.type === "local") {
    const url = subpath === undefined ? parsed.url : path.join(parsed.url, subpath);

    return { type: "local", url };
  }

  // A skill named in the source string is the entry's `sourceName`, not part of the source.
  const resolved: ParsedSource = { type: parsed.type, url: parsed.url };

  if (ref !== undefined) {
    resolved.ref = ref;
  }

  if (subpath !== undefined) {
    resolved.subpath = subpath;
  }

  return resolved;
}

async function migrateHash(dir: string, legacyHash: string) {
  if (legacyHash === "" || !existsSync(path.join(dir, "SKILL.md"))) {
    return "";
  }

  try {
    const isUnchanged = (await computeLegacySkillFolderHash(dir)) === legacyHash;

    return isUnchanged ? await computeSkillFolderHash(dir) : "";
  } catch {
    return "";
  }
}
