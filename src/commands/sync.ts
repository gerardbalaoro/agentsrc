import { defineCommand } from "@crustjs/core";

import { CommonFlagDefs, InstallFlagDefs, openWorkspace } from "#commands/flags.ts";
import { installServers } from "#mcp/index.ts";
import { installSkills } from "#skills/index.ts";

export const SyncCommand = defineCommand(
  "sync",
  { description: "Install skills, then MCP servers, from the manifest" },
  (command) =>
    command.flags({ ...CommonFlagDefs, ...InstallFlagDefs }).action(async ({ flags }) => {
      const workspace = await openWorkspace(flags);
      const options = { force: flags.force ?? false };
      await installSkills(workspace, options);
      await installServers(workspace, options);
    })
);
