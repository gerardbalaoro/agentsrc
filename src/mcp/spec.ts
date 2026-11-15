import { UsageError } from "#errors.ts";
import type { McpEntry } from "#manifest/schema.ts";

/** The arguments of `arc mcp add`, before they become a manifest entry. */
export interface AddRequest {
  /** The positional argument: a server name, a URL, or a package. */
  spec: string;
  /** Everything after `--`. When present, `spec` is the server name. */
  command: string[];
  name: string | undefined;
  env: Record<string, string>;
  headers: Record<string, string>;
  transport: "http" | "sse" | undefined;
}

/** A manifest entry and the name it is stored under. */
export interface NamedEntry {
  name: string;
  entry: McpEntry;
}

const PackagePrefix = "npm:";
const GenericHostLabels = new Set(["api", "mcp", "www"]);

/** Converts `mcp add` arguments to a server name and a manifest entry. */
export function parseAddRequest(request: AddRequest): NamedEntry {
  const [command, ...args] = request.command;

  if (command !== undefined) {
    rejectFlags(request, ["headers", "transport"], "a command");

    return {
      entry: { command, ...withEntries("args", args), ...withEntries("env", request.env) },
      name: request.name ?? request.spec,
    };
  }

  if (/^https?:\/\//iu.test(request.spec)) {
    rejectFlags(request, ["env"], "a URL");
    const name = request.name ?? getHostName(request.spec);
    const entry: McpEntry = { url: request.spec, ...withEntries("headers", request.headers) };

    return { entry: request.transport ? { ...entry, transport: request.transport } : entry, name };
  }

  rejectFlags(request, ["headers", "transport"], "a package");
  const { packageName, range } = splitPackage(request.spec);

  const entry: McpEntry = {
    package: `${PackagePrefix}${packageName}`,
    ...withEntries("env", request.env),
  };

  return {
    entry: range ? { ...entry, version: range } : entry,
    name: request.name ?? getPackageBaseName(packageName),
  };
}

/** Splits `KEY=VALUE` flag values into a table. `flag` names the flag in the error message. */
export function parsePairs(pairs: string[], flag: string) {
  const entries = pairs.map((pair) => {
    const separator = pair.indexOf("=");

    if (separator < 1) {
      throw new UsageError(`${flag} needs KEY=VALUE, but got \`${pair}\`.`);
    }

    return [pair.slice(0, separator), pair.slice(separator + 1)];
  });

  return Object.fromEntries(entries);
}

/** `@scope/name@^1` becomes the name `@scope/name` and the range `^1`. */
function splitPackage(spec: string) {
  const text = spec.startsWith(PackagePrefix) ? spec.slice(PackagePrefix.length) : spec;
  // The `@` of a scope is at index 0, so a version separator is any later `@`.
  const separator = text.lastIndexOf("@");
  const hasRange = separator > 0;
  const packageName = hasRange ? text.slice(0, separator) : text;

  if (packageName === "") {
    throw new UsageError(`\`${spec}\` is not a package name.`);
  }

  return { packageName, range: hasRange ? text.slice(separator + 1) : undefined };
}

/** The package's base name without `mcp-`, `-mcp` or `server-`. */
function getPackageBaseName(packageName: string) {
  const base = packageName.slice(packageName.lastIndexOf("/") + 1);

  const name = base
    .replace(/^(?:server-|mcp-)+/u, "")
    .replace(/-mcp(?:-server)?$/u, "")
    .replace(/^(?:server-|mcp-)+/u, "");

  if (name === "") {
    throw new UsageError(`Cannot derive a server name from ${packageName}. Pass --name.`);
  }

  return name;
}

/** The first hostname label that is not `mcp`, `api` or `www`. */
function getHostName(url: string) {
  const labels = URL.canParse(url) ? new URL(url).hostname.split(".") : [];
  const name = labels.find((label) => !GenericHostLabels.has(label));

  if (name === undefined) {
    throw new UsageError(`Cannot derive a server name from ${url}. Pass --name.`);
  }

  return name;
}

function rejectFlags(
  request: AddRequest,
  flags: ("env" | "headers" | "transport")[],
  kind: string
) {
  const flagNames = { env: "--env", headers: "--header", transport: "--transport" };

  const used = flags.filter((flag) => {
    const value = request[flag];

    return value !== undefined && Object.keys(value).length > 0;
  });

  if (used.length > 0) {
    const names = used.map((flag) => flagNames[flag]).join(", ");

    throw new UsageError(`${names} does not apply to ${kind}.`);
  }
}

/** Leaves an empty list or table out of the entry. */
function withEntries(key: string, value: string[] | Record<string, string>) {
  return Object.keys(value).length === 0 ? {} : { [key]: value };
}
