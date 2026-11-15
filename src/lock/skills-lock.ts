import path from "node:path";

import { z } from "zod";

import { OperationError } from "#errors.ts";
import { hashGitTree, hashSkillFiles } from "#lock/hash.ts";
import type { SkillFile } from "#lock/hash.ts";
import { skillsLockPath } from "#scope.ts";
import type { Scope } from "#scope.ts";
import { writeFileAtomic } from "#util/atomic-write.ts";
import type { ConfigTable, ConfigValue } from "#util/config-value.ts";
import { parseJson } from "#util/json-edit.ts";
import { readText } from "#util/read-text.ts";

/**
 * The skills.sh lock formats: local version 2 and global version 3. Field semantics follow
 * skills.sh; fields outside that contract are preserved without interpreting them.
 */

const LocalVersion = 2;
const LegacyLocalVersion = 1;
const GlobalVersion = 3;

/** One skill in a skills lock. */
export interface LockedSkill {
  /** `owner/repo`, a URL, or, for a local source, an absolute path. */
  source: string;
  sourceType: string;
  sourceUrl?: string;
  ref?: string;
  /** The skill's `SKILL.md` inside the source, such as `skills/pdf/SKILL.md`. */
  skillPath?: string;
  /** The skill's name in its source, when the lock key renames it. */
  skillName?: string;
  installMode?: "copy";
  /**
   * `computedHash` in the local lock, `skillFolderHash` in the global lock. Empty when there is
   * nothing to check the installed files against.
   */
  hash: string;
  /** Global lock only. */
  pluginName?: string;
  /** Global lock only. */
  installedAt?: string;
  /** Global lock only. */
  updatedAt?: string;
  /** Fields that agentsrc does not understand. They are written back unchanged. */
  extra: ConfigTable;
}

/** The fields of a lock entry that an install decides. */
export type LockedSkillFields = Omit<LockedSkill, "extra" | "installedAt" | "updatedAt">;

export interface SkillsLock {
  kind: Scope["kind"];
  file: string;
  /** False when the scope has no skills lock yet. */
  exists: boolean;
  /** The version that was read. A write always uses the current version. */
  version: number;
  skills: Record<string, LockedSkill>;
  /** Top-level fields that agentsrc does not understand. */
  extra: ConfigTable;
}

const LockFileSchema = z
  .object({
    skills: z.record(z.string(), z.record(z.string(), z.json())),
    version: z.number(),
  })
  .catchall(z.json());

const EntrySchema = z
  .object({
    installMode: z.string().optional(),
    ref: z.string().optional(),
    skillName: z.string().optional(),
    skillPath: z.string().optional(),
    source: z.string(),
    sourceType: z.string(),
    sourceUrl: z.string().optional(),
  })
  .catchall(z.json());

const LocalEntrySchema = EntrySchema.extend({ computedHash: z.string().default("") });

const GlobalEntrySchema = EntrySchema.extend({
  installedAt: z.string().optional(),
  pluginName: z.string().optional(),
  skillFolderHash: z.string().default(""),
  updatedAt: z.string().optional(),
});

const KnownLocalFields = new Set(Object.keys(LocalEntrySchema.shape));
const KnownGlobalFields = new Set(Object.keys(GlobalEntrySchema.shape));

/**
 * The hash that a lock entry records for a skill's installed files. The global lock takes a GitHub
 * skill's hash from the GitHub Trees API, which is the Git tree hash; every other entry uses the
 * skills.sh content hash.
 */
export function hashLockedFiles(lockKind: Scope["kind"], sourceType: string, files: SkillFile[]) {
  return lockKind === "global" && sourceType === "github"
    ? hashGitTree(files)
    : hashSkillFiles(files);
}

export function createSkillsLock(scope: Scope): SkillsLock {
  const { kind } = scope;

  return {
    exists: false,
    // skills.sh starts a new global lock with an empty `dismissed` table.
    extra: kind === "global" ? { dismissed: {} } : {},
    file: skillsLockPath(scope),
    kind,
    skills: {},
    version: kind === "global" ? GlobalVersion : LocalVersion,
  };
}

/** Reads the scope's skills lock, or returns an empty one when there is none. */
export async function readSkillsLock(scope: Scope): Promise<SkillsLock> {
  const empty = createSkillsLock(scope);
  const text = await readText(empty.file);

  if (text === undefined) {
    return empty;
  }

  return parseSkillsLock(text, empty);
}

/** Parses lock text. `base` gives the scope, the file and the result for an outdated lock. */
export function parseSkillsLock(text: string, base: SkillsLock): SkillsLock {
  const result = LockFileSchema.safeParse(parseJson(text, base.file));

  if (!result.success) {
    throw new OperationError(
      `${base.file} is not a valid skills lock: it needs a numeric "version" and a "skills" table.`
    );
  }

  const { skills, version, ...extra } = result.data;

  if (base.kind === "global" && version < GlobalVersion) {
    // skills.sh discards a global lock older than version 3 and starts a new one.
    return { ...base, exists: true };
  }

  const isKnownVersion =
    base.kind === "global"
      ? version === GlobalVersion
      : version === LocalVersion || version === LegacyLocalVersion;

  if (!isKnownVersion) {
    throw new OperationError(
      `${base.file} has lock version ${version}. This agentsrc reads version ${base.kind === "global" ? GlobalVersion : LocalVersion}.`
    );
  }

  const lockDir = path.dirname(base.file);

  const entries = Object.entries(skills).map(([name, value]) => {
    const entry = parseEntry(base.kind, value, `${base.file}: skills.${name}`);
    const isRelativeLocal = entry.sourceType === "local" && !path.isAbsolute(entry.source);

    return [
      name,
      isRelativeLocal ? { ...entry, source: path.resolve(lockDir, entry.source) } : entry,
    ] as const;
  });

  return { ...base, exists: true, extra, skills: Object.fromEntries(entries), version };
}

/**
 * Records a skill. Fields that agentsrc does not understand are kept from the previous entry. In
 * the global lock, `installedAt` is kept and `updatedAt` moves to `now` when the entry changed.
 */
export function setLockedSkill(
  lock: SkillsLock,
  name: string,
  fields: LockedSkillFields,
  now: Date
) {
  const previous = lock.skills[name];
  const entry: LockedSkill = { ...fields, extra: previous?.extra ?? {} };

  if (lock.kind === "global") {
    const isUnchanged = previous !== undefined && isSameFields(previous, fields);
    const timestamp = now.toISOString();
    entry.installedAt = previous?.installedAt ?? timestamp;
    entry.updatedAt = isUnchanged ? (previous.updatedAt ?? timestamp) : timestamp;
  }

  lock.skills = { ...lock.skills, [name]: entry };
}

export function removeLockedSkill(lock: SkillsLock, name: string) {
  lock.skills = Object.fromEntries(Object.entries(lock.skills).filter(([key]) => key !== name));
}

/** The lock as skills.sh writes it. */
export function serializeSkillsLock(lock: SkillsLock) {
  if (lock.kind === "global") {
    const skills = Object.fromEntries(
      Object.entries(lock.skills).map(([name, entry]) => [name, toGlobalEntry(entry)])
    );

    // skills.sh writes the global lock without a final newline.
    return JSON.stringify({ version: GlobalVersion, skills, ...lock.extra }, undefined, 2);
  }

  const lockDir = path.dirname(lock.file);

  const skills = Object.fromEntries(
    Object.keys(lock.skills)
      .toSorted()
      .flatMap((name) => {
        const entry = lock.skills[name];

        return entry ? [[name, toLocalEntry(entry, lockDir)]] : [];
      })
  );

  return `${JSON.stringify({ version: LocalVersion, skills, ...lock.extra }, undefined, 2)}\n`;
}

/** Writes the lock. Leaves the file alone when its content would not change. */
export async function writeSkillsLock(lock: SkillsLock) {
  const text = serializeSkillsLock(lock);

  if ((await readText(lock.file)) === text) {
    return;
  }

  await writeFileAtomic(lock.file, text);
  lock.exists = true;
  lock.version = lock.kind === "global" ? GlobalVersion : LocalVersion;
}

function parseEntry(kind: Scope["kind"], value: ConfigTable, label: string): LockedSkill {
  if (kind === "global") {
    const entry = parseWith(GlobalEntrySchema, value, label);

    return {
      ...readCommonFields(entry),
      extra: pickExtra(entry, KnownGlobalFields),
      hash: entry.skillFolderHash,
      installedAt: entry.installedAt,
      pluginName: entry.pluginName,
      updatedAt: entry.updatedAt,
    };
  }

  const entry = parseWith(LocalEntrySchema, value, label);

  return {
    ...readCommonFields(entry),
    extra: pickExtra(entry, KnownLocalFields),
    hash: entry.computedHash,
  };
}

function parseWith<Schema extends z.ZodType>(
  schema: Schema,
  value: ConfigTable,
  label: string
): z.infer<Schema> {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new OperationError(`${label} is not a valid skills lock entry.`);
  }

  return result.data;
}

function readCommonFields(entry: z.infer<typeof EntrySchema>) {
  return {
    installMode: entry.installMode === "copy" ? ("copy" as const) : undefined,
    ref: entry.ref,
    skillName: entry.skillName,
    skillPath: entry.skillPath,
    source: entry.source,
    sourceType: entry.sourceType,
    sourceUrl: entry.sourceUrl,
  };
}

function pickExtra(entry: ConfigTable, known: Set<string>): ConfigTable {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !known.has(key)));
}

/** Field order follows skills.sh, so a lock written by either tool diffs cleanly. */
function toLocalEntry(entry: LockedSkill, lockDir: string) {
  const source =
    entry.sourceType === "local" ? toPortablePath(entry.source, lockDir) : entry.source;

  return withoutUndefined({
    source,
    sourceUrl: entry.sourceUrl,
    ref: entry.ref,
    sourceType: entry.sourceType,
    skillPath: entry.skillPath,
    computedHash: entry.hash,
    skillName: entry.skillName,
    ...entry.extra,
    installMode: entry.installMode,
  });
}

function toGlobalEntry(entry: LockedSkill) {
  return withoutUndefined({
    source: entry.source,
    sourceType: entry.sourceType,
    sourceUrl: entry.sourceUrl,
    ref: entry.ref,
    skillPath: entry.skillPath,
    skillName: entry.skillName,
    skillFolderHash: entry.hash,
    pluginName: entry.pluginName,
    ...entry.extra,
    installMode: entry.installMode,
    installedAt: entry.installedAt,
    updatedAt: entry.updatedAt,
  });
}

/** A local source as skills.sh writes it: relative to the lock, with `/` separators. */
function toPortablePath(source: string, lockDir: string) {
  const absolute = path.isAbsolute(source) ? source : path.resolve(lockDir, source);
  const relative = path.relative(lockDir, absolute);

  // Another Windows drive has no relative path.
  if (path.isAbsolute(relative)) {
    return absolute.split(path.sep).join("/");
  }

  const portable = relative.split(path.sep).join("/");

  if (portable === "") {
    return ".";
  }

  return portable === ".." || portable.startsWith("../") ? portable : `./${portable}`;
}

const ComparedFields = [
  "source",
  "sourceType",
  "sourceUrl",
  "ref",
  "skillPath",
  "skillName",
  "installMode",
  "hash",
  "pluginName",
] as const;

function isSameFields(previous: LockedSkill, fields: LockedSkillFields) {
  return ComparedFields.every((key) => previous[key] === fields[key]);
}

function withoutUndefined(value: Record<string, ConfigValue | undefined>): ConfigTable {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (item === undefined ? [] : [[key, item]]))
  );
}
