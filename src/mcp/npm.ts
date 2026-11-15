import semver from "semver";
import { z } from "zod";

import { OperationError } from "#errors.ts";

const DefaultRegistry = "https://registry.npmjs.org";
const DefaultRange = "latest";

// The abbreviated metadata document: only what an installer needs.
const AbbreviatedMetadata = "application/vnd.npm.install-v1+json";

const PackumentSchema = z.object({
  "dist-tags": z.record(z.string(), z.string()).default({}),
  versions: z.record(z.string(), z.object({})).default({}),
});

/**
 * Resolves a semver range or a dist-tag to one published version. With no range, the result is
 * the `latest` tag.
 */
export async function resolveVersion(name: string, range = DefaultRange) {
  const packument = await fetchPackument(name);
  const tagged = packument["dist-tags"][range];

  if (tagged !== undefined) {
    return tagged;
  }

  const version = semver.maxSatisfying(Object.keys(packument.versions), range);

  if (version === null) {
    throw new OperationError(`No published version of ${name} matches \`${range}\`.`);
  }

  return version;
}

/** True when a locked version still satisfies the manifest's range, so it can be kept. */
export function isVersionInRange(version: string, range: string | undefined) {
  // With no range, the entry stays on the version it was first locked to.
  return range === undefined || semver.satisfies(version, range);
}

async function fetchPackument(name: string) {
  const registry = (process.env.npm_config_registry ?? DefaultRegistry).replace(/\/+$/u, "");
  // A scoped name keeps its `@` and encodes only the slash, as the registry expects.
  const url = `${registry}/${name.replace("/", "%2F")}`;
  const response = await fetchRegistry(url, name);

  if (response.status === 404) {
    throw new OperationError(`The npm package ${name} does not exist.`);
  }

  if (!response.ok) {
    throw new OperationError(`The npm registry answered ${response.status} for ${name}.`);
  }

  const result = PackumentSchema.safeParse(await response.json());

  if (!result.success) {
    throw new OperationError(`The npm registry returned an unreadable document for ${name}.`);
  }

  return result.data;
}

async function fetchRegistry(url: string, name: string) {
  try {
    return await fetch(url, { headers: { accept: AbbreviatedMetadata } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new OperationError(`Cannot reach the npm registry to resolve ${name}: ${reason}`);
  }
}
