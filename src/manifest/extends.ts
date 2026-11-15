import { createHash } from "node:crypto";
import path from "node:path";

import { OperationError, UsageError } from "#errors.ts";
import { describeLocation, parseManifest } from "#manifest/load.ts";
import type { ManifestLocation } from "#manifest/load.ts";
import type { Manifest } from "#manifest/schema.ts";
import { writeFileAtomic } from "#util/atomic-write.ts";
import { cacheDir } from "#util/cache.ts";
import { resolveLocalPath } from "#util/local-path.ts";
import { readText } from "#util/read-text.ts";

const MaxDepth = 8;

export interface Layer {
  location: ManifestLocation;
  manifest: Manifest;
}

export interface Layers {
  /** Lowest precedence first. The last layer is the scope's own manifest. */
  layers: Layer[];
  /** SHA-256 of every remote manifest that was read, by URL. */
  remoteHashes: Record<string, string>;
}

/** Where remote manifests come from: the network, or the cached copies that the lock pins. */
export type RemoteSource = "network" | "lock";

interface Reading {
  lockedHashes: Record<string, string>;
  remoteHashes: Record<string, string>;
  source: RemoteSource;
}

/**
 * Reads a manifest and everything it extends.
 *
 * `lockedHashes` lets an offline run reuse the cached copy that the lock pins. This function does
 * not compare hashes with the lock; the caller decides what a changed remote manifest means.
 */
export async function resolveLayers(
  file: string,
  lockedHashes: Record<string, string>,
  source: RemoteSource
): Promise<Layers> {
  const reading: Reading = { lockedHashes, remoteHashes: {}, source };
  const layers = await readLayers({ kind: "file", path: file }, [], reading);

  return { layers, remoteHashes: reading.remoteHashes };
}

async function readLayers(
  location: ManifestLocation,
  ancestors: string[],
  reading: Reading
): Promise<Layer[]> {
  const id = describeLocation(location);

  if (ancestors.includes(id)) {
    throw new UsageError(`\`extends\` forms a cycle: ${[...ancestors, id].join(" -> ")}`);
  }

  if (ancestors.length > MaxDepth) {
    throw new UsageError(`\`extends\` is nested more than ${MaxDepth} levels deep at ${id}.`);
  }

  const isRoot = ancestors.length === 0;
  const text = await readManifestText(location, isRoot, reading);
  const manifest = parseManifest(text, location);
  const inherited: Layer[] = [];

  for (const item of manifest.extends) {
    const next = resolveItem(item, location);
    // Sequential on purpose: the order of layers is the order of `extends`.
    // oxlint-disable-next-line no-await-in-loop
    const layers = await readLayers(next, [...ancestors, id], reading);
    inherited.push(...layers);
  }

  return [...inherited, { location, manifest }];
}

function resolveItem(item: string, declaredIn: ManifestLocation): ManifestLocation {
  if (/^https?:\/\//iu.test(item)) {
    return { kind: "url", url: item };
  }

  if (declaredIn.kind === "file") {
    return { kind: "file", path: resolveLocalPath(item, path.dirname(declaredIn.path)) };
  }

  const isLocal = item.startsWith("/") || item.startsWith("~") || /^[A-Za-z]:[\\/]/u.test(item);

  if (isLocal) {
    throw new UsageError(
      `The remote manifest ${declaredIn.url} extends the local path ${item}. A remote manifest can extend only URLs.`
    );
  }

  return { kind: "url", url: new URL(item, declaredIn.url).href };
}

async function readManifestText(location: ManifestLocation, isRoot: boolean, reading: Reading) {
  if (location.kind === "url") {
    const lockedHash = reading.lockedHashes[location.url];

    const text =
      reading.source === "lock"
        ? await readPinned(location.url, lockedHash)
        : await fetchRemote(location.url, lockedHash);

    reading.remoteHashes[location.url] = sha256(text);

    return text;
  }

  const text = await readText(location.path);

  if (text !== undefined) {
    return text;
  }

  // A scope with no manifest yet is an empty manifest. A missing extended file is a mistake.
  if (isRoot) {
    return "";
  }

  throw new UsageError(`The extended manifest ${location.path} does not exist.`);
}

async function fetchRemote(url: string, lockedHash: string | undefined) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    await writeFileAtomic(cachePath(sha256(text)), text);

    return text;
  } catch (error) {
    const cached = lockedHash ? await readText(cachePath(lockedHash)) : undefined;

    if (cached !== undefined) {
      return cached;
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new OperationError(`Cannot fetch the extended manifest ${url}: ${reason}`);
  }
}

async function readPinned(url: string, lockedHash: string | undefined) {
  const cached = lockedHash ? await readText(cachePath(lockedHash)) : undefined;

  if (cached === undefined) {
    throw new OperationError(`The locked copy of ${url} is not in the cache.`);
  }

  return cached;
}

function cachePath(hash: string) {
  return path.join(cacheDir(), "manifests", `${hash}.toml`);
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
