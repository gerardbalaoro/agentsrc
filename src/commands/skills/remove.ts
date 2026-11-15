import { defineCommand } from "@crustjs/core";

import { CommonFlagDefs, openWorkspace } from "#commands/flags.ts";
import { UsageError } from "#errors.ts";
import { removeSkills } from "#skills/index.ts";

export const RemoveCommand = defineCommand(
  "remove",
  { aliases: ["rm", "uninstall"], description: "Remove skills from the manifest and harnesses" },
  (command) =>
    command
      .args({ description: "Skills to remove", name: "names", type: "string", variadic: true })
      .flags(CommonFlagDefs)
      .action(async ({ args, flags }) => {
        const names = args.names ?? [];

        if (names.length === 0) {
          throw new UsageError("`skills remove` needs at least one skill name.");
        }

        await removeSkills(await openWorkspace(flags), names);
      })
);
