import { defineCommand } from "@crustjs/core";

import { CommonFlagDefs, parseAgents } from "#commands/flags.ts";
import { initialize } from "#init/index.ts";

export const InitCommand = defineCommand(
  "init",
  { description: "Create agents.toml and choose existing skills and MCP servers to import" },
  (command) =>
    command
      .flags({
        ...CommonFlagDefs,
        skill: {
          type: "string",
          multiple: true,
          short: "s",
          description: "Import a skill name or origin:name; '*' selects all",
        },
        mcp: {
          type: "string",
          multiple: true,
          description: "Import an MCP name or harness:name; '*' selects all",
        },
        list: {
          type: "boolean",
          short: "l",
          description: "Show detected harnesses and import candidates without writing",
        },
      })
      .action(async ({ flags }) => {
        await initialize({
          global: flags.global ?? false,
          agents: parseAgents(flags.agent),
          yes: flags.yes ?? false,
          dryRun: flags["dry-run"] ?? false,
          list: flags.list ?? false,
          skills: flags.skill,
          mcp: flags.mcp,
        });
      })
);
