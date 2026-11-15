import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { OperationError } from "#errors.ts";
import { parseImported } from "#harness/import-value.ts";
import type { Adapter, HarnessServer } from "#harness/registry.ts";
import { createLinkedSkills } from "#harness/skill-dirs.ts";
import type { McpServer } from "#mcp/entry.ts";
import { formatEnvValue } from "#mcp/env.ts";
import type { EnvValue } from "#mcp/env.ts";
import type { Scope } from "#scope.ts";
import { writeFileAtomic } from "#util/atomic-write.ts";
import { getValue, isTable } from "#util/config-value.ts";
import type { ConfigTable } from "#util/config-value.ts";
import { parseJson, removeJsonValue, setJsonValue } from "#util/json-edit.ts";
import { readText } from "#util/read-text.ts";

const run = promisify(execFile);
const ServersKey = "mcpServers";

export const ClaudeCode: Adapter = {
  detect: (scope) =>
    scope?.kind === "project"
      ? existsSync(projectFile(scope)) || existsSync(path.join(scope.root, ".claude"))
      : existsSync(configDir()) || existsSync(userFile()),

  id: "claude-code",

  mcp: {
    import: importServer,
    async add(scope, server) {
      const config = render(server);

      if (scope.kind === "global") {
        // `~/.claude.json` also holds the application's live state, so only the CLI writes it.
        await removeUserServer(server.name);
        await claude([
          "mcp",
          "add-json",
          "--scope",
          "user",
          "--",
          server.name,
          JSON.stringify(config),
        ]);

        const installed = await listServers(scope);

        if (!installed.some((item) => item.name === server.name)) {
          throw new OperationError(`Claude Code did not store MCP server ${server.name}.`);
        }

        return "Claude Code user config";
      }

      const file = projectFile(scope);
      const text = (await readText(file)) ?? "";
      await writeFileAtomic(file, setJsonValue(text, [ServersKey, server.name], config));

      return file;
    },

    async find(scope, name) {
      const servers = await listServers(scope);

      return servers.find((server) => server.name === name);
    },

    list: (scope) => listServers(scope),

    async remove(scope, name) {
      if (scope.kind === "global") {
        await removeUserServer(name);

        return;
      }

      const file = projectFile(scope);
      const text = await readText(file);

      if (text !== undefined) {
        await writeFileAtomic(file, removeJsonValue(text, [ServersKey, name]));
      }
    },

    render,
  },

  skills: createLinkedSkills((scope) =>
    scope.kind === "global"
      ? path.join(configDir(), "skills")
      : path.join(scope.root, ".claude", "skills")
  ),
};

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
}

function projectFile(scope: Scope) {
  return path.join(scope.root, ".mcp.json");
}

/** The file that holds user-scope servers. agentsrc reads it and never writes it. */
function userFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
}

async function listServers(scope: Scope): Promise<HarnessServer[]> {
  const file = scope.kind === "global" ? userFile() : projectFile(scope);
  const text = await readText(file);

  if (text === undefined || text.trim() === "") {
    return [];
  }

  const servers = getValue(parseJson(text, file), [ServersKey]);

  if (!isTable(servers)) {
    return [];
  }

  return Object.entries(servers).map(([name, config]) => ({ config, name }));
}

async function removeUserServer(name: string) {
  const servers = await listServers({ kind: "global", root: homedir() });

  if (servers.some((server) => server.name === name)) {
    await claude(["mcp", "remove", "--scope", "user", "--", name]);
  }
}

async function claude(args: string[]) {
  try {
    await run("claude", args);
  } catch (error) {
    const isMissing = error instanceof Error && "code" in error && error.code === "ENOENT";

    if (isMissing) {
      throw new OperationError(
        "The `claude` command is not on PATH. agentsrc needs it to change Claude Code's global MCP servers."
      );
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new OperationError(`\`claude ${args.slice(0, 2).join(" ")}\` failed: ${reason}`);
  }
}

function render(server: McpServer): ConfigTable {
  if (!/^[A-Za-z0-9_-]+$/u.test(server.name)) {
    throw new OperationError(
      `claude-code cannot express MCP server name ${JSON.stringify(server.name)}. Use letters, digits, hyphens and underscores.`
    );
  }

  const text = (value: EnvValue, field: string) => formatValue(value, server.name, field);

  const table = (values: Record<string, EnvValue>, field: string) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, text(value, `${field}.${key}`)])
    );

  if (server.kind === "remote") {
    return {
      type: server.transport,
      url: text(server.url, "url"),
      ...withEntries("headers", table(server.headers, "headers")),
    };
  }

  return {
    command: server.command,
    ...withEntries(
      "args",
      server.args.map((arg) => text(arg, "args"))
    ),
    ...withEntries("env", table(server.env, "env")),
  };
}

/** Claude Code expands `${VAR}` itself, so a reference is written as it is in the manifest. */
function formatValue(value: EnvValue, name: string, field: string) {
  return formatEnvValue(value, {
    reference: (variable) => `\${${variable}}`,
    text: (literal) => {
      if (literal.includes("${")) {
        throw new OperationError(
          `claude-code cannot express the MCP server ${name}: ${field} holds a literal \`\${\`, which Claude Code would expand.`
        );
      }

      return literal;
    },
  });
}

/** Leaves an empty list or table out of the rendered entry. */
function withEntries(key: string, value: string[] | Record<string, string>) {
  return Object.keys(value).length === 0 ? {} : { [key]: value };
}

const ImportSchema = z.union([
  z.strictObject({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    type: z.enum(["http", "sse"]).optional(),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

function importServer(server: HarnessServer) {
  const { type, ...entry } = parseImported(ImportSchema, server);

  return "url" in entry && type !== undefined && type !== "stdio"
    ? { ...entry, transport: type }
    : entry;
}
