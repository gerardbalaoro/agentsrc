import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { OperationError } from "#errors.ts";
import type { Adapter, HarnessSkill } from "#harness/registry.ts";
import { skillsDir } from "#scope.ts";
import type { Scope } from "#scope.ts";
import { readText } from "#util/read-text.ts";

/** Skills in `dir`: each sub-directory, or link to one, that holds a `SKILL.md`. */
export async function listSkillDirs(dir: string): Promise<HarnessSkill[]> {
  if (!existsSync(dir)) {
    return [];
  }

  const names = await readdir(dir);

  return names
    .toSorted()
    .filter((name) => existsSync(path.join(dir, name, "SKILL.md")))
    .map((name) => ({ dir: path.join(dir, name), name }));
}

export async function findSkillDir(dir: string, name: string) {
  const target = path.join(dir, name);

  const stats = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return;
    }

    throw error;
  });

  return stats === undefined ? undefined : { dir: target, name };
}

/**
 * The skills operations for a harness that has its own skill directory. A skill is a relative
 * link to the canonical copy, or a copy when the skill asks for one or linking fails.
 */
export function createLinkedSkills(getDir: (scope: Scope) => string): Adapter["skills"] {
  return {
    directory: getDir,
    async add(scope, skill) {
      const target = path.join(getDir(scope), skill.name);
      const existing = await findSkillDir(getDir(scope), skill.name);

      if (existing !== undefined && !skill.force && !(await isOwnedSkill(target, skill.dir))) {
        throw new OperationError(
          `Cannot replace unmanaged skill ${target}. Use --force to take it over.`
        );
      }

      await mkdir(path.dirname(target), { recursive: true });
      await rm(target, { force: true, recursive: true });

      if (skill.copy) {
        await copySkill(skill.dir, target);

        return;
      }

      try {
        await linkDirectory(skill.dir, target);
      } catch {
        // Some filesystems and Windows accounts cannot create links. skills.sh copies then, too.
        await copySkill(skill.dir, target);
      }
    },

    find: (scope, name) => findSkillDir(getDir(scope), name),

    list: (scope) => listSkillDirs(getDir(scope)),

    async remove(scope, name) {
      const target = path.join(getDir(scope), name);
      const canonical = path.join(skillsDir(scope), name);

      if (await isOwnedSkill(target, canonical)) {
        // `rm` on a link removes the link, not its target.
        await rm(target, { force: true, recursive: true });
      }
    },
  };
}

/** Ownership survives edits to a copy, and dangling links can still be identified. */
export async function isOwnedSkill(target: string, canonical: string) {
  if (path.resolve(target) === path.resolve(canonical)) {
    return true;
  }

  const stats = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return;
    }

    throw error;
  });

  if (stats === undefined) {
    return false;
  }

  if (stats.isSymbolicLink()) {
    return path.resolve(path.dirname(target), await readlink(target)) === path.resolve(canonical);
  }

  if (!stats.isDirectory()) {
    return false;
  }

  const marker = await readText(path.join(target, "metadata.json"));

  return marker === ownershipMarker(target, canonical);
}

async function copySkill(source: string, target: string) {
  await cp(source, target, { recursive: true });
  // skills.sh excludes metadata.json from content hashes and copied source files.
  await writeFile(path.join(target, "metadata.json"), ownershipMarker(target, source));
}

function ownershipMarker(target: string, canonical: string) {
  return JSON.stringify({
    agentsrc: 1,
    canonical: path.relative(target, canonical).split(path.sep).join("/"),
  });
}

/** True when `target` is a link, as opposed to a copied directory. */
export async function isLink(target: string) {
  try {
    const stats = await lstat(target);

    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

async function linkDirectory(source: string, target: string) {
  if (process.platform === "win32") {
    // A junction needs no elevated rights, but it must point to an absolute path.
    await symlink(path.resolve(source), target, "junction");

    return;
  }

  await symlink(path.relative(path.dirname(target), source), target);
}
