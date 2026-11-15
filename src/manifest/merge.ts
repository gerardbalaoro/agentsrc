import path from "node:path";

import { UsageError } from "#errors.ts";
import type { HarnessId } from "#harness/ids.ts";
import type { Layer } from "#manifest/extends.ts";
import type { ManifestLocation } from "#manifest/load.ts";
import type { McpEntry, SkillEntry } from "#manifest/schema.ts";
import { isLocalPath, resolveLocalPath } from "#util/local-path.ts";

/** An entry, and the manifest that declared it. */
export interface Declared<Entry> {
  entry: Entry;
  declaredIn: ManifestLocation;
}

/** The result of applying every layer. Disabled entries are gone. */
export interface ResolvedManifest {
  /** Unset when no layer sets `agents`. */
  agents: HarnessId[] | undefined;
  skills: Record<string, Declared<SkillEntry>>;
  mcp: Record<string, Declared<McpEntry>>;
}

/** Applies layers in order. A later layer replaces a whole entry of the same name. */
export function mergeLayers(layers: Layer[]): ResolvedManifest {
  const skills = new Map<string, Declared<SkillEntry>>();
  const mcp = new Map<string, Declared<McpEntry>>();
  let agents: HarnessId[] | undefined;

  for (const layer of layers) {
    agents = layer.manifest.agents ?? agents;
    applyEntries(mcp, layer.manifest.mcp, layer.location);
    applyEntries(skills, anchorSkillSources(layer), layer.location);
  }

  return { agents, mcp: Object.fromEntries(mcp), skills: Object.fromEntries(skills) };
}

function applyEntries<Entry>(
  target: Map<string, Declared<Entry>>,
  entries: Record<string, Entry | false>,
  declaredIn: ManifestLocation
) {
  for (const [name, entry] of Object.entries(entries)) {
    if (entry === false) {
      target.delete(name);
    } else {
      target.set(name, { declaredIn, entry });
    }
  }
}

/** Makes each local skill source absolute, relative to the manifest that declares it. */
function anchorSkillSources(layer: Layer): Record<string, SkillEntry | false> {
  const entries = Object.entries(layer.manifest.skills).map(([name, entry]) => {
    if (entry === false || !isLocalPath(entry.source)) {
      return [name, entry] as const;
    }

    if (layer.location.kind === "url") {
      throw new UsageError(
        `The remote manifest ${layer.location.url} uses the local path ${entry.source} for the skill ${name}. A remote manifest cannot use a local path.`
      );
    }

    const base = path.dirname(layer.location.path);

    return [name, { ...entry, source: resolveLocalPath(entry.source, base) }] as const;
  });

  return Object.fromEntries(entries);
}
