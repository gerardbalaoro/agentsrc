import { validateManifest } from "#manifest/schema.ts";
import type { Manifest } from "#manifest/schema.ts";
import { parseToml } from "#util/toml-edit.ts";

/** Where a manifest lives: a file on disk, or a URL. */
export type ManifestLocation = { kind: "file"; path: string } | { kind: "url"; url: string };

export function describeLocation(location: ManifestLocation) {
  return location.kind === "file" ? location.path : location.url;
}

export function parseManifest(text: string, location: ManifestLocation): Manifest {
  const label = describeLocation(location);

  return validateManifest(parseToml(text, label), label);
}
