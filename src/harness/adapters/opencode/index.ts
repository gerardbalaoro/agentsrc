import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { OperationError } from "#errors.ts";
import { createOpenCodeUsage } from "#harness/adapters/opencode/usage.ts";
import { literal, parseImported } from "#harness/import-value.ts";
import type { Adapter, HarnessServer } from "#harness/registry.ts";
import { UniversalSkills } from "#harness/universal.ts";
import type { McpServer } from "#mcp/entry.ts";
import { formatEnvValue, getLiteral, hasReference } from "#mcp/env.ts";
import type { EnvValue } from "#mcp/env.ts";
import type { Scope } from "#scope.ts";
import { Ui } from "#ui.ts";
import { writeFileAtomic } from "#util/atomic-write.ts";
import { getValue, isTable } from "#util/config-value.ts";
import type { ConfigTable } from "#util/config-value.ts";
import { parseJson, removeJsonValue, setJsonValue } from "#util/json-edit.ts";
import { readText } from "#util/read-text.ts";

const run = promisify(execFile);

// OpenCode v2 keeps servers under `mcp.servers`. Version 1 put them directly under `mcp`.
const ServersKeys = ["mcp", "servers"];
const SupportedMajor = 2;

const ProjectFiles = [
  "opencode.json",
  "opencode.jsonc",
  path.join(".opencode", "opencode.json"),
  path.join(".opencode", "opencode.jsonc"),
];

const GlobalFiles = ["opencode.json", "opencode.jsonc"];

export const OpenCode: Adapter = {
  detect: (scope) =>
    scope?.kind === "project"
      ? ProjectFiles.some((file) => existsSync(path.join(scope.root, file))) ||
        existsSync(path.join(scope.root, ".opencode"))
      : existsSync(configDir()),

  id: "opencode",

  mcp: {
    location: configFile,
    import: importServer,
    async add(scope, server) {
      await requireSupportedVersion();
      const file = configFile(scope);
      const text = (await readText(file)) ?? "";
      const keys = [...ServersKeys, server.name];
      await writeFileAtomic(file, setJsonValue(text, keys, render(server)));

      return file;
    },

    async find(scope, name) {
      const servers = await listServers(scope);

      return servers.find((server) => server.name === name);
    },

    list: (scope) => listServers(scope),

    prepare: () => requireSupportedVersion(),

    async remove(scope, name) {
      const file = configFile(scope);
      const text = await readText(file);

      if (text !== undefined) {
        await writeFileAtomic(file, removeJsonValue(text, [...ServersKeys, name]));
      }
    },

    render,
  },

  usage: createOpenCodeUsage(),

  skills: UniversalSkills,
};

function configDir() {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");

  return path.join(base, "opencode");
}

/** The config file that exists, or `opencode.json` when none does. */
function configFile(scope: Scope) {
  const dir = scope.kind === "global" ? configDir() : scope.root;
  const names = scope.kind === "global" ? GlobalFiles : ProjectFiles;
  const existing = names.map((name) => path.join(dir, name)).find((file) => existsSync(file));

  return existing ?? path.join(dir, "opencode.json");
}

async function listServers(scope: Scope): Promise<HarnessServer[]> {
  const file = configFile(scope);
  const text = await readText(file);

  if (text === undefined || text.trim() === "") {
    return [];
  }

  const servers = getValue(parseJson(text, file), ServersKeys);

  return isTable(servers)
    ? Object.entries(servers).map(([name, config]) => ({ config, name }))
    : [];
}

let versionCheck: Promise<void> | undefined;

/** Runs `opencode --version` once per process. */
function requireSupportedVersion() {
  versionCheck ??= checkVersion();

  return versionCheck;
}

async function checkVersion() {
  const output = await readVersion();
  const major = Number(/(?<major>\d+)\.\d+\.\d+/u.exec(output)?.groups?.major);

  if (Number.isNaN(major)) {
    Ui.warn(
      "Cannot run `opencode --version`. agentsrc writes the OpenCode v2 config format, which older versions do not read."
    );

    return;
  }

  if (major < SupportedMajor) {
    throw new OperationError(
      `OpenCode ${output.trim()} is installed. agentsrc supports OpenCode v${SupportedMajor} or later. Update OpenCode, or remove \`opencode\` from \`agents\`.`
    );
  }
}

async function readVersion() {
  try {
    const result = await run("opencode", ["--version"]);

    return result.stdout;
  } catch {
    return "";
  }
}

function render(server: McpServer): ConfigTable {
  const table = (values: Record<string, EnvValue>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, formatValue(value, server.name)])
    );

  if (server.kind === "remote") {
    if (server.transport === "sse") {
      throw inexpressible(server.name, "OpenCode does not support SSE servers");
    }

    if (hasReference(server.url)) {
      throw inexpressible(server.name, "OpenCode has no environment references in `url`");
    }

    return {
      type: "remote",
      url: getLiteral(server.url),
      ...withEntries("headers", table(server.headers)),
    };
  }

  const args = server.args.map((arg) => {
    if (hasReference(arg)) {
      throw inexpressible(server.name, "OpenCode has no environment references in `args`");
    }

    return getLiteral(arg);
  });

  return {
    command: [server.command, ...args],
    type: "local",
    ...withEntries("environment", table(server.env)),
  };
}

/** OpenCode writes a reference as `{env:NAME}`, in `environment` and `headers`. */
function formatValue(value: EnvValue, name: string) {
  return formatEnvValue(value, {
    reference: (variable) => `{env:${variable}}`,
    text: (text) => {
      if (/\{(?:env|file):/u.test(text)) {
        throw inexpressible(name, "a literal `{env:` or `{file:` would be expanded by OpenCode");
      }

      return text;
    },
  });
}

function inexpressible(name: string, reason: string) {
  return new OperationError(`opencode cannot express the MCP server ${name}: ${reason}.`);
}

/** Leaves an empty table out of the rendered entry. */
function withEntries(key: string, value: Record<string, string>) {
  return Object.keys(value).length === 0 ? {} : { [key]: value };
}

const ImportSchema = z.union([
  z.strictObject({
    type: z.literal("local"),
    command: z.array(z.string()).min(1),
    environment: z.record(z.string(), z.string()).optional(),
    enabled: z.literal(true).optional(),
  }),
  z.strictObject({
    type: z.literal("remote"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.literal(true).optional(),
  }),
]);

function importServer(server: HarnessServer) {
  const config = parseImported(ImportSchema, server);

  const table = (values: Record<string, string> | undefined) =>
    Object.fromEntries(
      Object.entries(values ?? {}).map(([key, value]) => [key, importValue(value)])
    );

  if (config.type === "remote") {
    return { url: importValue(config.url), headers: table(config.headers) };
  }

  const [command, ...args] = config.command;

  if (command === undefined) {
    throw new OperationError(`No command for ${server.name}.`);
  }

  return { command, args: args.map(importValue), env: table(config.environment) };
}

function importValue(value: string) {
  if (value.includes("{file:")) {
    throw new OperationError("File substitutions cannot be imported into agents.toml.");
  }

  return literal(value).replaceAll(
    /\{env:(?<name>[A-Za-z_][A-Za-z0-9_]*)\}/gu,
    (_, name: string) => `\${${name}}`
  );
}
