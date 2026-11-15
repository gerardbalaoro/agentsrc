import { defineCommand } from "@crustjs/core";

import { CommonFlagDefs, InstallFlagDefs, openWorkspace } from "#commands/flags.ts";
import { AddServerFlagDefs, toAddRequest } from "#commands/mcp/add.ts";
import { addServer, installServers } from "#mcp/index.ts";

export const InstallCommand = defineCommand(
  "install",
  {
    aliases: ["i"],
    description: "Install MCP servers from the manifest. With an argument, the same as `add`.",
  },
  (command) =>
    command
      .args({ description: "A server to add first", name: "spec", type: "string" })
      .flags({ ...CommonFlagDefs, ...InstallFlagDefs, ...AddServerFlagDefs })
      .action(async ({ args, flags, rawArgs }) => {
        const force = flags.force ?? false;

        if (args.spec === undefined) {
          await installServers(await openWorkspace(flags), { force });

          return;
        }

        // Adding edits the manifest, so it is never a frozen run.
        const workspace = await openWorkspace({ ...flags, "frozen-lockfile": false });
        await addServer(workspace, toAddRequest(args.spec, rawArgs, flags), { force });
      })
);
