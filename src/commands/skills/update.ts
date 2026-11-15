import { defineCommand } from "@crustjs/core";

import { CommonFlagDefs, openWorkspace } from "#commands/flags.ts";
import { updateSkills } from "#skills/index.ts";

export const UpdateCommand = defineCommand(
  "update",
  { aliases: ["up"], description: "Fetch skills again and reinstall the ones that changed" },
  (command) =>
    command
      .args({
        description: "Skills to update. Default: all.",
        name: "names",
        type: "string",
        variadic: true,
      })
      .flags(CommonFlagDefs)
      .action(async ({ args, flags }) => {
        await updateSkills(await openWorkspace(flags), args.names ?? []);
      })
);
