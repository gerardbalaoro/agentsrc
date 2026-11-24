import { defineCommand } from "@crustjs/core";

import { createAddCommand } from "#commands/mcp/add.ts";
import { InstallCommand } from "#commands/mcp/install.ts";
import { ListCommand } from "#commands/mcp/list.ts";
import { RemoveCommand } from "#commands/mcp/remove.ts";
import { UpdateCommand } from "#commands/mcp/update.ts";

export function createMcpCommand(argv: string[]) {
  const separator = argv.indexOf("--");
  const tail = separator === -1 ? undefined : argv.slice(separator + 1);

  return defineCommand("mcp", { description: "Manage MCP servers" }, (command) =>
    command.add(InstallCommand, createAddCommand(tail), UpdateCommand, ListCommand, RemoveCommand)
  );
}
