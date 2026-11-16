import { expect, test } from "bun:test";
import path from "node:path";

import {
  claimClaudeReset,
  createClaudeUsage,
  parseClaude,
  readClaudeUsage,
} from "#harness/adapters/claude-code/usage.ts";
import { createTempDir, writeFiles } from "#test/support/temp.ts";

const Now = Date.parse("2026-11-16T12:00:00Z");

test("keeps idempotency key for Claude claims and recognizes replay", async () => {
  expect(
    await claimClaudeReset(
      { token: "test", organizationId: "org/a" },
      "grant-a",
      "request-a",
      (url, init) => {
        expect(String(url)).toEndWith("/organizations/org%2Fa/reset_rate_limits");
        expect(JSON.parse(String(init?.body))).toEqual({
          program: "cedar_ember",
          grant_id: "grant-a",
          request_id: "request-a",
        });

        return Promise.resolve(Response.json({ result: "already_used" }));
      }
    )
  ).toEqual({ outcome: "already_used", success: true });
});

test("Claude usage requests include grant opt-in and OAuth headers", async () => {
  const result = await readClaudeUsage(
    { token: "test-token" },
    (url, init) => {
      expect(url).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1");
      const headers = new Headers(init.headers);
      expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
      expect(headers.get("Authorization")).toBe("Bearer test-token");

      return Promise.resolve(Response.json({ five_hour: { utilization: 30 } }));
    },
    Now
  );

  expect(result.windows[0]?.usedPercent).toBe(30);
});

test("Claude breakdown metadata is not parsed as a utilization window", async () => {
  const result = await readClaudeUsage(
    { token: "test" },
    () =>
      Promise.resolve(
        Response.json({
          five_hour: { utilization: 35, resets_at: "2026-11-16T13:00:00Z" },
          seven_day: { utilization: 60, resets_at: "2026-11-19T12:00:00Z" },
          seven_day_opus: null,
          seven_day_breakdown: {
            as_of: "2026-11-16T12:00:00Z",
            window_started_at: "2026-11-12T12:00:00Z",
            rows: [],
          },
        })
      ),
    Now
  );

  expect(result.windows.map((window) => window.label)).toEqual(["five hour", "seven day"]);
  expect(result.windows.map((window) => window.usedPercent)).toEqual([35, 60]);
});

test("Claude adapter keeps claims bound to the account connected before a login change", async () => {
  const directory = await createTempDir();
  await writeFiles(directory, {
    ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "original-token" } }),
    ".claude.json": JSON.stringify({
      oauthAccount: {
        emailAddress: "person@example.test",
        accountUuid: "account-a",
        organizationUuid: "org-a",
      },
    }),
  });

  const source = createClaudeUsage(
    () => directory,
    () => path.join(directory, ".claude.json"),
    (url, init) => {
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer original-token");

      if (init.method === "POST") {
        expect(url).toEndWith("/organizations/org-a/reset_rate_limits");

        return Promise.resolve(Response.json({ result: "reset" }));
      }

      return Promise.resolve(Response.json({ five_hour: { utilization: 15 } }));
    },
    () => Now
  );

  const account = await source.connect();
  const snapshot = await account?.read();
  expect(snapshot?.account).toEqual({ name: "person@example.test", id: "account-a" });
  await writeFiles(directory, {
    ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "different-token" } }),
  });
  expect(await account?.claimReset?.({ creditId: "grant-a", requestId: "retry-a" })).toEqual({
    outcome: "reset",
    success: true,
  });
});

test("Claude totals only usable unexpired grants and keeps Fable distinct", () => {
  const snapshot = parseClaude(
    {
      five_hour: { utilization: 100, resets_at: "2026-11-16T13:00:00Z" },
      seven_day_sonnet: { utilization: 20, resets_at: null },
      cedar_ember: {
        eligible: true,
        grants: [
          { id: "fable", resets_left: 2, usable_now: true, gives_back_weekly: true },
          { id: "paused", resets_left: 9, usable_now: true, paused: true },
          { id: "waiting", resets_left: 9, usable_now: false },
          { id: "expired", resets_left: 9, usable_now: true, ends_at: "2026-11-16T12:00:00Z" },
        ],
      },
    },
    Now
  );

  expect(snapshot.resets.available).toBe(2);
  expect(snapshot.resets.credits[0]?.label).toContain("Fable");
  expect(snapshot.limited).toBe(true);
  expect(snapshot.windows).toHaveLength(2);
});

test("missing reset information is unknown rather than zero", () => {
  expect(parseClaude({ five_hour: null }, Now).resets.available).toBeNull();
  expect(parseClaude({ cedar_ember: { eligible: false } }, Now).resets.available).toBe(0);
});

test("malformed Claude grants do not hide valid usage windows", () => {
  const snapshot = parseClaude(
    { five_hour: { utilization: 25 }, cedar_ember: { grants: "unexpected" } },
    Now
  );

  expect(snapshot.windows[0]?.usedPercent).toBe(25);
  expect(snapshot.resets.available).toBeNull();
});

test("explicitly non-expiring grants differ from unknown expiries", () => {
  const snapshot = parseClaude(
    {
      cedar_ember: {
        eligible: true,
        grants: [
          { id: "never", resets_left: 1, usable_now: true, ends_at: null },
          { id: "unknown", resets_left: 1, usable_now: true },
        ],
      },
    },
    Now
  );

  expect(snapshot.resets.credits.map((credit) => credit.expiry)).toEqual(["never", "unknown"]);
});

test("Claude grants remain visible when an eligible response has a null ineligibility reason", () => {
  const snapshot = parseClaude(
    {
      cedar_ember: {
        eligible: true,
        ineligible_reason: null,
        grants: [
          {
            id: "full-reset",
            resets_left: 2,
            usable_now: true,
            ends_at: "2026-12-01T00:00:00Z",
            type: "full",
          },
        ],
      },
    },
    Now
  );

  expect(snapshot.resets.available).toBe(2);
  expect(snapshot.resets.credits[0]?.id).toBe("full-reset");
  expect(snapshot.resets.credits[0]?.canClaim).toBe(true);
});
