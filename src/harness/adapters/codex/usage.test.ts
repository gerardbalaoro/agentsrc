import { expect, test } from "bun:test";

import {
  claimCodexReset,
  createCodexUsage,
  parseCodex,
  readCodexUsage,
} from "#harness/adapters/codex/usage.ts";
import { createTempDir, writeFiles } from "#test/support/temp.ts";

const Credentials = { token: "test-secret", accountId: "workspace" };

const Now = Date.parse("2026-11-16T12:00:00Z");

test("passes Codex account headers and preserves usage when inventory fails", async () => {
  const result = await readCodexUsage(
    Credentials,
    (url, init) => {
      expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("workspace");

      if (String(url).endsWith("/usage")) {
        return Promise.resolve(
          Response.json({
            rate_limit: {
              primary_window: {
                used_percent: 80,
                limit_window_seconds: 604_800,
                reset_at: Now / 1000 + 3600,
              },
            },
            rate_limit_reset_credits: { available_count: 2 },
          })
        );
      }

      return Promise.resolve(new Response("secret must not appear", { status: 500 }));
    },
    Now
  );

  expect(result.windows[0]?.label).toBe("Usage weekly");
  expect(result.resets.available).toBe(2);
  expect(result.resets.credits).toEqual([]);
});

test("does not treat HTTP success as a successful reset", async () => {
  const result = await claimCodexReset(Credentials, "credit-a", "request-a", (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({
      credit_id: "credit-a",
      redeem_request_id: "request-a",
    });
    expect(init?.method).toBe("POST");

    return Promise.resolve(Response.json({ code: "nothing_to_reset" }));
  });

  expect(result).toEqual({ outcome: "nothing_to_reset", success: false });
});

test("HTTP errors never include response bodies or tokens", async () => {
  await expect(
    readCodexUsage(
      Credentials,
      () => Promise.resolve(new Response("test-secret", { status: 401 })),
      Now
    )
  ).rejects.toThrow("Sign in");
});

test("a lost claim response causes no automatic second consume", async () => {
  let calls = 0;
  await expect(
    claimCodexReset(Credentials, "credit-a", "same-request", () => {
      calls += 1;

      return Promise.reject(new Error("socket closed"));
    })
  ).rejects.toThrow("same credit and request IDs");
  expect(calls).toBe(1);
});

test("Codex usage accepts null additional limits without dropping the primary allowance", async () => {
  const result = await readCodexUsage(
    Credentials,
    (url) =>
      Promise.resolve(
        Response.json(
          url.endsWith("/usage")
            ? {
                additional_rate_limits: null,
                rate_limit: {
                  primary_window: {
                    used_percent: 42,
                    limit_window_seconds: 18_000,
                    reset_after_seconds: 3600,
                  },
                },
              }
            : { available_count: 0, credits: [] }
        )
      ),
    Now
  );

  expect(result.windows).toHaveLength(1);
  expect(result.windows[0]?.usedPercent).toBe(42);
  expect(result.resets.available).toBe(0);
});

test("Codex adapter discovers account identity without exposing JWTs in the snapshot", async () => {
  const directory = await createTempDir();

  const payload = Buffer.from(
    JSON.stringify({ email: "person@example.test", sub: "user-a" })
  ).toString("base64url");

  const token = `header.${payload}.signature`;
  await writeFiles(directory, {
    "auth.json": JSON.stringify({
      tokens: { access_token: "secret-token", id_token: token, account_id: "workspace-a" },
    }),
  });

  const source = createCodexUsage(
    () => directory,
    (_url, init) => {
      expect(new Headers(init.headers).get("ChatGPT-Account-Id")).toBe("workspace-a");

      return Promise.resolve(
        Response.json({ rate_limit: { primary_window: { used_percent: 20 } }, available_count: 0 })
      );
    },
    () => Now
  );

  const account = await source.connect();
  expect(account).not.toBeNull();
  const snapshot = await account?.read();
  expect(snapshot?.account).toEqual({ name: "person@example.test", id: "workspace-a" });
  expect(JSON.stringify(snapshot)).not.toContain(token);
  expect(JSON.stringify(snapshot)).not.toContain("secret-token");
});

test("Codex subject fallback is never sent as a workspace account header", async () => {
  const directory = await createTempDir();
  const payload = Buffer.from(JSON.stringify({ sub: "user-only" })).toString("base64url");
  await writeFiles(directory, {
    "auth.json": JSON.stringify({ tokens: { access_token: `h.${payload}.s` } }),
  });

  const source = createCodexUsage(
    () => directory,
    (_url, init) => {
      expect(new Headers(init.headers).has("ChatGPT-Account-Id")).toBe(false);

      return Promise.resolve(Response.json({ available_count: 0 }));
    }
  );

  const account = await source.connect();
  const snapshot = await account?.read();
  expect(snapshot?.account.id).toBe("user-only");
});

test("Codex includes model and review limits and accepts relative reset times", () => {
  const snapshot = parseCodex(
    {
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3600,
        },
      },
      code_review_rate_limit: { primary_window: { used_percent: 100 } },
      additional_rate_limits: [
        {
          limit_name: "Spark",
          rate_limit: { secondary_window: { used_percent: 40, limit_window_seconds: 604_800 } },
        },
      ],
    },
    null,
    Now
  );

  expect(snapshot.limited).toBe(true);
  expect(snapshot.windows.map((window) => window.label)).toEqual([
    "Usage 5-hour",
    "Code review primary",
    "Spark weekly",
  ]);
  expect(snapshot.windows[0]?.resetsAt).toBe("2026-11-16T13:00:00.000Z");
  expect(snapshot.resets.available).toBeNull();
});

test("Codex excludes redeemed credits and prevents claims on expired inventory", () => {
  const snapshot = parseCodex(
    {},
    {
      available_count: 2,
      credits: [
        { id: "expired", status: "available", expires_at: "2026-11-16T12:00:00Z" },
        { id: "live", status: "available", expires_at: Now / 1000 + 3600 },
        { id: "spent", status: "redeemed" },
      ],
    },
    Now
  );

  expect(snapshot.resets.credits.map((credit) => [credit.id, credit.canClaim])).toEqual([
    ["expired", false],
    ["live", true],
  ]);
  expect(snapshot.resets.credits[1]?.expiresAt).toBe("2026-11-16T13:00:00.000Z");
});

test("a changed Codex count cannot expose mismatched claim IDs", () => {
  const snapshot = parseCodex(
    { rate_limit_reset_credits: { available_count: 0 } },
    { available_count: 1, credits: [{ id: "old" }] },
    Now
  );

  expect(snapshot.resets.available).toBe(0);
  expect(snapshot.resets.credits).toEqual([]);
});

test("malformed inventory does not hide valid limits", () => {
  expect(
    parseCodex({ rate_limit: { primary_window: { used_percent: 50 } } }, { unexpected: true }, Now)
      .windows[0]?.usedPercent
  ).toBe(50);
});
