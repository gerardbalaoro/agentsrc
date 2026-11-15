import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { OperationError } from "#errors.ts";
import type { Adapter } from "#harness/registry.ts";
import { collectSkillFiles, isInside } from "#lock/hash.ts";
import type { SkillFile } from "#lock/hash.ts";
import { hashLockedFiles, removeLockedSkill, setLockedSkill } from "#lock/skills-lock.ts";
import type { LockedSkill, LockedSkillFields, SkillsLock } from "#lock/skills-lock.ts";
import { skillsDir } from "#scope.ts";
import type { Scope } from "#scope.ts";
import { discoverSkills, filterSkills, renameSkillFiles } from "#skills/discover.ts";
import type { DiscoveredSkill } from "#skills/discover.ts";
import type { FetchedSource, SourceCache } from "#skills/fetch.ts";
import { getCanonicalDir } from "#skills/plan.ts";
import type { DeclaredSkill, SkillAction, SkillPlan } from "#skills/plan.ts";
import { getLockSource, getLockSourceType, getLockSourceUrl } from "#skills/source.ts";
import { Ui } from "#ui.ts";

/** An install or a restore whose content has been fetched, but not yet written. */
export interface PreparedSkill {
  action: Extract<SkillAction, { kind: "install" | "restore" }>;
  files: SkillFile[];
  /** The lock entry that the install records. */
  fields: LockedSkillFields;
}

/** The lock entry that an install or a restore is checked against, if any. */
export function getPinnedEntry(prepared: PreparedSkill): LockedSkill | undefined {
  const { action } = prepared;

  return action.kind === "restore" ? action.locked : action.previous;
}

/**
 * Fetches every source that an install or a restore needs, finds each skill in it, and reads the
 * files that the install will write. Nothing is written to the scope.
 */
export async function prepareSkills(
  scope: Scope,
  lock: SkillsLock,
  actions: SkillAction[],
  cache: SourceCache
) {
  const pending = actions.flatMap((action) =>
    action.kind === "install" || action.kind === "restore" ? [action] : []
  );

  return await Promise.all(pending.map((action) => prepareSkill(scope, lock, action, cache)));
}

/**
 * Writes the canonical copies, makes them available to each harness, removes what is no longer
 * declared, and records the changes in `lock`.
 */
export async function applySkills(
  scope: Scope,
  plan: SkillPlan,
  prepared: PreparedSkill[],
  options: { now: Date; isUnchanged: (prepared: PreparedSkill) => boolean }
) {
  const removed = plan.actions.flatMap((action) => (action.kind === "remove" ? [action] : []));
  await Promise.all(removed.map((action) => removeSkill(scope, plan.lock, action)));

  const changed = prepared.filter((item) => !options.isUnchanged(item));
  await Promise.all(
    changed.map((item) => writeCanonical(scope, item.action.skill.name, item.files))
  );

  // Entries are recorded in plan order: the global lock keeps the order in which they were added.
  for (const item of prepared) {
    const { skill } = item.action;

    if (changed.includes(item)) {
      setLockedSkill(plan.lock, skill.name, item.fields, options.now);
      Ui.info(describeInstall(item));
    } else {
      Ui.info(`${skill.name} is up to date.`);
    }
  }

  const declared = new Map(
    plan.actions.flatMap((action) =>
      action.kind === "remove" ? [] : [[action.skill.name, action.skill] as const]
    )
  );

  await Promise.all(
    [...plan.links].map(async ([name, adapters]) => {
      const skill = declared.get(name);

      if (skill !== undefined) {
        await linkSkill(scope, skill, adapters, plan.force);
      }
    })
  );

  await Promise.all(
    [...plan.unlinks].map(async ([name, adapters]) => {
      await Promise.all(adapters.map((adapter) => adapter.skills.remove(scope, name)));
      Ui.info(`Removed ${name} from ${adapters.map((adapter) => adapter.id).join(", ")}.`);
    })
  );
}

/** Removes a managed skill from every harness, the canonical directory and the skills lock. */
async function removeSkill(
  scope: Scope,
  lock: SkillsLock,
  action: Extract<SkillAction, { kind: "remove" }>
) {
  const { name, holders } = action;
  const canonical = getCanonicalDir(scope, name);
  await Promise.all(holders.map((adapter) => adapter.skills.remove(scope, name)));
  await rm(canonical, { force: true, recursive: true });
  removeLockedSkill(lock, name);
  Ui.info(`Removed ${name}.`);
}

async function linkSkill(scope: Scope, skill: DeclaredSkill, adapters: Adapter[], force: boolean) {
  const canonical = {
    copy: skill.entry.copy === true,
    force,
    dir: getCanonicalDir(scope, skill.name),
    name: skill.name,
  };

  await Promise.all(adapters.map((adapter) => adapter.skills.add(scope, canonical)));
}

/**
 * Replaces the canonical copy with `files`. The files were read into memory first, so a local
 * source that is itself the canonical directory is safe.
 */
async function writeCanonical(scope: Scope, name: string, files: SkillFile[]) {
  const base = path.resolve(skillsDir(scope));
  const target = path.resolve(getCanonicalDir(scope, name));

  if (target === base || !isInside(base, target)) {
    throw new OperationError(`The skill name ${name} resolves outside ${base}.`);
  }

  const destinations = files.map((file) => {
    const destination = path.resolve(target, file.path);

    if (!isInside(target, destination)) {
      throw new OperationError(
        `The file ${file.path} of ${name} resolves outside the skill directory.`
      );
    }

    return { destination, file };
  });

  await rm(target, { force: true, recursive: true });
  await mkdir(target, { recursive: true });

  await Promise.all(
    destinations.map(async ({ destination, file }) => {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
      // As skills.sh does, the mode is set after the write, so the umask does not change it.
      await chmod(destination, file.mode);
    })
  );
}

async function prepareSkill(
  scope: Scope,
  lock: SkillsLock,
  action: PreparedSkill["action"],
  cache: SourceCache
): Promise<PreparedSkill> {
  const { skill } = action;

  const ref = action.kind === "restore" ? action.locked.ref : skill.source.ref;

  const fetched = await cache.fetch(skill.source, ref);
  const lockedPath = action.kind === "restore" ? action.locked.skillPath : undefined;
  const found = await findSkill(fetched, skill, lockedPath);
  const isRenamed = skill.sourceName !== skill.name;
  const sourceFiles = await collectSkillFiles(found.dir);
  const files = isRenamed ? renameSkillFiles(sourceFiles, skill.name) : sourceFiles;
  // The local lock hashes a renamed skill as installed; the global lock hashes it as its source has it.
  const hashedFiles = lock.kind === "global" ? sourceFiles : files;
  const sourceType = getLockSourceType(skill.source);

  const fields: LockedSkillFields = {
    hash: hashLockedFiles(lock.kind, sourceType, hashedFiles),
    installMode: skill.entry.copy === true ? "copy" : undefined,
    pluginName: lock.kind === "global" ? found.pluginName : undefined,
    ref: skill.source.ref,
    skillName: isRenamed ? found.name : undefined,
    skillPath: sourceType === "local" ? undefined : getSkillPath(fetched.root, found.dir),
    source: getLockSource(skill.source),
    sourceType,
    sourceUrl: getLockSourceUrl(skill.source, lock.kind),
  };

  return { action, fields, files };
}

/** Finds the skill in a fetched source. A restore looks first where the lock says it was. */
async function findSkill(
  fetched: FetchedSource,
  skill: DeclaredSkill,
  lockedPath: string | undefined
) {
  const requested = [skill.sourceName];
  const lockedDir = lockedPath === undefined ? undefined : path.posix.dirname(lockedPath);

  const atLockedPath =
    lockedDir === undefined || lockedDir === "."
      ? []
      : await discoverSkills(fetched.root, { requested, subpath: lockedDir }).catch(
          (): DiscoveredSkill[] => []
        );

  const [pinned] = filterSkills(atLockedPath, requested);

  if (pinned !== undefined) {
    return pinned;
  }

  const found = await discoverSkills(fetched.root, { requested, subpath: skill.source.subpath });
  const [match] = filterSkills(found, requested);

  if (match !== undefined) {
    return match;
  }

  const names = found.map((item) => item.name).join(", ") || "none";

  throw new OperationError(
    `${skill.entry.source} has no skill named ${skill.sourceName}, which the manifest declares as ${skill.name}. Skills found: ${names}.`
  );
}

/** The skill's `SKILL.md` relative to the source root, with `/` separators. */
function getSkillPath(root: string, dir: string) {
  const folder = path.relative(root, dir).split(path.sep).join("/");

  return folder === "" ? "SKILL.md" : `${folder}/SKILL.md`;
}

function describeInstall(prepared: PreparedSkill) {
  const { action } = prepared;
  const { name, entry } = action.skill;

  if (action.kind === "restore") {
    return `Restored ${name} (it was ${action.state}).`;
  }

  return action.reason === "update"
    ? `Updated ${name} from ${entry.source}.`
    : `Installed ${name} from ${entry.source}.`;
}
