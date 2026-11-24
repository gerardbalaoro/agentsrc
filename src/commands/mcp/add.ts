import { defineCommand } from "@crustjs/core";
import type { FlagsDef } from "@crustjs/core";

import { CommonFlagDefs, ForceFlagDef, openWorkspace } from "#commands/flags.ts";
import { completeAddRequest } from "#commands/mcp/prompt.ts";
import { addServer } from "#mcp/index.ts";
import { hasServerSourcePrefix, parsePairs } from "#mcp/spec.ts";
import type { AddRequest } from "#mcp/spec.ts";
import { Ui } from "#ui.ts";

/** Flags that describe the server to add. `install <spec>` accepts them too. */
export const AddServerFlagDefs = {
  env: {
    description: "Set KEY=VALUE for an npm package or local command. Repeatable.",
    multiple: true,
    short: "e",
    type: "string",
  },
  header: {
    description: "HTTP header as KEY=VALUE for a URL. Repeatable.",
    multiple: true,
    type: "string",
  },
  name: { description: "Override the server name", type: "string" },
  transport: {
    choices: ["http", "sse"],
    description: "Transport for a URL (default: http)",
    type: "string",
  },
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

export function createAddCommand(tail: string[] | undefined) {
  return defineCommand(
    "add",
    {
      description: "Add an MCP server to the manifest and install it",
      sections: [
        {
          body: [
            "arc mcp add npm:@upstash/context7-mcp",
            "arc mcp add https://mcp.example.com/mcp --name remote-tools",
            "arc mcp add local-tools -- node ./server.js",
            "",
            "The npm: prefix is optional.",
            "For a local command, put arc options before -- and command arguments after the executable.",
            "Run arc mcp add without a source to enter server details in a terminal.",
          ].join("\n"),
          title: "Examples",
        },
      ],
      usage: [
        "arc mcp add [options]",
        "arc mcp add <npm-package> [options]",
        "arc mcp add <url> [options]",
        "arc mcp add <name> [options] -- <command> [args...]",
      ].join("\n  "),
    },
    (command) =>
      command
        .args({
          description: "An npm package, an HTTP(S) URL, or a local server name",
          name: "spec",
          type: "string",
        })
        .flags({ ...CommonFlagDefs, ...ForceFlagDef, ...AddServerFlagDefs })
        .action(async ({ args, flags, rawArgs, signal }) => {
          const { spec, command: commandArgs } = resolveAddInput(args.spec ?? "", rawArgs, tail);
          const request = toAddRequest(spec, commandArgs ?? [], flags);

          const server = await completeAddRequest(request, {
            canPrompt: !flags.yes && Ui.isInteractive(),
            isCommand: commandArgs !== undefined,
            signal,
          });

          if (server === null) {
            Ui.info("MCP add canceled.");

            return;
          }

          const workspace = await openWorkspace(flags);
          await addServer(workspace, server, { force: flags.force ?? false });
        })
  );
}

function resolveAddInput(spec: string, rawArgs: string[], tail: string[] | undefined) {
  if (tail === undefined || (rawArgs.length === 0 && hasServerSourcePrefix(spec))) {
    return { spec, command: undefined };
  }

  // Crust consumes the first token after -- as the spec when no positional comes before --.
  const name = rawArgs.length === tail.length ? spec : "";

  return { spec: name, command: tail };
}
