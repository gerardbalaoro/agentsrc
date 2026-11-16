import { expect, test } from "bun:test";

import type { Credit, Snapshot, UsageAccount } from "#usage/model.ts";
import { availableResets, resetWarnings, resetUsage } from "#usage/reset.ts";

const Now = Date.parse("2026-11-16T12:00:00Z");

const FullReset: Credit = {
  id: "full",
  count: 1,
  label: "Full",
  expiresAt: "2026-11-18T12:00:00Z",
  expiry: "dated",
  canClaim: true,
  restores: ["session", "weekly"],
};

const Example: Snapshot = {
  provider: "test",
  account: { name: "person@example.test", id: "account" },
  plan: null,
  limited: false,
  windows: [
    { id: "session", label: "Session", usedPercent: 0, resetsAt: null },
    { id: "weekly", label: "Weekly", usedPercent: 100, resetsAt: null },
  ],
  resets: { available: 1, credits: [FullReset], note: null },
};

test("reset ordering filters spent and expired credits and sorts by expiry", () => {
  expect(
    availableResets(
      [
        { ...FullReset, id: "late" },
        { ...FullReset, id: "spent", canClaim: false },
        { ...FullReset, id: "expired", expiresAt: "2026-11-16T11:00:00Z" },
        { ...FullReset, id: "early", expiresAt: "2026-11-17T12:00:00Z" },
        { ...FullReset, id: "never", expiresAt: null },
      ],
      Now
    ).map((credit) => credit.id)
  ).toEqual(["early", "late", "never"]);
});

test("a full session does not warn against a reset that restores an exhausted week", () => {
  expect(resetWarnings(Example, FullReset, Now)).toEqual([]);
});

test("a session-only reset warns that an exhausted weekly limit remains blocked", () => {
  expect(resetWarnings(Example, { ...FullReset, restores: ["session"] }, Now).join(" ")).toContain(
    "Weekly"
  );
});

test("unused allowance warnings stop only inside the 12-hour expiry threshold", () => {
  const snapshot = {
    ...Example,
    windows: Example.windows.map((window) => ({ ...window, usedPercent: 50 })),
  };

  expect(
    resetWarnings(snapshot, { ...FullReset, expiresAt: "2026-11-17T00:00:00Z" }, Now)
  ).toHaveLength(1);
  expect(resetWarnings(snapshot, { ...FullReset, expiresAt: "2026-11-16T23:59:00Z" }, Now)).toEqual(
    []
  );
});

test("a rejected confirmation never submits a claim", async () => {
  let claims = 0;

  const account: UsageAccount = {
    read: () => Promise.resolve(Example),
    claimReset: () => {
      claims += 1;

      return Promise.resolve({ outcome: "reset", success: true });
    },
  };

  const result = await resetUsage(
    "test",
    account,
    { next: true, yes: false },
    {
      isInteractive: () => true,
      pick: () => Promise.resolve("full"),
      confirmReset: () => Promise.resolve(false),
      info: () => {},
      warn: () => {},
    },
    () => Now
  );

  expect(result).toBeNull();
  expect(claims).toBe(0);
});

test("--next --yes submits the first expiring credit without prompting and still warns", async () => {
  const claims: string[] = [];
  const warnings: string[] = [];

  const snapshot = {
    ...Example,
    windows: Example.windows.map((window) => ({ ...window, usedPercent: 0 })),
    resets: {
      ...Example.resets,
      credits: [FullReset, { ...FullReset, id: "early", expiresAt: "2026-11-17T12:00:00Z" }],
    },
  };

  const account: UsageAccount = {
    read: () => Promise.resolve(snapshot),
    claimReset: (claim) => {
      claims.push(claim.creditId);

      return Promise.resolve({ outcome: "reset", success: true });
    },
  };

  const result = await resetUsage(
    "test",
    account,
    { next: true, yes: true },
    {
      isInteractive: () => false,
      pick: () => {
        throw new Error("Unexpected picker");
      },
      confirmReset: () => {
        throw new Error("Unexpected confirmation");
      },
      info: () => {},
      warn: (message) => {
        warnings.push(message);
      },
    },
    () => Now
  );

  expect(result?.creditId).toBe("early");
  expect(claims).toEqual(["early"]);
  expect(warnings).toHaveLength(1);
});

test("manual choice lists available resets in expiry order and confirms the chosen credit", async () => {
  const account: UsageAccount = {
    read: () =>
      Promise.resolve({
        ...Example,
        resets: {
          ...Example.resets,
          credits: [FullReset, { ...FullReset, id: "early", expiresAt: "2026-11-17T12:00:00Z" }],
        },
      }),
    claimReset: (claim) => Promise.resolve({ outcome: claim.creditId, success: true }),
  };

  let confirmations = 0;

  const result = await resetUsage(
    "test",
    account,
    { next: false, yes: false },
    {
      isInteractive: () => true,
      pick: (_message, options) => {
        expect(options.map((option) => option.value)).toEqual(["early", "full"]);

        return Promise.resolve("full");
      },
      confirmReset: (message) => {
        expect(message).toContain("person@example.test");
        confirmations += 1;

        return Promise.resolve(true);
      },
      info: () => {},
      warn: () => {},
    },
    () => Now
  );

  expect(result?.creditId).toBe("full");
  expect(confirmations).toBe(1);
});

test("non-interactive claims without --yes stop before reading usage or spending a reset", async () => {
  const account: UsageAccount = {
    read: () => {
      throw new Error("Unexpected usage read");
    },
    claimReset: () => {
      throw new Error("Unexpected claim");
    },
  };

  await expect(
    resetUsage(
      "test",
      account,
      { next: true, yes: false },
      {
        isInteractive: () => false,
        pick: () => Promise.resolve(null),
        confirmReset: () => Promise.resolve(false),
        info: () => {},
        warn: () => {},
      }
    )
  ).rejects.toThrow("confirmation");
});

test("retries send the same credit and request ID even after the first claim removed the credit", async () => {
  const account: UsageAccount = {
    read: () => {
      throw new Error("A replay must not select a new credit");
    },
    claimReset: (claim) => {
      expect(claim).toEqual({ creditId: "gone-credit", requestId: "original-request" });

      return Promise.resolve({ outcome: "already_redeemed", success: true });
    },
  };

  const result = await resetUsage(
    "test",
    account,
    { next: false, yes: true, credit: "gone-credit", requestId: "original-request" },
    {
      isInteractive: () => false,
      pick: () => Promise.resolve(null),
      confirmReset: () => Promise.resolve(false),
      info: () => {},
      warn: () => {},
    }
  );

  expect(result?.success).toBe(true);
});

test("cancelled reset selection never asks for confirmation or submits a claim", async () => {
  const account: UsageAccount = {
    read: () => Promise.resolve(Example),
    claimReset: () => {
      throw new Error("Unexpected claim");
    },
  };

  expect(
    await resetUsage(
      "test",
      account,
      { next: false, yes: false },
      {
        isInteractive: () => true,
        pick: () => Promise.resolve(null),
        confirmReset: () => {
          throw new Error("Unexpected confirmation");
        },
        info: () => {},
        warn: () => {},
      },
      () => Now
    )
  ).toBeNull();
});

test("unknown reset coverage warns instead of guessing that it refills exhausted limits", () => {
  expect(resetWarnings(Example, { ...FullReset, restores: [] }, Now).join(" ")).toContain(
    "Cannot determine"
  );
});

test("a soon-expiring session reset still warns about an exhausted weekly limit", () => {
  const warnings = resetWarnings(
    Example,
    { ...FullReset, restores: ["session"], expiresAt: "2026-11-16T13:00:00Z" },
    Now
  );

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("Weekly");
});

test("a credit that expires during confirmation is never submitted", async () => {
  let current = Now;

  const account: UsageAccount = {
    read: () =>
      Promise.resolve({
        ...Example,
        resets: {
          ...Example.resets,
          credits: [{ ...FullReset, expiresAt: "2026-11-16T13:00:00Z" }],
        },
      }),
    claimReset: () => {
      throw new Error("Unexpected claim");
    },
  };

  await expect(
    resetUsage(
      "test",
      account,
      { next: true, yes: false },
      {
        isInteractive: () => true,
        pick: () => Promise.resolve(null),
        confirmReset: () => {
          current = Now + 3_600_001;

          return Promise.resolve(true);
        },
        info: () => {},
        warn: () => {},
      },
      () => current
    )
  ).rejects.toThrow("expired while awaiting confirmation");
});
