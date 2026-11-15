import { defineCommand } from "@crustjs/core";

import { CommonFlagDefs, InstallFlagDefs, openWorkspace } from "#commands/flags.ts";
import { AddSkillFlagDefs, toAddOptions } from "#commands/skills/add.ts";
import { addSkills, installSkills } from "#skills/index.ts";

export const InstallCommand = defineCommand(
  "install",
  {
    aliases: ["i"],
    description: "Install skills from the manifest. With an argument, the same as `add`.",
  },
  (command) =>
    command
      .args({ description: "A source to add first", name: "source", type: "string" })
      .flags({ ...CommonFlagDefs, ...InstallFlagDefs, ...AddSkillFlagDefs })
      .action(async ({ args, flags }) => {
        if (args.source === undefined) {
          await installSkills(await openWorkspace(flags), { force: flags.force ?? false });

          return;
        }

        // Adding edits the manifest, so it is never a frozen run.
        const workspace = await openWorkspace({ ...flags, "frozen-lockfile": false });
        await addSkills(workspace, args.source, toAddOptions(flags));
      })
);
