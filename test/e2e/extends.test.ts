import { afterAll, beforeAll, expect, test } from "bun:test";

import { buildCli, createSandbox } from "#test/support/cli.ts";
import { readFileText, writeFiles } from "#test/support/temp.ts";

const remote = { text: `[mcp.team-db]\ncommand = "team-db"\n` };
const server = Bun.serve({ fetch: () => new Response(remote.text), port: 0 });
const url = `http://localhost:${server.port}/team/agents.toml`;

beforeAll(async () => {
  await buildCli();
});

afterAll(async () => {
  await server.stop();
});

async function createProject() {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, {
    ".agents/agents.toml": `extends = ["${url}"]\nagents = ["claude-code"]\n`,
  });

  return sandbox;
}

async function readServers(project: string) {
  const config = JSON.parse(await readFileText(project, ".mcp.json"));

  return config.mcpServers;
}

test("a remote manifest is pinned by hash on first use", async () => {
  remote.text = `[mcp.team-db]\ncommand = "team-db"\n`;
  const sandbox = await createProject();

  const result = await sandbox.agents(["mcp", "install"]);

  expect(result.code).toBe(0);
  expect(await readServers(sandbox.project)).toEqual({ "team-db": { command: "team-db" } });
  const lock = JSON.parse(await readFileText(sandbox.project, ".agents/agents.lock"));
  expect(lock.extends[url].sha256).toMatch(/^[0-9a-f]{64}$/u);
});

test("a changed remote manifest is refused without --yes, and shows what changed", async () => {
  remote.text = `[mcp.team-db]\ncommand = "team-db"\n`;
  const sandbox = await createProject();
  await sandbox.agents(["mcp", "install"]);
  remote.text = `[mcp.team-db]\ncommand = "curl-pipe-sh"\n`;

  const refused = await sandbox.agents(["mcp", "install"]);

  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(url);
  expect(refused.stderr).toContain("~ mcp.team-db");
  expect(refused.stderr).toContain("--yes");
  expect(await readServers(sandbox.project)).toEqual({ "team-db": { command: "team-db" } });
});

test("--yes accepts the change and moves the pin", async () => {
  remote.text = `[mcp.team-db]\ncommand = "team-db"\n`;
  const sandbox = await createProject();
  await sandbox.agents(["mcp", "install"]);
  const before = JSON.parse(await readFileText(sandbox.project, ".agents/agents.lock"));
  remote.text = `[mcp.team-db]\ncommand = "team-db-v2"\n`;

  const accepted = await sandbox.agents(["mcp", "install", "--yes"]);

  expect(accepted.code).toBe(0);
  expect(await readServers(sandbox.project)).toEqual({ "team-db": { command: "team-db-v2" } });
  const after = JSON.parse(await readFileText(sandbox.project, ".agents/agents.lock"));
  expect(after.extends[url].sha256).not.toBe(before.extends[url].sha256);
});

test("a frozen run fails on a changed remote manifest even with --yes", async () => {
  remote.text = `[mcp.team-db]\ncommand = "team-db"\n`;
  const sandbox = await createProject();
  await sandbox.agents(["mcp", "install"]);
  remote.text = `[mcp.team-db]\ncommand = "changed"\n`;

  const frozen = await sandbox.agents(["sync", "--frozen-lockfile", "--yes"]);

  expect(frozen.code).toBe(1);
  expect(frozen.stderr).toContain("frozen run does not accept");
});

test("frozen sync rejects added and removed remote pins even when resolved entries stay the same", async () => {
  remote.text = "";
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, { ".agents/agents.toml": 'agents = ["claude-code"]\n' });
  await sandbox.agents(["sync"]);
  const original = await readFileText(sandbox.project, ".agents/agents.lock");
  await writeFiles(sandbox.project, {
    ".agents/agents.toml": `extends = ["${url}"]\nagents = ["claude-code"]\n`,
  });
  const added = await sandbox.agents(["sync", "--frozen-lockfile"]);
  expect(added.code).toBe(1);
  expect(await readFileText(sandbox.project, ".agents/agents.lock")).toBe(original);
  await sandbox.agents(["sync"]);
  const pinned = await readFileText(sandbox.project, ".agents/agents.lock");
  await writeFiles(sandbox.project, { ".agents/agents.toml": 'agents = ["claude-code"]\n' });
  const removed = await sandbox.agents(["sync", "--frozen-lockfile"]);
  expect(removed.code).toBe(1);
  expect(await readFileText(sandbox.project, ".agents/agents.lock")).toBe(pinned);
});

test("add uses one approved remote manifest snapshot", async () => {
  const sandbox = await createProject();
  await writeFiles(sandbox.project, {
    "source/SKILL.md": "---\nname: foo\ndescription: Test skill\n---\nOriginal\n",
  });
  let requests = 0;

  const snapshotServer = Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1;

      return new Response(`[mcp.team]\ncommand = "revision-${requests}"\n`);
    },
  });

  try {
    const snapshotUrl = `http://localhost:${snapshotServer.port}/agents.toml`;
    await writeFiles(sandbox.project, {
      ".agents/agents.toml": `extends = ["${snapshotUrl}"]\nagents = ["claude-code"]\n`,
    });
    const added = await sandbox.agents(["mcp", "add", "db", "--", "db"]);
    expect(added.code).toBe(0);
    expect(requests).toBe(1);
    const config = JSON.parse(await readFileText(sandbox.project, ".mcp.json"));
    expect(config.mcpServers.team.command).toBe("revision-1");
    // Skill additions must also keep the resolved remote snapshot rather than loading it again.
    const skill = await sandbox.agents(["skills", "add", "./source", "--yes"]);
    expect(skill.code).toBe(0);
    expect(requests).toBe(2);
  } finally {
    await snapshotServer.stop();
  }
});
