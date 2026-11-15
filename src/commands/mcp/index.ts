import { defineCommand } from "@crustjs/core";

import { AddCommand } from "#commands/mcp/add.ts";
import { InstallCommand } from "#commands/mcp/install.ts";
import { ListCommand } from "#commands/mcp/list.ts";
import { RemoveCommand } from "#commands/mcp/remove.ts";
import { UpdateCommand } from "#commands/mcp/update.ts";

export const McpCommand = defineCommand("mcp", { description: "Manage MCP servers" }, (command) =>
  command.add(InstallCommand, AddCommand, UpdateCommand, ListCommand, RemoveCommand)
);
