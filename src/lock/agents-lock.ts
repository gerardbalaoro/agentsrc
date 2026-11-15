import { z } from "zod";

import { OperationError } from "#errors.ts";
import { agentsLockPath } from "#scope.ts";
import type { Scope } from "#scope.ts";
import { writeFileAtomic } from "#util/atomic-write.ts";
import { getValue } from "#util/config-value.ts";
import { parseJson } from "#util/json-edit.ts";
import { readText } from "#util/read-text.ts";

const Version = 1;

const AgentsLockSchema = z.object({
  extends: z.record(z.string(), z.object({ sha256: z.string() })).default({}),
  mcp: z
    .record(
      z.string(),
      z.object({
        hash: z.string(),
        package: z.string().optional(),
        version: z.string().optional(),
      })
    )
    .default({}),
  skills: z.array(z.string()).default([]),
  version: z.literal(Version),
});

/** What agentsrc manages in one scope. It holds no harness data. */
export type AgentsLock = z.infer<typeof AgentsLockSchema>;

export type LockedServer = AgentsLock["mcp"][string];

export function createAgentsLock(): AgentsLock {
  return { extends: {}, mcp: {}, skills: [], version: Version };
}

/** Reads the lock. Returns `undefined` when the scope has none. */
export async function readAgentsLock(scope: Scope): Promise<AgentsLock | undefined> {
  const file = agentsLockPath(scope);
  const text = await readText(file);

  if (text === undefined) {
    return undefined;
  }

  const value = parseJson(text, file);
  const version = getValue(value, ["version"]);

  if (version !== Version) {
    throw new OperationError(
      `${file} has lock version ${String(version)}. This agentsrc reads version ${Version} only.`
    );
  }

  const result = AgentsLockSchema.safeParse(value);

  if (!result.success) {
    throw new OperationError(`${file} is not a valid agentsrc lock.`);
  }

  return result.data;
}

export async function writeAgentsLock(scope: Scope, lock: AgentsLock) {
  const sorted: AgentsLock = {
    extends: sortKeys(lock.extends),
    mcp: sortKeys(lock.mcp),
    skills: lock.skills.toSorted(),
    version: Version,
  };

  await writeFileAtomic(agentsLockPath(scope), `${JSON.stringify(sorted, undefined, 2)}\n`);
}

function sortKeys<Value>(record: Record<string, Value>) {
  return Object.fromEntries(
    Object.entries(record).toSorted(([left], [right]) => left.localeCompare(right))
  );
}
