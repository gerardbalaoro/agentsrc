import { createHash } from "node:crypto";

import type { McpEntry } from "#manifest/schema.ts";
import { parseEnvValue } from "#mcp/env.ts";
import type { EnvValue } from "#mcp/env.ts";

/** An MCP server in the one form that every adapter receives. */
export type McpServer = StdioServer | RemoteServer;

export interface StdioServer {
  kind: "stdio";
  name: string;
  command: string;
  args: EnvValue[];
  env: Record<string, EnvValue>;
}

export interface RemoteServer {
  kind: "remote";
  name: string;
  url: EnvValue;
  transport: "http" | "sse";
  headers: Record<string, EnvValue>;
}

const PackagePrefix = "npm:";

/** The npm package name of a `package` entry, without the `npm:` prefix. */
export function getPackageName(entry: McpEntry) {
  return "package" in entry ? entry.package.slice(PackagePrefix.length) : undefined;
}

/**
 * Converts a manifest entry to a server. A `package` entry needs the locked version, because the
 * rendered command pins it.
 */
export function createServer(name: string, entry: McpEntry, lockedVersion?: string): McpServer {
  const label = `mcp.${name}`;

  if ("url" in entry) {
    return {
      headers: parseTable(entry.headers, `${label}.headers`),
      kind: "remote",
      name,
      transport: entry.transport ?? "http",
      url: parseEnvValue(entry.url, `${label}.url`),
    };
  }

  const args = (entry.args ?? []).map((arg) => parseEnvValue(arg, `${label}.args`));
  const env = parseTable(entry.env, `${label}.env`);

  if ("command" in entry) {
    return { args, command: entry.command, env, kind: "stdio", name };
  }

  if (lockedVersion === undefined) {
    throw new Error(`The package entry ${label} has no locked version.`);
  }

  const spec = `${entry.package.slice(PackagePrefix.length)}@${lockedVersion}`;

  return {
    args: [[{ kind: "text", text: "-y" }], [{ kind: "text", text: spec }], ...args],
    command: "npx",
    env,
    kind: "stdio",
    name,
  };
}

type EntryField = string | string[] | Record<string, string> | undefined;

/** A stable hash of a manifest entry. It changes when any field changes. */
export function hashEntry(entry: McpEntry) {
  const fields: [string, EntryField][] = Object.entries(entry);

  const canonical = fields
    .toSorted(byKey)
    .map(([key, value]) => [
      key,
      isTextTable(value) ? Object.entries(value).toSorted(byKey) : value,
    ]);

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function parseTable(table: Record<string, string> | undefined, label: string) {
  return Object.fromEntries(
    Object.entries(table ?? {}).map(([key, text]) => [key, parseEnvValue(text, `${label}.${key}`)])
  );
}

function isTextTable(value: EntryField): value is Record<string, string> {
  return value instanceof Object && !Array.isArray(value);
}

function byKey([left]: [string, ...unknown[]], [right]: [string, ...unknown[]]) {
  return left.localeCompare(right);
}
