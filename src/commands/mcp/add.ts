import { defineCommand } from "@crustjs/core";
import type { FlagsDef } from "@crustjs/core";

import { CommonFlagDefs, ForceFlagDef, openWorkspace } from "#commands/flags.ts";
import { UsageError } from "#errors.ts";
import { addServer } from "#mcp/index.ts";
import { parsePairs } from "#mcp/spec.ts";
import type { AddRequest } from "#mcp/spec.ts";

/** Flags that describe the server to add. `install <spec>` accepts them too. */
export const AddServerFlagDefs = {
  env: {
    description: "Environment variable as KEY=VALUE. Repeatable.",
    multiple: true,
    short: "e",
    type: "string",
  },
  header: { description: "HTTP header as KEY=VALUE. Repeatable.", multiple: true, type: "string" },
  name: { description: "Server name. Required when it cannot be derived.", type: "string" },
  transport: { choices: ["http", "sse"], description: "For URL servers", type: "string" },
} as const satisfies FlagsDef;

interface AddServerFlags {
  env: string[] | undefined;
  header: string[] | undefined;
  name: string | undefined;
  transport: "http" | "sse" | undefined;
}

/** Builds the request of `mcp add <spec>` and of `mcp install <spec>`. */
export function toAddRequest(spec: string, command: string[], flags: AddServerFlags): AddRequest {
  return {
    command,
    env: parsePairs(flags.env ?? [], "--env"),
    headers: parsePairs(flags.header ?? [], "--header"),
    name: flags.name,
    spec,
    transport: flags.transport,
  };
}

export const AddCommand = defineCommand(
  "add",
  { description: "Add an MCP server to the manifest and install it" },
  (command) =>
    command
      .args({
        description: "A package, a URL, or a name followed by `-- <command> [args...]`",
        name: "spec",
        type: "string",
      })
      .flags({ ...CommonFlagDefs, ...ForceFlagDef, ...AddServerFlagDefs })
      .action(async ({ args, flags, rawArgs }) => {
        if (args.spec === undefined) {
          throw new UsageError("`mcp add` needs a package, a URL, or a name and a command.");
        }

        const workspace = await openWorkspace(flags);
        const request = toAddRequest(args.spec, rawArgs, flags);
        await addServer(workspace, request, { force: flags.force ?? false });
      })
);
