import { randomUUID } from "node:crypto";

import { defineCommand } from "@crustjs/core";
import { ZodError } from "zod";

import { JsonFlagDef } from "#commands/flags.ts";
import { UsageError } from "#errors.ts";
import { AllAdapters } from "#harness/registry.ts";
import { Ui } from "#ui.ts";
import type { UsageSource } from "#usage/model.ts";
import { createReport, formatReport, reportTitle } from "#usage/report.ts";

const ResetCommand = defineCommand(
  "reset",
  { description: "Claim one banked provider reset" },
  (command) =>
    command
      .flags({
        ...JsonFlagDef,
        provider: {
          type: "string",
          required: true,
          description: "Provider with banked resets: codex or claude",
        },
        credit: {
          type: "string",
          required: true,
          description: "Credit or grant ID shown by arc usage --json",
        },
        "request-id": {
          type: "string",
          description: "Reuse the same ID and credit when retrying an uncertain claim",
        },
      })
      .action(async ({ flags }) => {
        const source = selectSource(flags.provider);
        const { provider } = source;

        if (!flags.credit.trim()) {
          throw new UsageError("--credit must not be empty.");
        }

        const requestId = flags["request-id"] ?? randomUUID();

        if (!/^[A-Za-z0-9_-]{1,64}$/u.test(requestId)) {
          throw new UsageError(
            "--request-id must contain 1–64 letters, numbers, underscores, or hyphens."
          );
        }

        const account = await source.connect();

        if (!account) {
          throw new Error(`Sign in with the ${provider} CLI first.`);
        }

        const { claimReset } = account;

        if (!claimReset) {
          throw new UsageError(`${provider} does not support claiming banked resets.`);
        }

        // A replay must send the same pair even when the first request removed the credit from inventory.
        if (!flags["request-id"]) {
          const snapshot = await account.read();

          if (
            !snapshot.resets.credits.some((credit) => credit.id === flags.credit && credit.canClaim)
          ) {
            throw new Error(
              "This reset is unavailable, expired, or no longer claimable. Run arc usage again."
            );
          }
        }

        Ui.info(`Reset request: ${requestId}`);
        let claim: Awaited<ReturnType<typeof claimReset>>;

        try {
          claim = await claimReset({ creditId: flags.credit, requestId });
        } catch {
          throw new Error(
            `Reset result unknown. Retry: arc usage reset --provider ${provider} --credit ${flags.credit} --request-id ${requestId}`
          );
        }

        const { outcome, success } = claim;
        const result = { provider, creditId: flags.credit, requestId, outcome, success };

        if (flags.json) {
          Ui.json(result);
        } else if (success) {
          Ui.success(`${provider}: reset claimed.`);
        }

        if (!success) {
          throw new Error(`Reset was not confirmed: ${outcome}.`);
        }
      })
);

export const UsageCommand = defineCommand(
  "usage",
  { description: "Show provider limits, reset timing, and banked resets" },
  (command) =>
    command
      .flags({
        ...JsonFlagDef,
        provider: {
          type: "string",
          multiple: true,
          short: "p",
          description:
            "codex, claude, or opencode; repeat to select both (default: detected logins)",
        },
      })
      .add(ResetCommand)
      .action(async ({ flags }) => {
        const selected =
          flags.provider?.map(selectSource) ??
          AllAdapters.flatMap((adapter) => (adapter.usage ? [adapter.usage] : []));

        const progress =
          !flags.json && process.stderr.isTTY && !process.env.CI ? Ui.spinner() : undefined;

        progress?.start("Checking usage");

        const results = await Promise.all(
          [...new Set(selected)].map(async (source) => {
            const { provider } = source;

            try {
              const account = await source.connect();

              if (!account) {
                return {
                  provider,
                  report: null,
                  error: flags.provider ? `Sign in with the ${provider} CLI first.` : null,
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
              ? "No provider logins found. Sign in with Codex or Claude Code first."
              : "Could not retrieve all requested provider usage."
          );
        }
      })
);

function selectSource(value: string): UsageSource {
  const adapter = AllAdapters.find((item) => item.id === value || item.usage?.provider === value);

  if (!adapter?.usage) {
    const names = AllAdapters.flatMap((item) => (item.usage ? [item.usage.provider] : []));
    throw new UsageError(`Usage is unavailable for \`${value}\`. Choose ${names.join(" or ")}.`);
  }

  return adapter.usage;
}
