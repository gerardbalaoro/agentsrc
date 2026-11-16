import { beforeAll, expect, test } from "bun:test";

import { buildCli, createSandbox } from "#test/support/cli.ts";
import { writeFiles } from "#test/support/temp.ts";

beforeAll(buildCli);

test("usage needs no manifest and reports missing logins in valid JSON", async () => {
  const sandbox = await createSandbox();
  const result = await sandbox.agents(["usage", "--provider", "codex", "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({
    providers: [],
    errors: [{ provider: "codex", message: "Sign in with the codex CLI first." }],
  });
  expect(result.stderr).not.toContain("manifest");
});

test("unknown usage providers and malformed reset retry keys are usage errors", async () => {
  const sandbox = await createSandbox();
  const unknown = await sandbox.agents(["usage", "--provider", "unknown"]);
  expect(unknown.code).toBe(2);

  const malformed = await sandbox.agents([
    "usage",
    "reset",
    "--provider",
    "codex",
    "--credit",
    "credit",
    "--request-id",
    "bad/key",
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

  const result = await sandbox.agents([
    "usage",
    "reset",
    "--provider",
    "codex",
    "--credit",
    "credit",
  ]);

  expect(result.code).toBe(1);
  expect(`${result.stdout}${result.stderr}`).not.toContain("never-print-this");
  expect(result.stderr).toContain("Sign in");
});
