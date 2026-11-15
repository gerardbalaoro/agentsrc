import { beforeAll, expect, test } from "bun:test";
import { lstat, readlink, rm } from "node:fs/promises";
import path from "node:path";

import { git } from "#test/conformance/source-fixture.ts";
import { buildCli, createSandbox } from "#test/support/cli.ts";
import { readFileText, snapshotFiles, writeFiles } from "#test/support/temp.ts";

beforeAll(buildCli);

const Alpha = "---\nname: alpha\ndescription: Test alpha\n---\nOriginal alpha\n";
const Beta = "---\nname: beta\ndescription: Test beta\n---\nOriginal beta\n";

test("Git installs keep existing content until update and do not add a commit field", async () => {
  const sandbox = await createProject();
  const repo = path.join(sandbox.project, "vendor");
  await git(repo, ["init", "--quiet"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "--quiet", "-m", "Original"]);
  const added = await sandbox.agents(["skills", "add", `file://${repo}`, "--skill", "alpha"]);
  expect(added.code).toBe(0);
  expect(
    JSON.parse(await readFileText(sandbox.project, "skills-lock.json")).skills.alpha.commit
  ).toBeUndefined();
  const lock = await readFileText(sandbox.project, "skills-lock.json");
  await writeFiles(sandbox.project, { "vendor/alpha/SKILL.md": `${Alpha}New commit\n` });
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "--quiet", "-m", "Updated"]);
  const restored = await sandbox.agents(["skills", "install"]);
  expect(restored.code).toBe(0);
  expect(await readFileText(sandbox.project, ".agents/skills/alpha/SKILL.md")).toBe(Alpha);
  expect(await readFileText(sandbox.project, "skills-lock.json")).toBe(lock);
  const updated = await sandbox.agents(["skills", "update", "alpha"]);
  expect(updated.code).toBe(0);
  expect(await readFileText(sandbox.project, ".agents/skills/alpha/SKILL.md")).toBe(
    `${Alpha}New commit\n`
  );
});

test("removing inherited skills disables every name without changing the parent manifest", async () => {
  const sandbox = await createProject();
  const parent = '[skills]\nalpha = "./vendor/alpha"\nbeta = "./vendor/beta"\n';
  await writeFiles(sandbox.project, {
    ".agents/agents.toml": 'extends = ["../team.toml"]\nagents = ["claude-code"]\n',
    "team.toml": parent,
  });
  const installed = await sandbox.agents(["skills", "install"]);
  expect(installed.code).toBe(0);
  const removed = await sandbox.agents(["skills", "remove", "alpha", "beta"]);
  expect(removed.code).toBe(0);
  expect(await readFileText(sandbox.project, "team.toml")).toBe(parent);
  const own = await readFileText(sandbox.project, ".agents/agents.toml");
  expect(own).toContain("alpha = false");
  expect(own).toContain("beta = false");
  const rows = await sandbox.agents(["skills", "list", "--json"]);
  expect(JSON.parse(rows.stdout)).toEqual([]);
});

async function createProject() {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, {
    ".agents/agents.toml": 'agents = ["claude-code", "codex"]\n',
    "vendor/alpha/SKILL.md": Alpha,
    "vendor/beta/SKILL.md": Beta,
  });

  return sandbox;
}

test("sync records both domains in the lock and links installed skills", async () => {
  const sandbox = await createProject();
  await writeFiles(sandbox.project, {
    ".agents/agents.toml":
      'agents = ["claude-code", "codex"]\n[skills]\nalpha = "../vendor/alpha"\n[mcp.db]\ncommand = "db"\n',
  });

  const result = await sandbox.agents(["sync"]);
  expect(result.code).toBe(0);
  const lock = JSON.parse(await readFileText(sandbox.project, ".agents/agents.lock"));
  expect(lock.skills).toEqual(["alpha"]);
  expect(lock.mcp.db).toBeDefined();
  expect(await readFileText(sandbox.project, ".agents/skills/alpha/SKILL.md")).toBe(Alpha);
  expect(await readlink(path.join(sandbox.project, ".claude/skills/alpha"))).toBe(
    "../../.agents/skills/alpha"
  );
  const result1 = await sandbox.agents(["sync", "--frozen-lockfile"]);

  expect(result1.code).toBe(0);
});

test("adding several skills then removing them keeps every manifest edit", async () => {
  const sandbox = await createProject();
  const added = await sandbox.agents(["skills", "add", "./vendor", "--skill", "*"]);
  expect(added.code).toBe(0);
  expect(await readFileText(sandbox.project, ".agents/skills/beta/SKILL.md")).toBe(Beta);

  const removed = await sandbox.agents(["skills", "remove", "alpha", "beta"]);
  expect(removed.code).toBe(0);
  const rows = await sandbox.agents(["skills", "list", "--json"]);
  expect(JSON.parse(rows.stdout)).toEqual([]);
  expect(JSON.parse(await readFileText(sandbox.project, ".agents/agents.lock")).skills).toEqual([]);
  await expect(lstat(path.join(sandbox.project, ".agents/skills/alpha"))).rejects.toThrow();
  await expect(lstat(path.join(sandbox.project, ".agents/skills/beta"))).rejects.toThrow();
});

test("modified skills fail frozen install, normal install restores, and update refreshes the source", async () => {
  const sandbox = await createProject();
  const result2 = await sandbox.agents(["skills", "add", "./vendor/alpha"]);

  expect(result2.code).toBe(0);
  await writeFiles(sandbox.project, { ".agents/skills/alpha/SKILL.md": `${Alpha}Edited\n` });
  const frozen = await sandbox.agents(["skills", "install", "--frozen-lockfile"]);
  expect(frozen.code).toBe(1);
  expect(await readFileText(sandbox.project, ".agents/skills/alpha/SKILL.md")).toContain("Edited");
  const result3 = await sandbox.agents(["skills", "install"]);

  expect(result3.code).toBe(0);
  expect(await readFileText(sandbox.project, ".agents/skills/alpha/SKILL.md")).toBe(Alpha);
  await writeFiles(sandbox.project, { "vendor/alpha/SKILL.md": `${Alpha}Upstream\n` });
  const result4 = await sandbox.agents(["skills", "update", "alpha"]);

  expect(result4.code).toBe(0);
  expect(await readFileText(sandbox.project, ".agents/skills/alpha/SKILL.md")).toContain(
    "Upstream"
  );
});

test("a normal install restores a missing skill from its locked source", async () => {
  const sandbox = await createProject();
  const result5 = await sandbox.agents(["skills", "add", "./vendor/alpha"]);

  expect(result5.code).toBe(0);
  const lock = await readFileText(sandbox.project, "skills-lock.json");
  await rm(path.join(sandbox.project, ".agents/skills/alpha"), { recursive: true });
  const restored = await sandbox.agents(["skills", "install"]);
  expect(restored.code).toBe(0);
  expect(await readFileText(sandbox.project, ".agents/skills/alpha/SKILL.md")).toBe(Alpha);
  expect(await readFileText(sandbox.project, "skills-lock.json")).toBe(lock);
});

test("dry run add writes no manifest, installed skill, or lock", async () => {
  const sandbox = await createProject();
  const manifest = await readFileText(sandbox.project, ".agents/agents.toml");
  const result6 = await sandbox.agents(["skills", "add", "./vendor/alpha", "--dry-run"]);

  expect(result6.code).toBe(0);
  expect(await readFileText(sandbox.project, ".agents/agents.toml")).toBe(manifest);
  await expect(lstat(path.join(sandbox.project, "skills-lock.json"))).rejects.toThrow();
  await expect(lstat(path.join(sandbox.project, ".agents/skills/alpha"))).rejects.toThrow();
});

test("global add writes the shared global lock and installs into the home directory", async () => {
  const sandbox = await createProject();

  const result = await sandbox.agents([
    "skills",
    "add",
    "./vendor/alpha",
    "-g",
    "-a",
    "claude-code",
  ]);

  expect(result.code).toBe(0);
  const lock = JSON.parse(await readFileText(sandbox.home, ".agents/.skill-lock.json"));
  expect(lock.version).toBe(3);
  expect(lock.skills.alpha.sourceType).toBe("local");
  expect(await readFileText(sandbox.home, ".claude/skills/alpha/SKILL.md")).toBe(Alpha);
});

test.each(["canonical", "harness"] as const)(
  "frozen install rejects a missing %s without any writes",
  async (missing) => {
    const sandbox = await createProject();
    await writeFiles(sandbox.project, { ".agents/agents.toml": 'agents = ["claude-code"]\n' });
    const added = await sandbox.agents(["skills", "add", "./vendor/alpha", "--copy"]);
    expect(added.code).toBe(0);
    const dir = missing === "canonical" ? ".agents/skills/alpha" : ".claude/skills/alpha";
    await rm(path.join(sandbox.project, dir), { recursive: true });
    const before = await snapshotFiles(sandbox.home);
    const frozen = await sandbox.agents(["skills", "install", "--frozen-lockfile"]);
    expect(frozen.code).toBe(1);
    expect(await snapshotFiles(sandbox.home)).toEqual(before);
  }
);

test("invalid managed skill names cannot remove files outside the skills directory", async () => {
  const sandbox = await createProject();
  await writeFiles(sandbox.project, {
    ".agents/agents.lock": JSON.stringify({ version: 1, skills: ["../victim"] }),
    ".agents/victim/keep.txt": "Keep me",
  });
  const result = await sandbox.agents(["skills", "install"]);
  expect(result.code).not.toBe(0);
  expect(await readFileText(sandbox.project, ".agents/victim/keep.txt")).toBe("Keep me");
});

test("a declared skill cannot replace an installed untracked skill", async () => {
  const sandbox = await createProject();
  const added = await sandbox.agents(["skills", "add", "./vendor/alpha"]);
  expect(added.code).toBe(0);
  await writeFiles(sandbox.project, {
    ".agents/agents.lock": JSON.stringify({ version: 1, skills: [] }),
    ".agents/agents.toml":
      'agents = ["claude-code"]\n[skills]\nalpha = { source = "../vendor/beta", skill = "beta" }\n',
  });
  const result = await sandbox.agents(["skills", "install"]);
  expect(result.code).toBe(1);
  expect(await readFileText(sandbox.project, ".agents/skills/alpha/SKILL.md")).toBe(Alpha);
});

test("modified harness copies are listed, rejected by frozen install, and restored by install", async () => {
  const sandbox = await createProject();
  const added = await sandbox.agents(["skills", "add", "./vendor/alpha", "--copy"]);
  expect(added.code).toBe(0);
  await writeFiles(sandbox.project, { ".claude/skills/alpha/SKILL.md": `${Alpha}Edited\n` });
  const listed = await sandbox.agents(["skills", "list", "--json"]);
  expect(JSON.parse(listed.stdout)[0].status).toBe("modified");
  const frozen = await sandbox.agents(["skills", "install", "--frozen-lockfile"]);
  expect(frozen.code).toBe(1);
  expect(await readFileText(sandbox.project, ".claude/skills/alpha/SKILL.md")).toContain("Edited");
  const installed = await sandbox.agents(["skills", "install"]);
  expect(installed.code).toBe(0);
  expect(await readFileText(sandbox.project, ".claude/skills/alpha/SKILL.md")).toBe(Alpha);
});

test("an explicit Git SHA ref pins restores without a commit field", async () => {
  const sandbox = await createProject();
  const repo = path.join(sandbox.project, "vendor");
  await git(repo, ["init", "--quiet"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "--quiet", "-m", "Original"]);
  const sha = await git(repo, ["rev-parse", "HEAD"]);
  await writeFiles(sandbox.project, {
    ".agents/agents.toml": `agents = ["codex"]\n[skills]\nalpha = { source = "file://${repo}", ref = "${sha}" }\n`,
  });
  const added = await sandbox.agents(["skills", "install"]);
  expect(added.code).toBe(0);
  const lockText = await readFileText(sandbox.project, "skills-lock.json");
  const lock = JSON.parse(lockText);
  expect(lock.skills.alpha.ref).toBe(sha);
  expect(lock.skills.alpha.commit).toBeUndefined();
  await writeFiles(sandbox.project, { "vendor/alpha/SKILL.md": `${Alpha}New upstream\n` });
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "--quiet", "-m", "Advance branch"]);
  await rm(path.join(sandbox.project, ".agents/skills/alpha"), { recursive: true });
  const restored = await sandbox.agents(["skills", "install"]);
  expect(restored.code).toBe(0);
  expect(await readFileText(sandbox.project, ".agents/skills/alpha/SKILL.md")).toBe(Alpha);
  expect(await readFileText(sandbox.project, "skills-lock.json")).toBe(lockText);
});

const Skill = "---\nname: foo\ndescription: Test skill\n---\nOriginal\n";

async function createLocalSkillProject(
  manifest = 'agents = ["codex"]\n[skills]\nfoo = "../source"\n'
) {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, { ".agents/agents.toml": manifest, "source/SKILL.md": Skill });

  return sandbox;
}

test("foreign harness copies survive cleanup and removal even when their content hash matches", async () => {
  const sandbox = await createLocalSkillProject();
  const installed = await sandbox.agents(["skills", "install"]);
  expect(installed.code).toBe(0);
  await writeFiles(sandbox.project, {
    ".claude/skills/foo/SKILL.md": Skill,
    ".claude/skills/foo/metadata.json": "unique user data",
  });
  const again = await sandbox.agents(["skills", "install"]);
  expect(again.code).toBe(0);
  expect(await readFileText(sandbox.project, ".claude/skills/foo/metadata.json")).toBe(
    "unique user data"
  );
  expect(again.stderr).toContain("unmanaged");
  const removed = await sandbox.agents(["skills", "remove", "foo"]);
  expect(removed.code).toBe(0);
  expect(await readFileText(sandbox.project, ".claude/skills/foo/metadata.json")).toBe(
    "unique user data"
  );
});

test("expanding targets clashes with a foreign folder before writes, and force explicitly replaces it", async () => {
  const sandbox = await createLocalSkillProject();
  await sandbox.agents(["skills", "install"]);
  await writeFiles(sandbox.project, {
    ".claude/skills/foo/SKILL.md": `${Skill}Foreign\n`,
    ".agents/agents.toml": 'agents = ["claude-code", "codex"]\n[skills]\nfoo = "../source"\n',
  });
  const failed = await sandbox.agents(["skills", "install"]);
  expect(failed.code).toBe(1);
  expect(await readFileText(sandbox.project, ".claude/skills/foo/SKILL.md")).toContain("Foreign");
  const forced = await sandbox.agents(["skills", "install", "--force"]);
  expect(forced.code).toBe(0);
  expect(await readFileText(sandbox.project, ".claude/skills/foo/SKILL.md")).toBe(Skill);
});

test("owned copies remain restorable after editing and removable after dropping a target", async () => {
  const sandbox = await createLocalSkillProject(
    'agents = ["claude-code", "codex"]\n[skills]\nfoo = { source = "../source", copy = true }\n'
  );

  await sandbox.agents(["skills", "install"]);
  await writeFiles(sandbox.project, { ".claude/skills/foo/SKILL.md": `${Skill}Edited\n` });
  const restored = await sandbox.agents(["skills", "install"]);
  expect(restored.code).toBe(0);
  expect(await readFileText(sandbox.project, ".claude/skills/foo/SKILL.md")).toBe(Skill);
  await writeFiles(sandbox.project, {
    ".agents/agents.toml":
      'agents = ["codex"]\n[skills]\nfoo = { source = "../source", copy = true }\n',
  });
  const dropped = await sandbox.agents(["skills", "install"]);
  expect(dropped.code).toBe(0);
  await expect(lstat(path.join(sandbox.project, ".claude/skills/foo"))).rejects.toThrow();
});

test("a dangling managed link is removed when the skill leaves the manifest", async () => {
  const sandbox = await createLocalSkillProject(
    'agents = ["claude-code"]\n[skills]\nfoo = "../source"\n'
  );

  await sandbox.agents(["skills", "install"]);
  await rm(path.join(sandbox.project, ".agents/skills/foo"), { recursive: true });
  const removed = await sandbox.agents(["skills", "remove", "foo"]);
  expect(removed.code).toBe(0);
  await expect(lstat(path.join(sandbox.project, ".claude/skills/foo"))).rejects.toThrow();
});

test("flag fallback remains installed across repeated runs", async () => {
  const sandbox = await createLocalSkillProject('[skills]\nfoo = "../source"\n');

  for (const _ of [1, 2, 3]) {
    // oxlint-disable-next-line no-await-in-loop
    const result = await sandbox.agents(["skills", "install", "-a", "claude-code"]);
    expect(result.code).toBe(0);
    // oxlint-disable-next-line no-await-in-loop
    expect(await readFileText(sandbox.project, ".claude/skills/foo/SKILL.md")).toBe(Skill);
  }
});

test("failed skill additions and multi-entry duplicate errors leave the manifest byte-identical", async () => {
  const sandbox = await createLocalSkillProject('agents = ["codex"]\n');
  await writeFiles(sandbox.project, { ".agents/skills/foo/SKILL.md": Skill });
  const before = await readFileText(sandbox.project, ".agents/agents.toml");
  const failed = await sandbox.agents(["skills", "add", "./source"]);
  expect(failed.code).toBe(1);
  expect(await readFileText(sandbox.project, ".agents/agents.toml")).toBe(before);
  await rm(path.join(sandbox.project, ".agents/skills/foo"), { recursive: true });
  await writeFiles(sandbox.project, {
    "source/bar/SKILL.md": Skill.replaceAll("foo", "bar"),
    ".agents/agents.toml": 'agents = ["codex"]\n[skills]\nfoo = false\n',
  });
  // A repository root containing SKILL.md discovers only that skill; use separate children.
  await writeFiles(sandbox.project, {
    "many/bar/SKILL.md": Skill.replaceAll("foo", "bar"),
    "many/foo/SKILL.md": Skill,
  });
  const own = await readFileText(sandbox.project, ".agents/agents.toml");
  const duplicate = await sandbox.agents(["skills", "add", "./many", "--skill", "*"]);
  expect(duplicate.code).toBe(2);
  expect(await readFileText(sandbox.project, ".agents/agents.toml")).toBe(own);
});

test("force adopts an untracked skill without changing foreign non-target copies or other lock entries", async () => {
  const sandbox = await createLocalSkillProject();
  await sandbox.agents(["skills", "install"]);
  const skills = JSON.parse(await readFileText(sandbox.project, "skills-lock.json"));
  skills.skills.other = { ...skills.skills.foo, custom: "preserve" };
  await writeFiles(sandbox.project, {
    ".agents/agents.lock": '{"version":1,"skills":[]}',
    "skills-lock.json": JSON.stringify(skills),
    ".claude/skills/foo/SKILL.md": `${Skill}Foreign\n`,
  });
  const forced = await sandbox.agents(["skills", "install", "--force"]);
  expect(forced.code).toBe(0);
  expect(JSON.parse(await readFileText(sandbox.project, ".agents/agents.lock")).skills).toEqual([
    "foo",
  ]);
  expect(JSON.parse(await readFileText(sandbox.project, "skills-lock.json")).skills.other).toEqual(
    skills.skills.other
  );
  expect(await readFileText(sandbox.project, ".claude/skills/foo/SKILL.md")).toContain("Foreign");
});
