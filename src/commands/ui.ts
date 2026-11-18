import { defineCommand } from "@crustjs/core";

import { UsageError } from "#errors.ts";

export const UiCommand = defineCommand(
  "ui",
  { description: "Manage local or global skills and MCPs in a full-screen interface" },
  (command) =>
    command
      .flags({ global: { description: "Start in global scope", short: "g", type: "boolean" } })
      .action(async ({ flags }) => {
        if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") {
          throw new UsageError(
            "arc ui needs an interactive terminal. Use skills/mcp list --json for scripts."
          );
        }

        const { launchManager } = await import("#interactive/app.tsx");
        await launchManager(flags.global ?? false);
      })
);
