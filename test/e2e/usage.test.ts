import { beforeAll, expect, test } from "bun:test";

import { buildCli, createSandbox } from "#test/support/cli.ts";
import { writeFiles } from "#test/support/temp.ts";

beforeAll(buildCli);

test("usage needs no manifest and reports missing logins in valid JSON", async () => {
  const sandbox = await createSandbox();
  const result = await sandbox.agents(["usage", "codex", "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({
    providers: [],
    errors: [{ provider: "codex", message: "Sign in with the codex CLI first." }],
  });
  expect(result.stderr).not.toContain("manifest");
});

test("unknown usage providers and malformed reset retry keys are usage errors", async () => {
  const sandbox = await createSandbox();
  const unknown = await sandbox.agents(["usage", "unknown"]);
  expect(unknown.code).toBe(2);

  await writeFiles(sandbox.home, {
    ".codex/auth.json": JSON.stringify({ tokens: { access_token: "test-token" } }),
  });

  const malformed = await sandbox.agents([
    "usage",
    "reset",
    "codex",
    "--credit",
    "credit",
    "--request-id",
    "bad/key",
    "--yes",
  ]);

  expect(malformed.code).toBe(2);
});

test("malformed credentials cannot leak tokens through error output", async () => {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.home, {
    ".codex/auth.json": JSON.stringify({
      tokens: { access_token: { secret: "never-print-this" } },
    }),
  });

  const result = await sandbox.agents(["usage", "reset", "codex", "--credit", "credit"]);

  expect(result.code).toBe(1);
  expect(`${result.stdout}${result.stderr}`).not.toContain("never-print-this");
  expect(result.stderr).toContain("Sign in");
});

test("usage without a harness returns only detected harnesses", async () => {
  const sandbox = await createSandbox();
  const result = await sandbox.agents(["usage", "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ providers: [], errors: [] });
  expect(result.stderr).toContain("No detected harness logins");
});

test("reset selection requires a terminal when no harness is supplied", async () => {
  const sandbox = await createSandbox();
  const result = await sandbox.agents(["usage", "reset", "--next", "--yes"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("pass a harness name");
});

test("--next does not spend a reset in scripts without --yes", async () => {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.home, {
    ".codex/auth.json": JSON.stringify({ tokens: { access_token: "fake-token" } }),
  });
  const result = await sandbox.agents(["usage", "reset", "codex", "--next"]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("confirmation");
  expect(result.stderr).not.toContain("Reset request:");
});
