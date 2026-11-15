import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { OperationError } from "#errors.ts";
import { literal, parseImported } from "#harness/import-value.ts";
import type { Adapter, HarnessServer } from "#harness/registry.ts";
import { UniversalSkills } from "#harness/universal.ts";
import type { McpServer, RemoteServer, StdioServer } from "#mcp/entry.ts";
import { getLiteral, getReference, hasReference } from "#mcp/env.ts";
import type { EnvValue } from "#mcp/env.ts";
import type { Scope } from "#scope.ts";
import { Ui } from "#ui.ts";
import { writeFileAtomic } from "#util/atomic-write.ts";
import { isTable } from "#util/config-value.ts";
import type { ConfigTable } from "#util/config-value.ts";
import { readText } from "#util/read-text.ts";
import { parseToml, removeTomlValue, setTomlValue } from "#util/toml-edit.ts";

const ServersKey = "mcp_servers";
const BearerPrefix = "Bearer ";

export const Codex: Adapter = {
  detect: (scope) =>
    scope?.kind === "project"
      ? existsSync(path.join(scope.root, ".codex"))
      : existsSync(configDir()) || (scope === undefined && existsSync("/etc/codex")),

  id: "codex",

  mcp: {
    import: importServer,
    async add(scope, server) {
      const file = configFile(scope);
      const text = (await readText(file)) ?? "";
      const keys = [ServersKey, server.name];
      await writeFileAtomic(file, setTomlValue(text, keys, render(server), { sectionDepth: 2 }));

      if (scope.kind === "project") {
        Ui.info(`Codex reads ${file} only when the project is trusted.`);
      }

      return file;
    },

    async find(scope, name) {
      const servers = await listServers(scope);

      return servers.find((server) => server.name === name);
    },

    list: (scope) => listServers(scope),

    async remove(scope, name) {
      const file = configFile(scope);
      const text = await readText(file);

      if (text !== undefined) {
        await writeFileAtomic(file, removeTomlValue(text, [ServersKey, name]));
      }
    },

    render,
  },

  skills: UniversalSkills,
};

function configDir() {
  return process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
}

function configFile(scope: Scope) {
  return scope.kind === "global"
    ? path.join(configDir(), "config.toml")
    : path.join(scope.root, ".codex", "config.toml");
}

async function listServers(scope: Scope): Promise<HarnessServer[]> {
  const file = configFile(scope);
  const text = await readText(file);

  if (text === undefined) {
    return [];
  }

  const servers = parseToml(text, file)[ServersKey];

  return isTable(servers)
    ? Object.entries(servers).map(([name, config]) => ({ config, name }))
    : [];
}

function render(server: McpServer): ConfigTable {
  return server.kind === "remote" ? renderRemote(server) : renderStdio(server);
}

/**
 * Codex does not expand `${VAR}`. In `env`, the only reference it can express is a variable
 * forwarded under its own name, through `env_vars`.
 */
function renderStdio(server: StdioServer): ConfigTable {
  const args = server.args.map((arg) => {
    if (hasReference(arg)) {
      throw inexpressible(server.name, "Codex has no environment references in `args`");
    }

    return getLiteral(arg);
  });

  const env: Record<string, string> = {};
  const forwarded: string[] = [];

  for (const [key, value] of Object.entries(server.env)) {
    if (!hasReference(value)) {
      env[key] = getLiteral(value);
      continue;
    }

    if (getReference(value) !== key) {
      throw inexpressible(
        server.name,
        `Codex can only forward a variable under its own name, as \`${key} = "\${${key}}"\``
      );
    }

    forwarded.push(key);
  }

  return {
    command: server.command,
    ...withEntries("args", args),
    ...withEntries("env", env),
    ...withEntries("env_vars", forwarded),
  };
}

/**
 * A header can be literal, taken whole from a variable (`env_http_headers`), or a bearer token
 * (`bearer_token_env_var`). Codex supports streamable HTTP only.
 */
function renderRemote(server: RemoteServer): ConfigTable {
  if (server.transport === "sse") {
    throw inexpressible(server.name, "Codex does not support SSE servers");
  }

  if (hasReference(server.url)) {
    throw inexpressible(server.name, "Codex has no environment references in `url`");
  }

  const headers: Record<string, string> = {};
  const fromEnv: Record<string, string> = {};
  let bearer: string | undefined;

  for (const [header, value] of Object.entries(server.headers)) {
    const variable = getReference(value);
    const token = getBearerVariable(value);

    if (!hasReference(value)) {
      headers[header] = getLiteral(value);
    } else if (variable !== undefined) {
      fromEnv[header] = variable;
    } else if (header.toLowerCase() === "authorization" && token !== undefined) {
      bearer = token;
    } else {
      throw inexpressible(
        server.name,
        `Codex cannot mix text and a reference in the header ${header}, except as \`Authorization = "Bearer \${VAR}"\``
      );
    }
  }

  const config: ConfigTable = { url: getLiteral(server.url) };

  if (bearer !== undefined) {
    config.bearer_token_env_var = bearer;
  }

  return {
    ...config,
    ...withEntries("http_headers", headers),
    ...withEntries("env_http_headers", fromEnv),
  };
}

/** The variable in a value of the exact form `Bearer ${VAR}`. */
function getBearerVariable(value: EnvValue) {
  const [prefix, token] = value;

  const isBearer =
    value.length === 2 &&
    prefix?.kind === "text" &&
    prefix.text === BearerPrefix &&
    token?.kind === "env";

  return isBearer ? token.name : undefined;
}

function inexpressible(name: string, reason: string) {
  return new OperationError(`codex cannot express the MCP server ${name}: ${reason}.`);
}

/** Leaves an empty list or table out of the rendered entry. */
function withEntries(key: string, value: string[] | Record<string, string>) {
  return Object.keys(value).length === 0 ? {} : { [key]: value };
}

const ImportSchema = z.union([
  z.strictObject({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    env_vars: z.array(z.string()).optional(),
    enabled: z.literal(true).optional(),
  }),
  z.strictObject({
    url: z.string().min(1),
    http_headers: z.record(z.string(), z.string()).optional(),
    env_http_headers: z.record(z.string(), z.string()).optional(),
    bearer_token_env_var: z.string().optional(),
    enabled: z.literal(true).optional(),
  }),
]);

function importServer(server: HarnessServer) {
  const config = parseImported(ImportSchema, server);

  if ("command" in config) {
    const env = Object.fromEntries(
      Object.entries(config.env ?? {}).map(([key, value]) => [key, literal(value)])
    );

    for (const variable of config.env_vars ?? []) {
      env[variable] = `\${${variable}}`;
    }

    return { command: config.command, args: config.args?.map(literal), env };
  }

  const headers = Object.fromEntries(
    Object.entries(config.http_headers ?? {}).map(([key, value]) => [key, literal(value)])
  );

  for (const [key, variable] of Object.entries(config.env_http_headers ?? {})) {
    headers[key] = `\${${variable}}`;
  }

  if (config.bearer_token_env_var !== undefined) {
    headers.Authorization = `Bearer \${${config.bearer_token_env_var}}`;
  }

  return { url: literal(config.url), headers };
}
