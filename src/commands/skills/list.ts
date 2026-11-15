import { defineCommand } from "@crustjs/core";

import { CommonFlagDefs, JsonFlagDef, openWorkspace } from "#commands/flags.ts";
import { listSkills } from "#skills/index.ts";

export const ListCommand = defineCommand(
  "list",
  { aliases: ["ls"], description: "List skills and their status" },
  (command) =>
    command.flags({ ...CommonFlagDefs, ...JsonFlagDef }).action(async ({ flags }) => {
      await listSkills(await openWorkspace(flags), { json: flags.json ?? false });
    })
);
