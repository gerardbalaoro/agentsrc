import { realpath } from "node:fs/promises";
import path from "node:path";

import { OperationError, UsageError } from "#errors.ts";
import { AllAdapters } from "#harness/registry.ts";
import { listSkillDirs } from "#harness/skill-dirs.ts";
import { UniversalSkills } from "#harness/universal.ts";
import { readSkillsLock } from "#lock/skills-lock.ts";
import type { LockedSkill } from "#lock/skills-lock.ts";
import type { McpEntry, SkillEntry } from "#manifest/schema.ts";
import { createServer } from "#mcp/entry.ts";
import { manifestPath, skillsDir } from "#scope.ts";
import type { Scope } from "#scope.ts";
import { Ui } from "#ui.ts";

export interface ImportCandidate<Entry> {
  id: string;
  name: string;
  entry: Entry;
}

/** Read only the selected scope. No binaries, network requests or environment expansion. */
export async function discoverImports(scope: Scope) {
  const agents = AllAdapters.filter((adapter) => adapter.detect(scope)).map(
    (adapter) => adapter.id
  );

  const lock = await readSkillsLock(scope);
  const canonical = await listSkillDirs(skillsDir(scope));
  const skills: ImportCandidate<SkillEntry>[] = [];
  const seen = new Set<string>();

  for (const skill of canonical) {
    // oxlint-disable-next-line no-await-in-loop
    seen.add(await realpath(skill.dir));
    skills.push({
      id: `shared:${skill.name}`,
      name: skill.name,
      entry: skillEntry(scope, skill.dir, lock.skills[skill.name]),
    });
  }

  const mcp: ImportCandidate<McpEntry>[] = [];

  for (const adapter of AllAdapters) {
    if (adapter.skills !== UniversalSkills) {
      // oxlint-disable-next-line no-await-in-loop
      const installed = await adapter.skills.list(scope);

      for (const skill of installed) {
        // oxlint-disable-next-line no-await-in-loop
        const resolved = await realpath(skill.dir);

        if (seen.has(resolved)) {
          continue;
        }

        seen.add(resolved);
        skills.push({
          id: `${adapter.id}:${skill.name}`,
          name: skill.name,
          entry: { ...skillEntry(scope, skill.dir, lock.skills[skill.name]), agents: [adapter.id] },
        });
      }
    }

    // oxlint-disable-next-line no-await-in-loop
    const servers = await adapter.mcp.list(scope);

    for (const server of servers) {
      try {
        const entry = adapter.mcp.import(server);
        // Verify the inverse mapping preserves supported reference syntax before offering it.
        adapter.mcp.render(createServer(server.name, entry));
        mcp.push({
          id: `${adapter.id}:${server.name}`,
          name: server.name,
          entry: { ...entry, agents: [adapter.id] },
        });
      } catch (error) {
        if (!(error instanceof OperationError) && !(error instanceof UsageError)) {
          throw error;
        }

        Ui.warn(`Skipping ${adapter.id}:${server.name}: ${error.message}`);
      }
    }
  }

  return { agents, skills, mcp };
}

function skillEntry(scope: Scope, dir: string, locked: LockedSkill | undefined): SkillEntry {
  const source = locked === undefined ? relativeSource(scope, dir) : lockedSource(scope, locked);
  const entry: SkillEntry = { source };

  if (locked?.ref !== undefined) {
    entry.ref = locked.ref;
  }

  if (locked?.skillName !== undefined) {
    entry.skill = locked.skillName;
  }

  if (locked?.installMode === "copy") {
    entry.copy = true;
  }

  if (locked?.skillPath !== undefined) {
    entry.path = path.posix.dirname(locked.skillPath);
  }

  return entry;
}

function lockedSource(scope: Scope, locked: LockedSkill) {
  if (locked.sourceType === "local") {
    return relativeSource(scope, locked.source);
  }

  if (["github", "gitlab", "git", "download", "well-known"].includes(locked.sourceType)) {
    return locked.sourceUrl ?? locked.source;
  }

  throw new OperationError(`Cannot import skill source type ${locked.sourceType}.`);
}

function relativeSource(scope: Scope, dir: string) {
  const relative = path
    .relative(path.dirname(manifestPath(scope)), dir)
    .split(path.sep)
    .join("/");

  if (path.isAbsolute(relative)) {
    return relative;
  }

  return relative.startsWith(".") ? relative : `./${relative}`;
}
