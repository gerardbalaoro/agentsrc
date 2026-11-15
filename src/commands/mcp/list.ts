import { defineCommand } from "@crustjs/core";

import { CommonFlagDefs, JsonFlagDef, openWorkspace } from "#commands/flags.ts";
import { listServers } from "#mcp/index.ts";

export const ListCommand = defineCommand(
  "list",
  { aliases: ["ls"], description: "List MCP servers and their status" },
  (command) =>
    command.flags({ ...CommonFlagDefs, ...JsonFlagDef }).action(async ({ flags }) => {
      await listServers(await openWorkspace(flags), { json: flags.json ?? false });
    })
);
