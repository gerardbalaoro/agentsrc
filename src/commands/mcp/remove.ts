import { defineCommand } from "@crustjs/core";

import { CommonFlagDefs, openWorkspace } from "#commands/flags.ts";
import { UsageError } from "#errors.ts";
import { removeServers } from "#mcp/index.ts";

export const RemoveCommand = defineCommand(
  "remove",
  {
    aliases: ["rm", "uninstall"],
    description: "Remove MCP servers from the manifest and harnesses",
  },
  (command) =>
    command
      .args({ description: "Servers to remove", name: "names", type: "string", variadic: true })
      .flags(CommonFlagDefs)
      .action(async ({ args, flags }) => {
        const names = args.names ?? [];

        if (names.length === 0) {
          throw new UsageError("`mcp remove` needs at least one server name.");
        }

        await removeServers(await openWorkspace(flags), names);
      })
);
