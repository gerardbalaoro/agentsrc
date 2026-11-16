import { defineCommand } from "@crustjs/core";
import { ZodError } from "zod";

import { JsonFlagDef } from "#commands/flags.ts";
import { UsageError } from "#errors.ts";
import { AllAdapters } from "#harness/registry.ts";
import { Ui } from "#ui.ts";
import { createReport, formatReport, reportTitle } from "#usage/report.ts";
import { resetUsage } from "#usage/reset.ts";

const HarnessArg = {
  name: "harness",
  type: "string",
  description: "Harness: claude-code, codex, or opencode",
} as const;

const ResetCommand = defineCommand(
  "reset",
  { description: "Choose and claim a banked reset" },
  (command) =>
    command
      .args(HarnessArg)
      .flags({
        ...JsonFlagDef,
        next: { type: "boolean", description: "Choose the reset that expires first" },
        yes: { type: "boolean", short: "y", description: "Claim without confirmation" },
        credit: {
          type: "string",
          description: "Explicit credit ID, including when retrying a claim",
        },
        "request-id": {
          type: "string",
          description: "Original request ID for retrying an uncertain claim",
        },
      })
      .action(async ({ args, flags }) => {
        const selected = await chooseResetAccount(args.harness);

        if (!selected) {
          return;
        }

        const result = await resetUsage(selected.provider, selected.account, {
          next: flags.next ?? false,
          yes: flags.yes ?? false,
          credit: flags.credit,
          requestId: flags["request-id"],
        });

        if (!result) {
          return;
        }

        if (flags.json) {
          Ui.json(result);
        } else if (result.success) {
          Ui.success(`${selected.provider}: reset claimed.`);
        }

        if (!result.success) {
          throw new Error(`Reset was not confirmed: ${result.outcome}.`);
        }
      })
);

export const UsageCommand = defineCommand(
  "usage",
  { description: "Show provider limits, reset timing, and banked resets" },
  (command) =>
    command
      .args(HarnessArg)
      .flags(JsonFlagDef)
      .add(ResetCommand)
      .action(async ({ args, flags }) => {
        const selected = args.harness
          ? [selectHarness(args.harness)]
          : AllAdapters.filter((adapter) => adapter.detect() && adapter.usage);

        const progress =
          !flags.json && process.stderr.isTTY && !process.env.CI ? Ui.spinner() : undefined;

        progress?.start("Checking usage");

        const results = await Promise.all(
          [...new Set(selected)].map(async (adapter) => {
            const source = adapter.usage;

            if (!source) {
              throw new UsageError(`Usage is unavailable for ${adapter.id}.`);
            }

            const { provider } = source;

            try {
              const account = await source.connect();

              if (!account) {
                return {
                  provider,
                  report: null,
                  error: args.harness ? `Sign in with the ${provider} CLI first.` : null,
                };
              }

              const snapshot = await account.read();

              return { provider, report: createReport(snapshot, Date.now()), error: null };
            } catch (error) {
              // Schema errors can contain fragments of untrusted provider responses.
              return {
                provider,
                report: null,
                error:
                  error instanceof Error && !(error instanceof ZodError)
                    ? error.message
                    : `${provider}: unexpected provider response. Try updating agentsrc.`,
              };
            }
          })
        );

        progress?.clear();

        const reports = results.flatMap((result) => (result.report ? [result.report] : []));

        const errors = results.flatMap((result) =>
          result.error ? [{ provider: result.provider, message: result.error }] : []
        );

        if (flags.json) {
          Ui.json({ providers: reports, errors });
        } else {
          for (const report of reports) {
            Ui.note(formatReport(report, Date.now(), true), reportTitle(report, true));
          }

          for (const error of errors) {
            Ui.warn(error.message);
          }
        }

        if (reports.length === 0 || errors.length > 0) {
          throw new Error(
            reports.length === 0 && errors.length === 0
              ? "No detected harness logins found. Sign in with a supported harness first."
              : "Could not retrieve all requested provider usage."
          );
        }
      })
);

function selectHarness(value: string) {
  const adapter = AllAdapters.find((item) => item.id === value || item.usage?.provider === value);

  if (!adapter?.usage) {
    throw new UsageError(
      `Usage is unavailable for \`${value}\`. Choose ${AllAdapters.map((item) => item.id).join(", ")}.`
    );
  }

  return adapter;
}

async function chooseResetAccount(harness: string | undefined) {
  if (harness) {
    const adapter = selectHarness(harness);
    const source = adapter.usage;

    if (!source) {
      throw new UsageError(`Usage is unavailable for ${harness}.`);
    }

    const account = await source.connect();

    if (!account) {
      throw new Error(`Sign in with the ${source.provider} CLI first.`);
    }

    return { provider: source.provider, account };
  }

  if (!Ui.isInteractive()) {
    throw new UsageError("Run interactively to choose a harness, or pass a harness name.");
  }

  const connections = await Promise.all(
    AllAdapters.filter((adapter) => adapter.detect()).map(async (adapter) => {
      const source = adapter.usage;

      if (!source) {
        return null;
      }

      const account = await source.connect();

      return account?.claimReset
        ? { harness: adapter.id, provider: source.provider, account }
        : null;
    })
  );

  const accounts = connections.filter((connection) => connection !== null);

  if (accounts.length === 0) {
    throw new Error("No detected harness logins support reset claims.");
  }

  const chosen = await Ui.pick(
    "Choose a harness",
    accounts.map((item) => ({ value: item.harness, label: item.harness }))
  );

  return accounts.find((item) => item.harness === chosen) ?? null;
}
