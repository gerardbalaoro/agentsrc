import { expect, test } from "bun:test";

import { createOpenCodeUsage } from "#harness/adapters/opencode/usage.ts";

const Now = Date.parse("2026-11-16T12:00:00Z");

const Usage = {
  usage: {
    rolling: { status: "ok", percent: 25, resetsAt: "2026-11-16T14:30:00Z" },
    weekly: { status: "ok", percent: 60, resetsAt: "2026-11-19T12:00:00Z" },
    monthly: { status: "ok", percent: 80, resetsAt: "2026-12-01T00:00:00Z" },
  },
};

const Export = [
  {
    id: "credential-go",
    integrationID: "opencode-go",
    active: true,
    label: "Personal",
    value: { type: "key", key: "secret-go-key" },
  },
];

function exportCredentials() {
  return Promise.resolve(JSON.stringify(Export));
}

test("OpenCode reads the active Go credential and retrieves all three quota windows", async () => {
  const source = createOpenCodeUsage(
    exportCredentials,
    (url, init) => {
      expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret-go-key");
      expect(init.method ?? "GET").toBe("GET");

      return Promise.resolve(Response.json(Usage));
    },
    () => Now
  );

  const account = await source.connect();
  const snapshot = await account?.read();
  expect(snapshot?.provider).toBe("opencode");
  expect(snapshot?.account).toEqual({ name: "Personal", id: "credential-go" });
  expect(snapshot?.windows.map((window) => window.usedPercent)).toEqual([25, 60, 80]);
  expect(snapshot?.windows.map((window) => window.label)).toEqual(["5h", "Weekly", "Monthly"]);
  expect(JSON.stringify(snapshot)).not.toContain("secret-go-key");
  expect(account?.claimReset).toBeUndefined();
});

test("OpenCode does not choose an inactive key or an unrelated OpenAI credential", async () => {
  const source = createOpenCodeUsage(
    () =>
      Promise.resolve(
        JSON.stringify([
          { ...Export[0], active: false },
          {
            id: "openai",
            integrationID: "openai",
            active: true,
            label: "Other",
            value: { type: "oauth", access: "unrelated-token" },
          },
          { ...Export[0], id: "active-go", value: { type: "key", key: "active-key" } },
        ])
      ),
    (_url, init) => {
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer active-key");

      return Promise.resolve(Response.json(Usage));
    }
  );

  const account = await source.connect();
  const snapshot = await account?.read();
  expect(snapshot?.account.id).toBe("active-go");
});

test("OpenCode Console OAuth supplies the workspace header and account identity", async () => {
  const source = createOpenCodeUsage(
    () =>
      Promise.resolve(
        JSON.stringify([
          {
            id: "console-login",
            integrationID: "opencode",
            active: true,
            label: "Work",
            value: {
              type: "oauth",
              access: "console-token",
              metadata: { email: "person@example.test", accountID: "user-a", orgID: "org-a" },
            },
          },
        ])
      ),
    (_url, init) => {
      expect(new Headers(init.headers).get("x-opencode-org-id")).toBe("org-a");

      return Promise.resolve(Response.json(Usage));
    }
  );

  const account = await source.connect();
  const snapshot = await account?.read();
  expect(snapshot?.account).toEqual({ name: "person@example.test", id: "org-a" });
});

test("an idle rolling window has no invented reset", async () => {
  const source = createOpenCodeUsage(
    exportCredentials,
    () =>
      Promise.resolve(
        Response.json({
          usage: {
            ...Usage.usage,
            rolling: { status: "ok", percent: 0, resetsAt: "2026-11-16T17:00:00Z" },
          },
        })
      ),
    () => Now
  );

  const account = await source.connect();
  const snapshot = await account?.read();
  expect(snapshot?.windows[0]?.resetsAt).toBeNull();
});

test("OpenCode marks exhausted allowances as limited and preserves the provider reset", async () => {
  const source = createOpenCodeUsage(
    exportCredentials,
    () =>
      Promise.resolve(
        Response.json({
          usage: {
            ...Usage.usage,
            rolling: { status: "limited", percent: 100, resetsAt: "2026-11-16T14:30:00Z" },
          },
        })
      ),
    () => Now
  );

  const account = await source.connect();
  const snapshot = await account?.read();
  expect(snapshot?.limited).toBe(true);
  expect(snapshot?.windows[0]?.resetsAt).toBe("2026-11-16T14:30:00.000Z");
});

test("no OpenCode Go login means no usage connection", async () => {
  expect(await createOpenCodeUsage(() => Promise.resolve("[]")).connect()).toBeNull();
});

test("malformed credential exports cannot disclose secret values", async () => {
  await expect(
    createOpenCodeUsage(() =>
      Promise.resolve(
        JSON.stringify([
          { ...Export[0], value: { type: "key", key: { secret: "never-print-this" } } },
        ])
      )
    ).connect()
  ).rejects.toThrow("Cannot read OpenCode credentials");
});

test("server time identifies the idle reset despite request latency", async () => {
  const source = createOpenCodeUsage(
    exportCredentials,
    () =>
      Promise.resolve(
        Response.json(
          {
            usage: {
              ...Usage.usage,
              rolling: { percent: 0, resetsAt: "2026-11-16T17:00:00Z" },
            },
          },
          { headers: { Date: "Mon, 16 Nov 2026 12:00:00 GMT" } }
        )
      ),
    () => Now - 60_000
  );

  const account = await source.connect();
  const snapshot = await account?.read();
  expect(snapshot?.windows[0]?.resetsAt).toBeNull();
  expect(snapshot?.windows[2]?.resetsAt).toBe("2026-12-01T00:00:00.000Z");
});

test("a zero-percent rounded active window retains its actual reset", async () => {
  const source = createOpenCodeUsage(
    exportCredentials,
    () =>
      Promise.resolve(
        Response.json({
          usage: {
            ...Usage.usage,
            rolling: { percent: 0, resetsAt: "2026-11-16T16:00:00Z" },
          },
        })
      ),
    () => Now
  );

  const account = await source.connect();
  const snapshot = await account?.read();
  expect(snapshot?.windows[0]?.resetsAt).toBe("2026-11-16T16:00:00.000Z");
});
