import path from "node:path";

import { z } from "zod";

import { UsageError } from "#errors.ts";
import { HarnessIds } from "#harness/ids.ts";
import type { HarnessId } from "#harness/ids.ts";
import type { InventoryItem } from "#interactive/inventory.ts";
import type { SkillEntry } from "#manifest/schema.ts";
import { parseAddRequest } from "#mcp/spec.ts";
import { discoverSkills, sanitizeName } from "#skills/discover.ts";
import { createSourceCache } from "#skills/fetch.ts";
import { parseSource, toManifestSource } from "#skills/source.ts";
import { parseJson } from "#util/json-edit.ts";
import type { Workspace } from "#workspace.ts";

export interface FormField {
  label: string;
  value: string;
  hint: string;
}

export interface AddForm {
  kind: "skills" | "mcp";
  fields: FormField[];
  index: number;
}

export function createAddForm(kind: AddForm["kind"], agents: HarnessId[]): AddForm {
  const targets = {
    label: "Harnesses",
    value: agents.join(","),
    hint: "claude-code,codex,opencode",
  };

  const fields =
    kind === "skills"
      ? [
          { label: "Source", value: "", hint: "owner/repo, Git URL, or local directory" },
          targets,
          { label: "Install mode", value: "link", hint: "link or copy" },
        ]
      : [
          { label: "Name", value: "", hint: "A unique server name" },
          { label: "Type", value: "package", hint: "package, command, or url" },
          { label: "Source", value: "", hint: "npm:package@range, executable, or https://…" },
          { label: "Arguments", value: "[]", hint: 'JSON array, e.g. ["--port", "3000"]' },
          { label: "Environment", value: "{}", hint: 'JSON object, e.g. {"TOKEN":"${TOKEN}"}' },
          {
            label: "Headers",
            value: "{}",
            hint: 'URL only, e.g. {"Authorization":"Bearer ${TOKEN}"}',
          },
          { label: "Transport", value: "http", hint: "URL only: http or sse" },
          targets,
        ];

  return { kind, fields, index: 0 };
}

function parseHarnesses(text: string) {
  const names = text
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  return [...new Set(names)].map((name) => {
    const id = HarnessIds.find((value) => value === name);

    if (!id) {
      throw new UsageError(`Unknown harness ${name}. Choose ${HarnessIds.join(", ")}.`);
    }

    return id;
  });
}

/** Source discovery shares the CLI's resolution conventions; no scope files are written. */
export async function discoverAdditions(
  form: AddForm,
  workspace: Workspace,
  cwd: string
): Promise<InventoryItem[]> {
  const values = Object.fromEntries(form.fields.map((field) => [field.label, field.value]));
  const agents = parseHarnesses(values.Harnesses ?? "");
  const source = values.Source?.trim() ?? "";

  if (!source) {
    throw new UsageError("Enter a source.");
  }

  if (form.kind === "skills") {
    const mode = values["Install mode"] ?? "link";

    if (mode !== "link" && mode !== "copy") {
      throw new UsageError("Install mode must be link or copy.");
    }

    return await discoverSkillAdditions(source, agents, workspace, cwd, mode === "copy");
  }

  return createServerAddition(values, source, agents, workspace);
}

async function discoverSkillAdditions(
  source: string,
  agents: HarnessId[],
  workspace: Workspace,
  cwd: string,
  copy: boolean
): Promise<InventoryItem[]> {
  const parsed = parseSource(source, { cwd });
  const cache = createSourceCache();

  try {
    const fetched = await cache.fetch(parsed, parsed.ref);

    const found = await discoverSkills(fetched.root, {
      subpath: parsed.subpath,
      requested: parsed.skillFilter ? [parsed.skillFilter] : undefined,
    });

    if (!found.length) {
      throw new UsageError(`No skills found in ${source}.`);
    }

    return found
      .toSorted((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir))
      .map((skill) => {
        const name = sanitizeName(skill.name);

        return {
          id: `skills:add:${name}:${skill.dir}`,
          kind: "skills",
          name,
          source,
          status: "missing",
          managed: false,
          declared: false,
          origin: workspace.manifestFile,
          harnesses: agents,
          issues: [],
          entry: {
            ...skillEntry(parsed, agents, workspace, name, skill.name),
            path: path.relative(fetched.root, skill.dir).split(path.sep).join("/") || ".",
            copy,
          },
        };
      });
  } finally {
    await cache.dispose();
  }
}

function createServerAddition(
  values: Record<string, string>,
  source: string,
  agents: HarnessId[],
  workspace: Workspace
): InventoryItem[] {
  const name = values.Name?.trim();

  if (!name) {
    throw new UsageError("Enter a server name.");
  }

  if (!agents.length) {
    throw new UsageError("Choose at least one harness for this MCP server.");
  }

  const type = values.Type?.trim().toLowerCase();

  if (!["package", "command", "url"].includes(type ?? "")) {
    throw new UsageError("Type must be package, command, or url.");
  }

  const args = parseArguments(values.Arguments ?? "[]");

  const env = textTable(values.Environment ?? "{}", "Environment");
  const headers = textTable(values.Headers ?? "{}", "Headers");

  if (type === "url" && !/^https?:\/\//iu.test(source)) {
    throw new UsageError("Enter an HTTP or HTTPS URL.");
  }

  if (type === "url" && args.length) {
    throw new UsageError("URL servers do not accept arguments.");
  }

  const parsed = parseAddRequest({
    spec: type === "command" ? name : source,
    name,
    command: type === "command" ? [source, ...args] : [],
    env,
    headers,
    transport: type === "url" ? parseTransport(values.Transport ?? "http") : undefined,
  });

  const entry = { ...parsed.entry, agents };

  if ("package" in entry && args.length) {
    entry.args = args;
  }

  return [
    {
      id: `mcp:${name}`,
      kind: "mcp",
      name,
      source,
      status: "missing",
      managed: false,
      declared: false,
      origin: workspace.manifestFile,
      harnesses: agents,
      issues: [],
      entry,
    },
  ];
}

function skillEntry(
  parsed: ReturnType<typeof parseSource>,
  agents: HarnessId[],
  workspace: Workspace,
  name: string,
  sourceName: string
): SkillEntry {
  const entry: SkillEntry = {
    source: toManifestSource(parsed, path.dirname(workspace.manifestFile)),
    agents,
  };

  if (parsed.ref) {
    entry.ref = parsed.ref;
  }

  if (parsed.subpath) {
    entry.path = parsed.subpath;
  }

  if (name !== sourceName) {
    entry.skill = sourceName;
  }

  return entry;
}

function parseArguments(text: string) {
  const result = z.array(z.string()).safeParse(parseJson(text, "Arguments"));

  if (!result.success) {
    throw new UsageError("Arguments must be a JSON array of strings.");
  }

  return result.data;
}

function parseTransport(value: string) {
  const result = z.enum(["http", "sse"]).safeParse(value);

  if (!result.success) {
    throw new UsageError("Transport must be http or sse.");
  }

  return result.data;
}

function textTable(text: string, label: string) {
  const result = z.record(z.string(), z.string()).safeParse(parseJson(text, label));

  if (!result.success) {
    throw new UsageError(`${label} must be a JSON object of strings.`);
  }

  return result.data;
}
