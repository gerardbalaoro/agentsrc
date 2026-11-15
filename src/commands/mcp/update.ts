import { defineCommand } from "@crustjs/core";

import { CommonFlagDefs, openWorkspace } from "#commands/flags.ts";
import { updateServers } from "#mcp/index.ts";

export const UpdateCommand = defineCommand(
  "update",
  { aliases: ["up"], description: "Move package servers to the newest version in range" },
  (command) =>
    command
      .args({
        description: "Servers to update. Default: all.",
        name: "names",
        type: "string",
        variadic: true,
      })
      .flags(CommonFlagDefs)
      .action(async ({ args, flags }) => {
        await updateServers(await openWorkspace(flags), args.names ?? []);
      })
);
