import type { Adapter } from "#harness/registry.ts";
import { findSkillDir, listSkillDirs } from "#harness/skill-dirs.ts";
import { skillsDir } from "#scope.ts";

/**
 * The skills operations for a harness that reads `.agents/skills` itself. The canonical copy is
 * already where the harness looks, so there is nothing to add or remove.
 */
export const UniversalSkills: Adapter["skills"] = {
  directory: skillsDir,
  async add() {
    // Nothing to do: the harness reads the canonical copy.
  },

  find: (scope, name) => findSkillDir(skillsDir(scope), name),

  list: (scope) => listSkillDirs(skillsDir(scope)),

  async remove() {
    // Nothing to do: removing the canonical copy removes the skill.
  },
};
