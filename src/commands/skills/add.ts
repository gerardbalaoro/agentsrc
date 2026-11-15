import { defineCommand } from "@crustjs/core";
import type { FlagsDef } from "@crustjs/core";

import { CommonFlagDefs, ForceFlagDef, openWorkspace } from "#commands/flags.ts";
import { UsageError } from "#errors.ts";
import { addSkills } from "#skills/index.ts";

/** Flags that choose skills from a source. `install <source>` accepts them too. */
export const AddSkillFlagDefs = {
  copy: { description: "Copy into each harness directory instead of linking", type: "boolean" },
  list: {
    description: "List the skills in the source. Install nothing.",
    short: "l",
    type: "boolean",
  },
  rename: { description: "Install one selected skill under another name", type: "string" },
  skill: {
    description: "Skills to take from the source. '*' selects all. Repeatable.",
    multiple: true,
    short: "s",
    type: "string",
  },
} as const satisfies FlagsDef;

interface AddSkillFlags {
  copy: boolean | undefined;
  force?: boolean | undefined;
  list: boolean | undefined;
  rename: string | undefined;
  skill: string[] | undefined;
}

/** Builds the options of `skills add <source>` and of `skills install <source>`. */
export function toAddOptions(flags: AddSkillFlags) {
  return {
    copy: flags.copy ?? false,
    force: flags.force ?? false,
    list: flags.list ?? false,
    rename: flags.rename,
    skills: flags.skill,
  };
}

export const AddCommand = defineCommand(
  "add",
  { description: "Add skills from a source to the manifest and install them" },
  (command) =>
    command
      .args({
        description: "owner/repo, a git URL, a local path, or a SKILL.md or archive URL",
        name: "source",
        type: "string",
      })
      .flags({ ...CommonFlagDefs, ...ForceFlagDef, ...AddSkillFlagDefs })
      .action(async ({ args, flags }) => {
        if (args.source === undefined) {
          throw new UsageError("`skills add` needs a source.");
        }

        await addSkills(await openWorkspace(flags), args.source, toAddOptions(flags));
      })
);
