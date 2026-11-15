import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { UsageError } from "#errors.ts";
import type { HarnessId } from "#harness/ids.ts";
import { HarnessIds } from "#harness/ids.ts";
import { discoverImports } from "#init/discover.ts";
import type { ImportCandidate } from "#init/discover.ts";
import { parseManifest } from "#manifest/load.ts";
import type { McpEntry, SkillEntry } from "#manifest/schema.ts";
import { manifestPath, resolveScope } from "#scope.ts";
import { Ui } from "#ui.ts";
import { isSameValue, isTable } from "#util/config-value.ts";
import { readText } from "#util/read-text.ts";
import { setTomlValue } from "#util/toml-edit.ts";

export interface InitOptions {
  global: boolean;
  agents: HarnessId[] | undefined;
  yes: boolean;
  dryRun: boolean;
  list: boolean;
  skills: string[] | undefined;
  mcp: string[] | undefined;
}

export async function initialize(options: InitOptions, cwd = process.cwd()) {
  const scope = resolveScope({ global: options.global, cwd });
  const file = manifestPath(scope);

  if (!options.list && (await readText(file)) !== undefined) {
    throw new UsageError(`${file} already exists. init never overwrites a manifest.`);
  }

  const found = await discoverImports(scope);
  Ui.info(`Detected ${scope.kind} harnesses: ${found.agents.join(", ") || "none"}.`);

  if (options.list) {
    for (const skill of found.skills) {
      Ui.print(`skill ${skill.id}`);
    }

    for (const server of found.mcp) {
      Ui.print(`mcp ${server.id}`);
    }

    return;
  }

  const interactive = Ui.isInteractive() && !options.yes;

  const selectedAgents = options.agents ?? (await chooseHarnesses(found.agents, interactive));
  requireImportChoice(options, found, interactive);

  const skills = await choose("skills", found.skills, options.skills, interactive);
  const mcp = await choose("MCP servers", found.mcp, options.mcp, interactive);
  let text = setTomlValue("", ["agents"], selectedAgents, { sectionDepth: 1 });

  for (const [name, entry] of combine(skills)) {
    text = setTomlValue(text, ["skills", name], cleanEntry(entry), { sectionDepth: 1 });
  }

  for (const [name, entry] of combine(mcp)) {
    text = setTomlValue(text, ["mcp", name], cleanEntry(entry), { sectionDepth: 2 });
  }

  parseManifest(text, { kind: "file", path: file });

  if (options.dryRun) {
    Ui.print(text);

    return;
  }

  await mkdir(path.dirname(file), { recursive: true });
  // Exclusive creation also protects a manifest created after discovery started.
  await writeFile(file, text, { flag: "wx", mode: 0o600 });
  Ui.info(`Created ${file}.`);

  if (skills.length > 0 || mcp.length > 0) {
    Ui.info(
      `Run arc sync${options.global ? " -g" : ""} --force to install and take ownership of the selected imports.`
    );
  }
}

async function chooseHarnesses(detected: HarnessId[], interactive: boolean) {
  if (!interactive) {
    return detected;
  }

  return await Ui.selectOptional(
    "Which harnesses should this manifest target?",
    detected.length > 0 ? detected : [...HarnessIds]
  );
}

function requireImportChoice(
  options: InitOptions,
  found: Awaited<ReturnType<typeof discoverImports>>,
  interactive: boolean
) {
  const hasImports = found.skills.length > 0 || found.mcp.length > 0;
  const hasSelection = options.skills !== undefined || options.mcp !== undefined;

  if (!interactive && !options.yes && !hasSelection && hasImports) {
    throw new UsageError(
      "Choose imports with --skill and --mcp, inspect them with --list, or use --yes to create without imports."
    );
  }
}

async function choose<Entry>(
  label: string,
  candidates: ImportCandidate<Entry>[],
  requested: string[] | undefined,
  interactive: boolean
) {
  const names =
    requested ??
    (interactive && candidates.length > 0
      ? await Ui.selectOptional(
          `Which existing ${label} should be imported?`,
          candidates.map((candidate) => candidate.id)
        )
      : []);

  const unknown = names.filter(
    (name) =>
      name !== "*" &&
      !candidates.some((candidate) => candidate.id === name || candidate.name === name)
  );

  if (unknown.length > 0) {
    throw new UsageError(
      `No importable ${label} named ${unknown.join(", ")}. Run arc init --list.`
    );
  }

  return candidates.filter(
    (candidate) =>
      names.includes("*") || names.includes(candidate.id) || names.includes(candidate.name)
  );
}

function combine<Entry extends SkillEntry | McpEntry>(candidates: ImportCandidate<Entry>[]) {
  const entries = new Map<string, Entry>();

  for (const candidate of candidates) {
    const previous = entries.get(candidate.name);

    if (previous === undefined) {
      entries.set(candidate.name, candidate.entry);
    } else {
      const { agents: oldAgents, ...oldEntry } = previous;
      const { agents: newAgents, ...newEntry } = candidate.entry;

      if (!isSameValue(cleanEntry(oldEntry), cleanEntry(newEntry))) {
        throw new UsageError(
          `Conflicting imports for ${candidate.name}. Select one origin:name with --skill or --mcp.`
        );
      }

      entries.set(candidate.name, {
        ...previous,
        agents: [...new Set([...(oldAgents ?? []), ...(newAgents ?? [])])],
      });
    }
  }

  return entries;
}

function cleanEntry(
  entry: SkillEntry | McpEntry | Omit<SkillEntry, "agents"> | Omit<McpEntry, "agents">
) {
  return Object.fromEntries(
    Object.entries(entry).filter(
      ([, value]) =>
        value !== undefined &&
        (!Array.isArray(value) || value.length > 0) &&
        (!isTable(value) || Object.keys(value).length > 0)
    )
  );
}
