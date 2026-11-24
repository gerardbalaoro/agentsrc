import { UsageError } from "#errors.ts";
import type { McpEntry } from "#manifest/schema.ts";
import { formatEnvValue, parseEnvValue } from "#mcp/env.ts";

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
const HttpScheme = /^https?:\/\//iu;
const NpmPackageName = /^(?:@[^/@:\s]+\/)?[^/@:\s]+$/u;

export function hasServerSourcePrefix(spec: string) {
  return spec.startsWith(PackagePrefix) || HttpScheme.test(spec);
}

/** Identifies a source type from a prefix that has no package name or host yet. */
export function incompleteServerSource(spec: string) {
  if (spec === PackagePrefix) {
    return "package";
  }

  return HttpScheme.exec(spec)?.[0] === spec ? "url" : undefined;
}

/** Checks the URL structure without expanding or changing its environment references. */
export function validateServerUrl(url: string) {
  const sample = formatEnvValue(parseEnvValue(url, "URL"), {
    reference: () => "1",
    text: (literal) => literal,
  });

  if (!HttpScheme.test(url) || !URL.canParse(sample)) {
    throw new UsageError("Enter a valid HTTP or HTTPS URL.");
  }
}

/** The source is known, but the caller must supply a name. */
export class MissingMcpNameError extends UsageError {
  override name = "MissingMcpNameError";
}

/** Converts `mcp add` arguments to a server name and a manifest entry. */
export function parseAddRequest(request: AddRequest): NamedEntry {
  const [command, ...args] = request.command;

  if (command !== undefined) {
    rejectFlags(request, ["headers", "transport"], "a command");
    const name = request.name ?? request.spec;

    if (name.trim() === "") {
      throw new MissingMcpNameError("Pass a server name before `--`, or use --name.");
    }

    return {
      entry: { command, ...withEntries("args", args), ...withEntries("env", request.env) },
      name,
    };
  }

  if (HttpScheme.test(request.spec)) {
    rejectFlags(request, ["env"], "a URL");
    validateServerUrl(request.spec);
    const name = request.name ?? getHostName(request.spec);
    const entry: McpEntry = { url: request.spec, ...withEntries("headers", request.headers) };

    return { entry: request.transport ? { ...entry, transport: request.transport } : entry, name };
  }

  rejectFlags(request, ["headers", "transport"], "a package");
  const { packageName, range } = parsePackageSpec(request.spec);

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
export function parsePackageSpec(spec: string) {
  const text = spec.startsWith(PackagePrefix) ? spec.slice(PackagePrefix.length) : spec;
  // The `@` of a scope is at index 0, so a version separator is any later `@`.
  const separator = text.lastIndexOf("@");
  const hasRange = separator > 0;
  const packageName = hasRange ? text.slice(0, separator) : text;
  const range = hasRange ? text.slice(separator + 1) : undefined;

  if (!NpmPackageName.test(packageName)) {
    throw new UsageError(`\`${spec}\` is not a package name.`);
  }

  if (range !== undefined && !range.trim()) {
    throw new UsageError("Enter a version range after @, or omit @ to use the latest version.");
  }

  return { packageName, range };
}

/** The package's base name without `mcp-`, `-mcp` or `server-`. */
function getPackageBaseName(packageName: string) {
  const base = packageName.slice(packageName.lastIndexOf("/") + 1);

  const name = base
    .replace(/^(?:server-|mcp-)+/u, "")
    .replace(/-mcp(?:-server)?$/u, "")
    .replace(/^(?:server-|mcp-)+/u, "");

  if (name === "") {
    throw new MissingMcpNameError(`Cannot derive a server name from ${packageName}. Pass --name.`);
  }

  return name;
}

/** The first hostname label that is not `mcp`, `api` or `www`. */
function getHostName(url: string) {
  const hostname = URL.parse(url)?.hostname;
  const name = hostname?.split(".").find((label) => label && !GenericHostLabels.has(label));

  if (name === undefined) {
    throw new MissingMcpNameError(
      `Cannot derive a server name from ${hostname ?? "the URL"}. Pass --name.`
    );
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
