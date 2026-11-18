import { readFile } from "node:fs/promises";
import path from "node:path";

import { OperationError } from "#errors.ts";
import type { HarnessId } from "#harness/ids.ts";
import { AllAdapters, selectAdapters } from "#harness/registry.ts";
import { discoverImports } from "#init/discover.ts";
import type { ImportCandidate } from "#init/discover.ts";
import { describeLocation } from "#manifest/load.ts";
import type { McpEntry, SkillEntry } from "#manifest/schema.ts";
import { planServers } from "#mcp/plan.ts";
import { parseFrontmatter, sanitizeMetadata } from "#skills/discover.ts";
import { getSkillRows } from "#skills/index.ts";
import { Ui } from "#ui.ts";
import { loadWorkspace } from "#workspace.ts";
import type { Workspace } from "#workspace.ts";

export type EntryKind = "skills" | "mcp";

export interface InventoryItem {
  id: string;
  kind: EntryKind;
  name: string;
  description?: string;
  source: string;
  status: "ok" | "missing" | "modified" | "untracked" | "unsupported";
  managed: boolean;
  declared: boolean;
  origin: string;
  harnesses: HarnessId[];
  entry: SkillEntry | McpEntry | undefined;
  issues: string[];
}

export interface Inventory {
  workspace: Workspace;
  items: InventoryItem[];
  warnings: string[];
}

interface InventoryRow {
  name: string;
  source: string | undefined;
  status: InventoryItem["status"];
  issues?: { harness: HarnessId; message: string }[];
  harnesses?: HarnessId[];
}

/** Reads both domains in one scope, including entries found only in a harness. */
export async function readInventory(global: boolean, cwd = process.cwd()): Promise<Inventory> {
  const warnings: string[] = [];

  return await Ui.capture(
    (message) => warnings.push(message.text),
    async () => {
      const workspace = await loadWorkspace(
        { global, agents: undefined, dryRun: false, frozen: false, yes: false },
        cwd,
        { reviewRemoteChanges: true }
      );

      const skills = await getSkillRows(workspace);

      const servers = await planServers(workspace, {
        force: false,
        resolve: false,
        update: "none",
        reportUnsupported: true,
      });

      const found = await discoverImports(workspace.scope);

      const skillItems = await Promise.all(
        domainItems(workspace, "skills", skills, found.skills).map(async (item) => {
          const installed = found.skills.find((candidate) =>
            item.declared || item.managed
              ? candidate.name === item.name
              : candidate.id === item.origin
          );

          if (installed) {
            item.description = await readSkillDescription(installed.directory);
          }

          return item;
        })
      );

      const items = [...skillItems, ...domainItems(workspace, "mcp", servers.rows, found.mcp)];

      return {
        workspace,
        items: items.toSorted(
          (a, b) =>
            a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
        ),
        warnings,
      };
    }
  );
}

async function readSkillDescription(directory: string) {
  try {
    const text = await readFile(path.join(directory, "SKILL.md"), "utf-8");
    const { data } = parseFrontmatter(text);

    return data?.description ? sanitizeMetadata(data.description) : undefined;
  } catch {
    // Missing or malformed metadata must not hide an otherwise usable entry.
  }
}

function domainItems(
  workspace: Workspace,
  kind: EntryKind,
  rows: InventoryRow[],
  candidates: ImportCandidate<SkillEntry | McpEntry>[]
) {
  const declared = workspace.manifest[kind];

  const owned = new Set(
    kind === "skills" ? workspace.lock.skills : Object.keys(workspace.lock.mcp)
  );

  const names = new Set([...Object.keys(declared), ...owned]);

  const known = [...names].map((name): InventoryItem => {
    const declaration = declared[name];
    const row = rows.find((item) => item.name === name);
    const entry = declaration?.entry ?? candidates.find((item) => item.name === name)?.entry;

    const harnesses = selectAdapters({
      entry: entry?.agents,
      manifest: workspace.manifest.agents,
      flag: undefined,
    }).map((adapter) => adapter.id);

    return {
      id: `${kind}:${name}`,
      kind,
      name,
      entry,
      managed: owned.has(name),
      declared: declaration !== undefined,
      source: row?.source ?? sourceLabel(entry),
      status: row?.status ?? "missing",
      origin: declaration ? describeLocation(declaration.declaredIn) : "No longer declared",
      harnesses,
      issues: row?.issues?.map((issue) => `${issue.harness}: ${issue.message}`) ?? [],
    };
  });

  const untracked = candidates.flatMap((candidate): InventoryItem[] =>
    names.has(candidate.name)
      ? []
      : [
          {
            id: `${kind}:import:${candidate.id}`,
            kind,
            name: candidate.name,
            entry: {
              ...candidate.entry,
              agents: candidate.entry.agents ?? availableHarnesses(workspace),
            },
            managed: false,
            declared: false,
            source: sourceLabel(candidate.entry),
            status: "untracked",
            origin: candidate.id,
            harnesses: candidate.entry.agents ?? availableHarnesses(workspace),
            issues: [],
          },
        ]
  );

  const unsupported = rows.flatMap((row): InventoryItem[] => {
    if (names.has(row.name) || candidates.some((candidate) => candidate.name === row.name)) {
      return [];
    }

    return [
      {
        id: `${kind}:${row.name}`,
        kind,
        name: row.name,
        entry: undefined,
        managed: false,
        declared: false,
        source: row.source ?? "",
        status: "unsupported",
        origin: "Existing harness configuration",
        harnesses: row.harnesses ?? [],
        issues: [
          "This entry cannot be imported. Edit its harness configuration to use a supported form.",
        ],
      },
    ];
  });

  return [...known, ...untracked, ...unsupported];
}

function sourceLabel(entry: InventoryItem["entry"]) {
  if (!entry) {
    return "";
  }

  if ("source" in entry) {
    return entry.source;
  }

  if ("package" in entry) {
    return entry.package;
  }

  if ("url" in entry) {
    return entry.url;
  }

  return entry.command;
}

export function requireEntry(item: InventoryItem) {
  if (item.entry === undefined) {
    throw new OperationError(`${item.name} has no importable definition.`);
  }

  return item.entry;
}

/** The UI hides literal credentials, but never expands environment references. */
export function describeEntry(item: InventoryItem) {
  const { entry } = item;

  if (!entry) {
    return [];
  }

  const lines = Object.entries(entry)
    .filter(([key]) => key !== "env" && key !== "headers")
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);

  if ("env" in entry && entry.env) {
    lines.push(...credentialLines("env", entry.env));
  }

  if ("headers" in entry && entry.headers) {
    lines.push(...credentialLines("headers", entry.headers));
  }

  return lines;
}

function credentialLines(label: string, values: Record<string, string>) {
  return Object.entries(values).map(
    ([name, text]) => `${label}.${name} = ${text.includes("${") ? text : "[hidden]"}`
  );
}

export function availableHarnesses(workspace: Workspace) {
  return (
    workspace.manifest.agents ??
    AllAdapters.filter((adapter) => adapter.detect(workspace.scope)).map((adapter) => adapter.id)
  );
}
