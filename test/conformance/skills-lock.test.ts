import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { installSkills } from "#skills/index.ts";
import { loadWorkspace } from "#workspace.ts";

import {
  FixtureCommit,
  createFlags,
  createSourceRepo,
  createTempDir,
  readFixture,
  writeSourceFixture,
} from "./source-fixture.ts";

/**
 * The fixtures are locks that the skills CLI wrote for the same sources (see the README in
 * test/fixtures/skills-cli). agentsrc must write the same bytes, apart from the formatting that the
 * repository formatter applies to the fixture files.
 */

let root: string;

beforeEach(async () => {
  root = await createTempDir("conformance");
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

/** Global scope lives in the home directory, which only a new process can move. */
async function runInChild(args: string[], env: Record<string, string>) {
  const { XDG_STATE_HOME: _, ...inherited } = process.env;

  const child = Bun.spawn(["bun", path.join(import.meta.dir, "run-skills.ts"), ...args], {
    env: { ...inherited, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });

  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

  if (code !== 0) {
    throw new Error(`run-skills ${args.join(" ")} failed:\n${stderr}`);
  }

  return await new Response(child.stdout).text();
}

/** The text that `JSON.stringify(value, null, 2)` gives for a fixture, as skills.sh writes it. */
function asWritten(fixture: string, replacements: Record<string, string>) {
  let text = fixture;

  for (const [placeholder, value] of Object.entries(replacements)) {
    text = text.replaceAll(placeholder, value);
  }

  return JSON.stringify(JSON.parse(text), undefined, 2);
}

test("the project lock matches the one the skills CLI wrote", async () => {
  const project = path.join(root, "project");
  const repo = path.join(root, "repo");
  await writeSourceFixture(path.join(project, "vendor/source"));
  expect(await createSourceRepo(repo)).toBe(FixtureCommit);
  await mkdir(path.join(project, ".agents"), { recursive: true });
  await writeFile(
    path.join(project, ".agents/agents.toml"),
    `agents = ["codex"]

[skills]
alpha = "../vendor/source"
beta = "../vendor/source"
delta = { source = "../vendor/source", skill = "beta" }
gamma = { source = "file://${repo}", copy = true }
`
  );

  await installSkills(await loadWorkspace(createFlags(), project), { force: false });

  const written = await Bun.file(path.join(project, "skills-lock.json")).text();

  const expected = asWritten(await readFixture("project-lock.json"), {
    "{{REPO}}": `file://${repo}`,
  });

  expect(written).toBe(`${expected}\n`);
});

test("the global lock matches the one the skills CLI wrote", async () => {
  const home = path.join(root, "home");
  const source = path.join(root, "project/vendor/source");
  await writeSourceFixture(source);
  await mkdir(path.join(home, ".agents"), { recursive: true });
  await writeFile(
    path.join(home, ".agents/agents.toml"),
    `agents = ["codex"]

[skills]
alpha = "${source}"
epsilon = { source = "${source}", skill = "alpha", copy = true }
`
  );

  await runInChild(["install", root, "--global"], { HOME: home });

  const written = await Bun.file(path.join(home, ".agents/.skill-lock.json")).text();

  const withoutTimes = written.replaceAll(
    /"(?<key>installedAt|updatedAt)": "[^"]+"/gu,
    '"$<key>": "{{TIME}}"'
  );

  expect(withoutTimes).toBe(
    asWritten(await readFixture("global-lock.json"), { "{{SOURCE}}": source })
  );
});

test("a lock written by the skills CLI is restored without a change", async () => {
  const project = path.join(root, "project");
  const repo = path.join(root, "repo");
  await writeSourceFixture(path.join(project, "vendor/source"));
  await createSourceRepo(repo);
  const lock = asWritten(await readFixture("project-lock.json"), { "{{REPO}}": `file://${repo}` });
  await writeFile(path.join(project, "skills-lock.json"), `${lock}\n`);
  await mkdir(path.join(project, ".agents"), { recursive: true });
  await writeFile(
    path.join(project, ".agents/agents.toml"),
    `agents = ["codex"]

[skills]
alpha = "../vendor/source"
delta = { source = "../vendor/source", skill = "beta" }
gamma = { source = "file://${repo}", copy = true }
`
  );
  await writeFile(
    path.join(project, ".agents/agents.lock"),
    JSON.stringify({ extends: {}, mcp: {}, skills: ["alpha", "delta", "gamma"], version: 1 })
  );

  await installSkills(await loadWorkspace(createFlags(), project), { force: false });

  // beta is in the skills lock but not managed by agentsrc, so it stays, although it is not installed.
  expect(await Bun.file(path.join(project, "skills-lock.json")).text()).toBe(`${lock}\n`);
  const delta = await Bun.file(path.join(project, ".agents/skills/delta/SKILL.md")).text();
  expect(delta.startsWith("---\r\nname: delta\r\n")).toBe(true);
  expect(await Bun.file(path.join(project, ".agents/skills/gamma/ünïcödé.md")).exists()).toBe(true);
  expect(await Bun.file(path.join(project, ".agents/skills/beta/SKILL.md")).exists()).toBe(false);
});

test("GitHub locks round-trip without adding fields beyond skills.sh", async () => {
  const project = path.join(root, "project");
  const repo = path.join(root, "repo");
  expect(await createSourceRepo(repo)).toBe(FixtureCommit);
  await mkdir(path.join(project, ".agents"), { recursive: true });
  const config = path.join(root, "gitconfig");
  await writeFile(
    config,
    `[url "file://${repo}"]\n  insteadOf = https://github.com/agentsrc-fixtures/skills.git\n`
  );
  const env = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  await writeFile(
    path.join(project, ".agents/agents.toml"),
    `agents = ["codex"]
[skills]
alpha = { source = "agentsrc-fixtures/skills", ref = "main", path = "skills/alpha" }
`
  );
  await writeFile(
    path.join(project, ".agents/agents.lock"),
    JSON.stringify({ version: 1, skills: ["alpha"] })
  );
  const upstreamText = await readFixture("github-lock.json");
  const upstream = JSON.parse(upstreamText);
  await writeFile(path.join(project, "skills-lock.json"), upstreamText);

  await runInChild(["install", project], env);
  const installed = await readFile(path.join(project, ".agents/skills/alpha/SKILL.md"), "utf-8");
  const lockedText = await readFile(path.join(project, "skills-lock.json"), "utf-8");
  const locked = JSON.parse(lockedText);
  expect(locked).toEqual(upstream);

  await rm(path.join(project, ".agents/skills/alpha"), { recursive: true });
  await runInChild(["install", project], env);
  expect(await readFile(path.join(project, ".agents/skills/alpha/SKILL.md"), "utf-8")).toBe(
    installed
  );
  expect(await readFile(path.join(project, "skills-lock.json"), "utf-8")).toBe(lockedText);

  // The upstream lock remains valid without an agentsrc-specific revision field.
  await writeFile(path.join(project, "skills-lock.json"), upstreamText);
  await runInChild(["install", project, "--frozen"], env);
  expect(await readFile(path.join(project, "skills-lock.json"), "utf-8")).toBe(upstreamText);
  expect(await readFile(path.join(project, ".agents/skills/alpha/SKILL.md"), "utf-8")).toBe(
    installed
  );
});
