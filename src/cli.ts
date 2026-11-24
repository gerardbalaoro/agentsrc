import { Crust, CrustError, defineExtension, defineExtensionId } from "@crustjs/core";
import { didYouMean, help, version } from "@crustjs/extensions";

import { InitCommand } from "#commands/init.ts";
import { createMcpCommand } from "#commands/mcp/index.ts";
import { SkillsCommand } from "#commands/skills/index.ts";
import { SyncCommand } from "#commands/sync.ts";
import { UiCommand } from "#commands/ui.ts";
import { UsageCommand } from "#commands/usage.ts";
import { UsageError } from "#errors.ts";

import packageJson from "../package.json" with { type: "json" };

const UsageExitCode = 2;
const UsageErrorCodes = new Set(["COMMAND_NOT_FOUND", "PARSE", "VALIDATION"]);

/**
 * Runs the CLI and returns its exit code: 0 for success, 1 for a failed operation, 2 for invalid
 * usage or an invalid manifest.
 */
export async function runCli(argv: string[]) {
  let isUsageFailure = false;

  // Crust reports every failure as exit code 1. This hook sees the error first, so the CLI can
  // tell invalid usage apart. It returns nothing, so Crust still prints the error.
  const exitCode = defineExtension(defineExtensionId("agentsrc/exit-code")).onError((failure) => {
    isUsageFailure =
      failure instanceof UsageError ||
      (failure instanceof CrustError && UsageErrorCodes.has(failure.code));
  });

  const app = new Crust("arc", {
    description: "Install agent skills and MCP servers from one manifest into every AI harness",
    version: packageJson.version,
  })
    .extend(exitCode, help(), version(), didYouMean())
    .add(InitCommand, SyncCommand, SkillsCommand, createMcpCommand(argv), UiCommand, UsageCommand);

  const code = await app.execute({ argv });

  return isUsageFailure ? UsageExitCode : code;
}
