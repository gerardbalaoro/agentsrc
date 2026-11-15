import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type { CommonFlags } from "#workspace.ts";

/**
 * The skill source that the conformance fixtures were made from. The files are kept as JSON, so
 * the formatter cannot change their bytes.
 */

const run = promisify(execFile);

const FixtureSchema = z.object({
  files: z.array(
    z.object({
      base64: z.string().optional(),
      mode: z.number().optional(),
      path: z.string(),
      text: z.string().optional(),
    })
  ),
});

export const FixturesDir = path.join(import.meta.dir, "..", "fixtures", "skills-cli");

export async function writeSourceFixture(dir: string) {
  const text = await Bun.file(path.join(FixturesDir, "source.json")).text();
  const fixture = FixtureSchema.parse(JSON.parse(text));

  await Promise.all(
    fixture.files.map(async (file) => {
      const target = path.join(dir, file.path);

      const content =
        file.base64 === undefined
          ? Buffer.from(file.text ?? "", "utf-8")
          : Buffer.from(file.base64, "base64");

      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      await chmod(target, file.mode ?? 0o644);
    })
  );
}

/** Git settings that make the commit SHA the same on every machine. */
const GitEnv = {
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

export async function git(cwd: string, args: string[]) {
  const { stdout } = await run(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, env: { ...process.env, ...GitEnv } }
  );

  return stdout.trim();
}

/** Makes a Git repository at `dir` that holds the fixture source in one commit. Returns its SHA. */
export async function createSourceRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  await writeSourceFixture(dir);
  await git(dir, ["init", "--quiet"]);
  await git(dir, ["add", "--all"]);
  await git(dir, ["commit", "--quiet", "--message", "Add test skills"]);

  return await git(dir, ["rev-parse", "HEAD"]);
}

/** The commit that `createSourceRepo` makes. The fixtures were written from this commit. */
export const FixtureCommit = "550319b49acfd7a2332cdb4caa4940cb12a6105a";

export async function createTempDir(prefix: string) {
  // The real path, because macOS reaches the temporary directory through a link.
  return await realpath(await mkdtemp(path.join(tmpdir(), `agentsrc-${prefix}-`)));
}

export async function readFixture(name: string) {
  return await Bun.file(path.join(FixturesDir, name)).text();
}

/** The flags of a plain run in project scope. */
export function createFlags(overrides: Partial<CommonFlags> = {}): CommonFlags {
  return {
    agents: undefined,
    dryRun: false,
    frozen: false,
    global: false,
    yes: true,
    ...overrides,
  };
}
