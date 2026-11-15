import type { FlagsDef } from "@crustjs/core";

import { UsageError } from "#errors.ts";
import { HarnessIds } from "#harness/ids.ts";
import type { HarnessId } from "#harness/ids.ts";
import { loadWorkspace } from "#workspace.ts";

/** Flags that every command accepts. */
export const CommonFlagDefs = {
  agent: {
    description: `Limit the run to these harnesses: ${HarnessIds.join(", ")}`,
    multiple: true,
    short: "a",
    type: "string",
  },
  "dry-run": { description: "Print the plan. Write nothing.", type: "boolean" },
  global: { description: "Use global scope", short: "g", type: "boolean" },
  yes: { description: "Skip confirmation prompts", short: "y", type: "boolean" },
} as const satisfies FlagsDef;

/** Flags of `sync` and `install`. */
export const InstallFlagDefs = {
  force: {
    description: "Reinstall everything. Replace unmanaged MCP entries of the same name.",
    type: "boolean",
  },
  "frozen-lockfile": {
    description: "Fail if anything is out of date, and write nothing. Default when CI is set.",
    type: "boolean",
  },
} as const satisfies FlagsDef;

export const ForceFlagDef = {
  force: { description: "Replace an entry of the same name", type: "boolean" },
} as const satisfies FlagsDef;

export const JsonFlagDef = {
  json: { description: "Machine-readable output", type: "boolean" },
} as const satisfies FlagsDef;

interface ParsedFlags {
  agent: string[] | undefined;
  "dry-run": boolean | undefined;
  global: boolean | undefined;
  yes: boolean | undefined;
  "frozen-lockfile"?: boolean | undefined;
}

/**
 * Loads the workspace for a command. Only `sync` and `install` pass `frozen-lockfile`; for them
 * the default is frozen when `CI` is set.
 */
export async function openWorkspace(flags: ParsedFlags) {
  const isInstall = "frozen-lockfile" in flags;
  const frozen = flags["frozen-lockfile"] ?? (isInstall && Boolean(process.env.CI));

  return await loadWorkspace({
    agents: parseAgents(flags.agent),
    dryRun: flags["dry-run"] ?? false,
    frozen,
    global: flags.global ?? false,
    yes: flags.yes ?? false,
  });
}

/** `--agent` accepts repeated flags and comma-separated ids. */
export function parseAgents(values: string[] | undefined): HarnessId[] | undefined {
  if (values === undefined || values.length === 0) {
    return undefined;
  }

  const ids = values.flatMap((value) => value.split(",")).map((id) => id.trim());

  return ids.map((id) => {
    const known = HarnessIds.find((harness) => harness === id);

    if (known === undefined) {
      throw new UsageError(`Unknown harness \`${id}\`. Known harnesses: ${HarnessIds.join(", ")}.`);
    }

    return known;
  });
}
