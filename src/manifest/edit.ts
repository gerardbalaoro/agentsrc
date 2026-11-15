import { unlink } from "node:fs/promises";

import { UsageError } from "#errors.ts";
import { parseManifest } from "#manifest/load.ts";
import type { McpEntry, SkillEntry } from "#manifest/schema.ts";
import { writeFileAtomic } from "#util/atomic-write.ts";
import { isTable } from "#util/config-value.ts";
import type { ConfigValue } from "#util/config-value.ts";
import { readText } from "#util/read-text.ts";
import { parseToml, removeTomlValue, setTomlValue } from "#util/toml-edit.ts";

/** The two tables of the manifest that hold named entries. */
export type EntryTable = "skills" | "mcp";

// A skill is one line under `[skills]`. An MCP server is its own `[mcp.<name>]` section.
const SectionDepth = { mcp: 2, skills: 1 } as const;

/** Adds an entry to the manifest at `file`. Creates the manifest when there is none. */
export async function addManifestEntry(
  file: string,
  table: EntryTable,
  name: string,
  entry: SkillEntry | McpEntry,
  options: { force: boolean }
) {
  const change = await prepareManifestEntries(file, table, [{ name, entry }], options);
  await writeFileAtomic(file, change.text);
}

/** Validates a batch and renders one edit without changing the manifest. */
export async function prepareManifestEntries(
  file: string,
  table: EntryTable,
  entries: { name: string; entry: SkillEntry | McpEntry }[],
  options: { force: boolean }
) {
  const original = await readText(file);
  let text = original ?? "";
  const names = new Set<string>();

  for (const { name, entry } of entries) {
    if (names.has(name) || (hasEntry(text, file, table, name) && !options.force)) {
      throw new UsageError(
        `${file} already has the entry ${table}.${name}. Use --force to replace it.`
      );
    }

    names.add(name);
    text = setTomlValue(text, [table, name], toTomlValue(table, entry), {
      sectionDepth: SectionDepth[table],
    });
  }

  parseManifest(text, { kind: "file", path: file });

  return { file, original, text };
}

export type ManifestChange = Awaited<ReturnType<typeof prepareManifestEntries>>;

/** Commits a prepared edit; a failed apply restores the original manifest. */
export async function commitManifestChange(change: ManifestChange, apply: () => Promise<void>) {
  await writeFileAtomic(change.file, change.text);

  try {
    await apply();
  } catch (error) {
    await (change.original === undefined
      ? unlink(change.file)
      : writeFileAtomic(change.file, change.original));

    throw error;
  }
}

/** Writes `name = false`, which removes an entry that an extended manifest declares. */
export async function disableManifestEntry(file: string, table: EntryTable, name: string) {
  const text = (await readText(file)) ?? "";
  await writeEntry(file, text, table, name, false);
}

/** Deletes an entry from the manifest at `file`. Returns false when it had no such entry. */
export async function removeManifestEntry(file: string, table: EntryTable, name: string) {
  const text = await readText(file);

  if (text === undefined || !hasEntry(text, file, table, name)) {
    return false;
  }

  await writeFileAtomic(file, removeTomlValue(text, [table, name]));

  return true;
}

function hasEntry(text: string, file: string, table: EntryTable, name: string) {
  const entries = parseToml(text, file)[table];

  return isTable(entries) && entries[name] !== undefined;
}

async function writeEntry(
  file: string,
  text: string,
  table: EntryTable,
  name: string,
  value: ConfigValue
) {
  const sectionDepth = SectionDepth[table];
  await writeFileAtomic(file, setTomlValue(text, [table, name], value, { sectionDepth }));
}

function toTomlValue(table: EntryTable, entry: SkillEntry | McpEntry): ConfigValue {
  const isSourceOnly = table === "skills" && "source" in entry && Object.keys(entry).length === 1;

  if (isSourceOnly) {
    return entry.source;
  }

  return Object.fromEntries(
    Object.entries(entry).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]]))
  );
}
