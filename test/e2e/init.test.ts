import { beforeAll, expect, test } from "bun:test";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { buildCli, createSandbox } from "#test/support/cli.ts";
import { readFileText, snapshotFiles, writeFiles } from "#test/support/temp.ts";
import { parseToml } from "#util/toml-edit.ts";

beforeAll(buildCli);

const Skill = "---\nname: style\ndescription: Local style\n---\nUse clear names.\n";

test("project init detects only project harnesses and imports only selected entries", async () => {
  const sandbox = await createSandbox([".codex"]);
  await writeFiles(sandbox.home, {
    ".codex/config.toml": '[mcp_servers.global]\ncommand = "global-db"\n',
    ".agents/skills/global/SKILL.md": Skill,
  });
  await writeFiles(sandbox.project, {
    ".mcp.json": '{"mcpServers":{"db":{"command":"local-db"},"skip":{"command":"skip"}}}',
    ".claude/skills/style/SKILL.md": Skill,
  });
  const result = await sandbox.agents(["init", "--skill", "style", "--mcp", "db"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("Run arc sync --force");
  const text = await readFileText(sandbox.project, ".agents/agents.toml");
  const manifest = parseToml(text, "init");
  expect(manifest.agents).toEqual(["claude-code"]);
  expect(text).toContain("local-db");
  expect(text).toContain("style");
  expect(text).not.toContain("global-db");
  expect(text).not.toContain("skip");
  expect(await readFileText(sandbox.project, ".claude/skills/style/SKILL.md")).toBe(Skill);
  await expect(lstat(path.join(sandbox.home, ".agents/agents.toml"))).rejects.toThrow();
});

test("global init reads global MCP and skills without importing project files", async () => {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.home, {
    ".claude.json":
      '{"mcpServers":{"remote":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}}}',
    ".claude/skills/style/SKILL.md": Skill,
  });
  await writeFiles(sandbox.project, {
    ".codex/config.toml": '[mcp_servers.project]\ncommand = "project-db"\n',
  });
  const result = await sandbox.agents(["init", "-g", "--skill", "*", "--mcp", "*"]);
  expect(result.code).toBe(0);
  const manifest = await readFileText(sandbox.home, ".agents/agents.toml");
  expect(manifest).toContain("https://example.test/mcp");
  expect(manifest).toContain("${TOKEN}");
  expect(manifest).toContain("style");
  expect(manifest).not.toContain("project-db");
  await expect(lstat(path.join(sandbox.project, ".agents/agents.toml"))).rejects.toThrow();
});

test("init preserves Codex and OpenCode environment references without evaluating secrets", async () => {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, {
    ".codex/config.toml":
      '[mcp_servers.db]\ncommand = "db"\nenv_vars = ["TOKEN"]\n[mcp_servers.web]\nurl = "https://example.test"\nbearer_token_env_var = "API_KEY"\n',
    "opencode.json":
      '{"mcp":{"servers":{"service":{"type":"local","command":["service","--mode","test"],"environment":{"AUTH":"{env:AUTH}"}}}}}',
  });

  const result = await sandbox.agents(["init", "--mcp", "*"], {
    TOKEN: "must-not-leak",
    API_KEY: "must-not-leak",
    AUTH: "must-not-leak",
  });

  expect(result.code).toBe(0);
  const manifest = await readFileText(sandbox.project, ".agents/agents.toml");
  expect(manifest).toContain("${TOKEN}");
  expect(manifest).toContain("${API_KEY}");
  expect(manifest).toContain("${AUTH}");
  expect(manifest).not.toContain("must-not-leak");
});

test("init yes creates an empty manifest without silently importing and never overwrites one", async () => {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, { ".mcp.json": '{"mcpServers":{"db":{"command":"db"}}}' });
  const first = await sandbox.agents(["init", "--yes"]);
  expect(first.code).toBe(0);
  const manifest = await readFileText(sandbox.project, ".agents/agents.toml");
  expect(manifest).not.toContain("[mcp.db]");
  const again = await sandbox.agents(["init", "--mcp", "*"]);
  expect(again.code).toBe(2);
  expect(await readFileText(sandbox.project, ".agents/agents.toml")).toBe(manifest);
});

test("init list and dry-run write no manifest; unknown imports and conflicting names fail", async () => {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, {
    ".mcp.json": '{"mcpServers":{"db":{"command":"one"}}}',
    ".codex/config.toml": '[mcp_servers.db]\ncommand = "two"\n',
  });
  const listed = await sandbox.agents(["init", "--list"]);
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain("claude-code:db");
  expect(listed.stdout).toContain("codex:db");
  const missing = await sandbox.agents(["init", "--mcp", "unknown"]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("Run arc init --list");
  const conflict = await sandbox.agents(["init", "--mcp", "*"]);
  expect(conflict.code).toBe(2);
  const dry = await sandbox.agents(["init", "--mcp", "codex:db", "--dry-run"]);
  expect(dry.code).toBe(0);
  await expect(lstat(path.join(sandbox.project, ".agents/agents.toml"))).rejects.toThrow();
});

test("init recovers shared skill sources and refs from the skills.sh lock", async () => {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, {
    ".agents/skills/style/SKILL.md": Skill,
    "skills-lock.json": JSON.stringify({
      version: 2,
      skills: {
        style: {
          source: "owner/repo",
          sourceType: "github",
          ref: "v1",
          skillPath: "skills/style/SKILL.md",
          computedHash: "hash",
        },
      },
    }),
  });
  const result = await sandbox.agents(["init", "--skill", "style"]);
  expect(result.code).toBe(0);
  const manifest = await readFileText(sandbox.project, ".agents/agents.toml");
  expect(manifest).toContain("owner/repo");
  expect(manifest).toContain("v1");
  expect(manifest).toContain("skills/style");
});

test("equal MCP imports merge harness targets while unsupported configs are skipped", async () => {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, {
    ".mcp.json":
      '{"mcpServers":{"db":{"command":"db"},"disabled":{"command":"other","disabled":true}}}',
    ".codex/config.toml": '[mcp_servers.db]\ncommand = "db"\n',
    "opencode.json": '{"mcp":{"servers":{"db":{"type":"local","command":["db"]}}}}',
  });
  const result = await sandbox.agents(["init", "--mcp", "*"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("Skipping claude-code:disabled");
  const manifest = parseToml(await readFileText(sandbox.project, ".agents/agents.toml"), "init");
  expect(manifest.mcp).toEqual({
    db: { command: "db", agents: ["claude-code", "codex", "opencode"] },
  });
});

test("importing Codex literals keeps literal interpolation distinct from references", async () => {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.project, {
    ".codex/config.toml":
      '[mcp_servers.db]\ncommand = "db"\nargs = ["${LITERAL}"]\nenv = { LITERAL = "${LITERAL}" }\n',
  });
  const result = await sandbox.agents(["init", "--mcp", "*"]);
  expect(result.code).toBe(0);
  const text = await readFileText(sandbox.project, ".agents/agents.toml");
  expect(text).toContain("$${LITERAL}");
  const sync = await sandbox.agents(["sync", "--force"]);
  expect(sync.code).toBe(0);
  expect(await readFileText(sandbox.project, ".codex/config.toml")).toContain(
    'args = ["${LITERAL}"]'
  );
});

test.each([
  ["project create", false, "create"],
  ["project list", false, "list"],
  ["project dry-run", false, "dry-run"],
  ["global create", true, "create"],
  ["global list", true, "list"],
  ["global dry-run", true, "dry-run"],
] as const)("%s init preserves all existing files in both scopes", async (_scope, global, mode) => {
  const sandbox = await createSandbox();
  await writeFiles(sandbox.home, {
    ".claude.json": '{"mcpServers":{"db":{"command":"global-db"}}}',
    ".codex/config.toml": '[mcp_servers.db]\ncommand = "codex-db"\n',
    ".config/opencode/opencode.json":
      '{"mcp":{"servers":{"db":{"type":"local","command":["global-db"]}}}}',
    ".agents/skills/style/SKILL.md": Skill,
    ".agents/.skill-lock.json": '{"version":3,"skills":{}}',
  });
  await writeFiles(sandbox.project, {
    ".mcp.json": '{"mcpServers":{"db":{"command":"project-db"}}}',
    ".codex/config.toml": '[mcp_servers.db]\ncommand = "codex-db"\n',
    "opencode.json": '{"mcp":{"servers":{"db":{"type":"local","command":["project-db"]}}}}',
    ".claude/skills/style/SKILL.md": Skill,
    "skills-lock.json": '{"version":2,"skills":{}}',
  });
  const before = await snapshotFiles(sandbox.home);

  const args = [
    "init",
    ...(global ? ["-g"] : []),
    ...(mode === "list" ? ["--list"] : ["--mcp", "claude-code:db", "--skill", "style"]),
    ...(mode === "dry-run" ? ["--dry-run"] : []),
  ];

  const result = await sandbox.agents(args);
  expect(result.code).toBe(0);
  const after = await snapshotFiles(sandbox.home);
  const manifest = path.join(global ? "" : "project", ".agents/agents.toml");

  if (mode === "create") {
    expect(after[manifest]).toBeDefined();
  }

  expect(
    Object.fromEntries(
      Object.entries(after).filter(([name]) => mode !== "create" || name !== manifest)
    )
  ).toEqual(before);
});
