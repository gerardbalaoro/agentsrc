import { expect, test } from "bun:test";

import type { Snapshot } from "#usage/model.ts";
import { createReport, formatReport, reportTitle } from "#usage/report.ts";

const Now = Date.parse("2026-11-16T12:00:00Z");

const Example: Snapshot = {
  provider: "codex",
  account: { name: "person@example.test", id: "account-a" },
  plan: "plus",
  limited: false,
  windows: [
    {
      label: "Usage weekly",
      usedPercent: 25,
      resetsAt: "2026-11-19T12:00:00Z",
    },
  ],
  resets: {
    available: 1,
    credits: [
      {
        id: "private-credit-id",
        count: 1,
        label: "Full",
        expiresAt: "2026-11-20T12:00:00Z",
        expiry: "dated",
        canClaim: true,
      },
    ],
    note: "Long inventory diagnostics",
  },
};

test("compact display keeps the next credit expiry and omits IDs and diagnostics", () => {
  const report = createReport(Example, Now);
  const output = formatReport(report, Now);
  expect(output).toContain("75% left");
  expect(output).not.toContain("pace");
  expect(output).toContain("next expires in 4d");
  expect(output).not.toContain("private-credit-id");
  expect(output).not.toContain("Long inventory");
  expect(output.split("\n")).toHaveLength(2);
  expect(report.resets.credits[0]?.id).toBe("private-credit-id");
});

test("provider headings identify the account and fall back to its ID", () => {
  expect(reportTitle(createReport(Example, Now))).toBe("Codex · person@example.test");
  expect(
    reportTitle(createReport({ ...Example, account: { name: null, id: "account-a" } }, Now))
  ).toBe("Codex · account-a");
});

test("compact display distinguishes a reached limit from a reset that needs refreshing", () => {
  const snapshot = {
    ...Example,
    limited: true,
    windows: [
      {
        label: "Usage primary",
        usedPercent: 100,
        resetsAt: "2026-11-16T12:30:00Z",
      },
    ],
  };

  expect(formatReport(createReport(snapshot, Now), Now)).toContain("limit reached");
  expect(reportTitle(createReport(snapshot, Now))).toContain("LIMIT REACHED");
  expect(formatReport(createReport(snapshot, Now + 3_600_000), Now + 3_600_000)).toContain(
    "refresh due"
  );
});

test("reports show remaining allowance and reset timing without projections", () => {
  const snapshot: Snapshot = {
    ...Example,
    windows: [
      {
        label: "Usage primary",
        usedPercent: 75,
        resetsAt: "2026-11-16T12:30:00Z",
      },
    ],
  };

  const report = createReport(snapshot, Now);
  const output = formatReport(report, Now);
  expect(output).toContain("25% left");
  expect(output).toContain("in 30m");
  expect(output).not.toContain("pace");
  expect(output).not.toContain("runs out");
  expect(output.split("\n")).toHaveLength(2);
  expect(report.windows[0]).toEqual({
    label: "Usage primary",
    usedPercent: 75,
    remainingPercent: 25,
    resetsAt: "2026-11-16T12:30:00Z",
    status: "available",
  });
});

test("unknown credit expiries are not displayed as non-expiring", () => {
  const report = createReport(
    {
      ...Example,
      resets: {
        ...Example.resets,
        credits: Example.resets.credits.map((credit) => ({
          ...credit,
          expiresAt: null,
          expiry: "unknown",
        })),
      },
    },
    Now
  );

  expect(formatReport(report, Now)).toContain("expiry unknown");
  expect(formatReport(report, Now)).not.toContain("does not expire");
});

test("unsupported reset claims are omitted from the compact display", () => {
  const report = createReport(
    {
      ...Example,
      displayName: "OpenCode Go",
      resets: { supported: false, available: null, credits: [], note: null },
    },
    Now
  );

  expect(formatReport(report, Now)).not.toContain("Resets");
  expect(report.resets.supported).toBe(false);
  expect(reportTitle(report)).toStartWith("OpenCode Go");
});

for (const available of [0, null]) {
  test(`reset rows are hidden when the available count is ${available}`, () => {
    const report = createReport(
      { ...Example, resets: { available, credits: [], note: null } },
      Now
    );

    expect(formatReport(report, Now)).not.toContain("Resets");
    expect(report.resets.available).toBe(available);
  });
}
