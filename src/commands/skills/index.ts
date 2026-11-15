import { defineCommand } from "@crustjs/core";

import { AddCommand } from "#commands/skills/add.ts";
import { InstallCommand } from "#commands/skills/install.ts";
import { ListCommand } from "#commands/skills/list.ts";
import { RemoveCommand } from "#commands/skills/remove.ts";
import { UpdateCommand } from "#commands/skills/update.ts";

export const SkillsCommand = defineCommand(
  "skills",
  { description: "Manage agent skills" },
  (command) => command.add(InstallCommand, AddCommand, UpdateCommand, ListCommand, RemoveCommand)
);
