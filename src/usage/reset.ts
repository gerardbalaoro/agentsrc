import { randomUUID } from "node:crypto";

import { UsageError } from "#errors.ts";
import { Ui } from "#ui.ts";
import type { Credit, Snapshot, UsageAccount } from "#usage/model.ts";

interface ResetOptions {
  next: boolean;
  yes: boolean;
  credit?: string;
  requestId?: string;
}

type ResetUi = Pick<typeof Ui, "isInteractive" | "pick" | "confirmReset" | "info" | "warn">;

const SoonMs = 12 * 3_600_000;

export function availableResets(credits: Credit[], now: number) {
  return credits
    .filter(
      (credit) =>
        credit.canClaim &&
        credit.count > 0 &&
        (!credit.expiresAt || Date.parse(credit.expiresAt) > now)
    )
    .toSorted((left, right) => expiry(left) - expiry(right));
}

export function resetWarnings(snapshot: Snapshot, credit: Credit, now: number) {
  const warnings: string[] = [];

  const covered = snapshot.windows.filter(
    (window) => window.id && credit.restores?.includes(window.id)
  );

  if (covered.length === 0) {
    warnings.push("Cannot determine which usage limits this reset restores.");

    return warnings;
  }

  const blocked = snapshot.windows.filter(
    (window) => window.usedPercent >= 100 && !covered.includes(window)
  );

  if (blocked.length > 0) {
    warnings.push(
      `Other exhausted limits may still block usage: ${blocked.map((window) => window.label).join(", ")}.`
    );
  }

  if (credit.expiry === "unknown") {
    warnings.push("The reset's expiry is unknown.");
  }

  const expiresSoon = credit.expiresAt !== null && Date.parse(credit.expiresAt) - now < SoonMs;

  if (covered.every((window) => window.usedPercent < 100) && !expiresSoon) {
    warnings.push(
      "All limits this reset restores still have unused allowance, and the reset is not known to expire within 12 hours."
    );
  }

  return warnings;
}

export async function resetUsage(
  provider: string,
  account: UsageAccount,
  options: ResetOptions,
  ui: ResetUi = Ui,
  now = Date.now
) {
  const { claimReset } = account;

  if (!claimReset) {
    throw new UsageError(`${provider} does not support claiming banked resets.`);
  }

  validateOptions(options, ui);
  const requestId = options.requestId ?? randomUUID();

  // A replay uses the original pair even if a successful first attempt removed the credit.
  if (options.requestId && options.credit) {
    ui.warn(
      "Retrying an earlier claim. Keep the original signed-in account, credit, and request ID."
    );

    if (!options.yes && !(await ui.confirmReset(`Retry this ${provider} reset claim?`))) {
      return null;
    }

    return await submitClaim(provider, claimReset, options.credit, requestId, ui);
  }

  const snapshot = await account.read();
  const credits = availableResets(snapshot.resets.credits, now());

  const credit = await chooseCredit(credits, options, ui);

  if (!credit) {
    return null;
  }

  for (const warning of resetWarnings(snapshot, credit, now())) {
    ui.warn(warning);
  }

  const identity = snapshot.account.name ?? snapshot.account.id ?? provider;

  if (
    !options.yes &&
    !(await ui.confirmReset(`Claim ${credit.label} for ${identity}? This spends one reset.`))
  ) {
    return null;
  }

  // Selection and confirmation can outlive a short expiry; do not spend a known-expired credit.
  if (credit.expiresAt && Date.parse(credit.expiresAt) <= now()) {
    throw new Error("The selected reset expired while awaiting confirmation.");
  }

  return await submitClaim(provider, claimReset, credit.id, requestId, ui);
}

function expiry(credit: Credit) {
  return credit.expiresAt ? Date.parse(credit.expiresAt) : Number.POSITIVE_INFINITY;
}

async function submitClaim(
  provider: string,
  claimReset: NonNullable<UsageAccount["claimReset"]>,
  creditId: string,
  requestId: string,
  ui: ResetUi
) {
  ui.info(`Reset request: ${requestId}`);

  try {
    const result = await claimReset({ creditId, requestId });

    return { provider, creditId, requestId, ...result };
  } catch {
    throw new Error(
      `Reset result unknown. Retry: arc usage reset ${provider} --credit ${creditId} --request-id ${requestId}`
    );
  }
}

function validateOptions(options: ResetOptions, ui: ResetUi) {
  if (!options.yes && !ui.isInteractive()) {
    throw new UsageError("Reset claims require confirmation. Run interactively or pass --yes.");
  }

  if (options.next && options.credit) {
    throw new UsageError("Choose --next or --credit, not both.");
  }

  if (options.requestId && !options.credit) {
    throw new UsageError("A retry needs --credit with the original --request-id.");
  }

  if (options.requestId && !/^[A-Za-z0-9_-]{1,64}$/u.test(options.requestId)) {
    throw new UsageError(
      "--request-id must contain 1–64 letters, numbers, underscores, or hyphens."
    );
  }
}

async function chooseCredit(credits: Credit[], options: ResetOptions, ui: ResetUi) {
  if (credits.length === 0) {
    throw new Error("No claimable resets are available.");
  }

  if (options.next) {
    return credits[0] ?? null;
  }

  let chosen = options.credit;

  if (!chosen) {
    if (!ui.isInteractive()) {
      throw new UsageError("Run interactively to choose a reset, or pass --next --yes.");
    }

    chosen =
      (await ui.pick(
        "Which reset do you want to claim?",
        credits.map((credit) => ({
          value: credit.id,
          label: `${credit.label} · ${credit.count} available`,
          hint: creditHint(credit),
        }))
      )) ?? undefined;

    if (!chosen) {
      return null;
    }
  }

  const credit = credits.find((item) => item.id === chosen);

  if (!credit) {
    throw new Error("This reset is unavailable or expired. Run usage again.");
  }

  return credit;
}

function creditHint(credit: Credit) {
  if (credit.expiresAt) {
    return `expires ${credit.expiresAt}`;
  }

  return credit.expiry === "never" ? "does not expire" : "expiry unknown";
}
