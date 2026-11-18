import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import path from "node:path";

import { applyBatch, prepareBatch } from "#interactive/batch.ts";
import { readInventory } from "#interactive/inventory.ts";
import { installServers } from "#mcp/index.ts";
import { installSkills } from "#skills/index.ts";
import { createTempDir, readFileText, snapshotFiles, writeFiles } from "#test/support/temp.ts";
import { Ui } from "#ui.ts";
import { loadWorkspace } from "#workspace.ts";

const Skill = (name: string) =>
  `---\nname: ${name}\ndescription: Test skill\n---\nOriginal ${name}.\n`;

async function fixture() {
  const root = await createTempDir();
  await writeFiles(root, {
    ".agents/agents.toml":
      'agents = ["claude-code"]\n[skills]\nalpha = "./sources/alpha"\nbeta = "./sources/beta"\n[mcp.db]\ncommand = "db"\n[mcp.keep]\ncommand = "keep"\n',
    ".agents/sources/alpha/SKILL.md": Skill("alpha"),
    ".agents/sources/beta/SKILL.md": Skill("beta"),
  });

  const workspace = await loadWorkspace(
    { global: false, agents: undefined, dryRun: false, frozen: false, yes: true },
    root
  );

  await Ui.capture(
    () => {},
    async () => {
      await installSkills(workspace, { force: false });
      await installServers(workspace, { force: false });
    }
  );

  return root;
}

test("mixed repair previews without writes and preserves unselected drift and locks", async () => {
  const root = await fixture();
  await writeFiles(root, {
    ".agents/skills/alpha/SKILL.md": "changed alpha",
    ".agents/skills/beta/SKILL.md": "changed beta",
    ".mcp.json": '{"mcpServers":{"db":{"command":"changed-db"},"keep":{"command":"changed-keep"}}}',
  });
  const inventory = await readInventory(false, root);
  const selected = inventory.items.filter((item) => item.name === "alpha" || item.name === "db");
  const before = await snapshotFiles(root);
  const batch = await prepareBatch(inventory, "repair", selected);
  expect(batch.problems).toEqual([]);
  expect(batch.entries).toHaveLength(2);
  expect(await snapshotFiles(root)).toEqual(before);
  const results = await applyBatch(batch);
  expect(results.every((result) => result.status === "success")).toBe(true);
  expect(await readFileText(root, ".agents/skills/alpha/SKILL.md")).toBe(Skill("alpha"));
  expect(await readFileText(root, ".agents/skills/beta/SKILL.md")).toBe("changed beta");
  const servers = JSON.parse(await readFileText(root, ".mcp.json")).mcpServers;
  expect(servers.db.command).toBe("db");
  expect(servers.keep.command).toBe("changed-keep");
  const lock = JSON.parse(await readFileText(root, ".agents/agents.lock"));
  expect(lock.skills).toEqual(["alpha", "beta"]);
  expect(Object.keys(lock.mcp)).toEqual(["db", "keep"]);
});

test("batch removal disables inherited entries and preserves unrelated ownership", async () => {
  const root = await fixture();
  await writeFiles(root, {
    "team.toml": '[mcp.db]\ncommand = "db"\n',
    ".agents/agents.toml":
      'extends = ["../team.toml"]\nagents = ["claude-code"]\n[skills]\nalpha = "./sources/alpha"\nbeta = "./sources/beta"\n[mcp.keep]\ncommand = "keep"\n',
  });
  const inventory = await readInventory(false, root);

  const batch = await prepareBatch(
    inventory,
    "remove",
    inventory.items.filter((item) => ["alpha", "db"].includes(item.name))
  );

  expect(batch.problems).toEqual([]);
  const results = await applyBatch(batch);
  expect(results.map((result) => result.status)).toEqual(["success", "success"]);
  expect(await readFileText(root, ".agents/agents.toml")).toContain("db = false");
  expect(await readFileText(root, "team.toml")).toBe('[mcp.db]\ncommand = "db"\n');
  const lock = JSON.parse(await readFileText(root, ".agents/agents.lock"));
  expect(lock.skills).toEqual(["beta"]);
  expect(Object.keys(lock.mcp)).toEqual(["keep"]);
});

test("unmanaged entries block the entire destructive batch without skipping", async () => {
  const root = await fixture();
  await writeFiles(root, { ".claude/skills/foreign/SKILL.md": Skill("foreign") });
  const inventory = await readInventory(false, root);
  const selected = inventory.items.filter((item) => ["alpha", "foreign"].includes(item.name));
  expect(selected).toHaveLength(2);
  const before = await snapshotFiles(root);
  const batch = await prepareBatch(inventory, "remove", selected);
  expect(batch.problems.join("\n")).toContain("import");
  await expect(applyBatch(batch)).rejects.toThrow();
  expect(await snapshotFiles(root)).toEqual(before);
});

test("a preview is refused after a harness entry changes", async () => {
  const root = await fixture();
  const inventory = await readInventory(false, root);

  const batch = await prepareBatch(
    inventory,
    "remove",
    inventory.items.filter((item) => item.name === "db")
  );

  await writeFiles(root, { ".mcp.json": '{"mcpServers":{"db":{"command":"user-edit"}}}' });
  const before = await snapshotFiles(root);
  await expect(applyBatch(batch)).rejects.toThrow("changed");
  expect(await snapshotFiles(root)).toEqual(before);
});

test("batch import records only selected existing entries", async () => {
  const root = await createTempDir();
  await writeFiles(root, {
    ".claude/skills/foreign/SKILL.md": Skill("foreign"),
    ".mcp.json": '{"mcpServers":{"db":{"command":"db"},"keep":{"command":"keep"}}}',
  });
  const inventory = await readInventory(false, root);

  const batch = await prepareBatch(
    inventory,
    "import",
    inventory.items.filter((item) => ["foreign", "db"].includes(item.name))
  );

  expect(batch.problems).toEqual([]);
  const results = await applyBatch(batch);
  expect(results.every((result) => result.status === "success")).toBe(true);
  const lock = JSON.parse(await readFileText(root, ".agents/agents.lock"));
  expect(lock.skills).toEqual(["foreign"]);
  expect(Object.keys(lock.mcp)).toEqual(["db"]);
  expect(JSON.parse(await readFileText(root, ".mcp.json")).mcpServers.keep.command).toBe("keep");
  expect(await readFileText(root, ".agents/skills/foreign/SKILL.md")).toBe(Skill("foreign"));
  const next = await readInventory(false, root);
  expect(next.items.find((item) => item.name === "foreign")?.managed).toBe(true);
});

test("conflicting same-name imports require one origin before writes", async () => {
  const root = await createTempDir();
  await writeFiles(root, {
    ".mcp.json": '{"mcpServers":{"db":{"command":"one"}}}',
    ".codex/config.toml": '[mcp_servers.db]\ncommand = "two"\n',
  });
  const inventory = await readInventory(false, root);

  const batch = await prepareBatch(
    inventory,
    "import",
    inventory.items.filter((item) => item.name === "db")
  );

  expect(batch.problems.join("\n")).toContain("origin");
  await expect(applyBatch(batch)).rejects.toThrow();
});

test("preparation rejects a manifest edited since inventory was loaded", async () => {
  const root = await fixture();
  const inventory = await readInventory(false, root);
  await writeFiles(root, { ".agents/agents.toml": '[mcp.db]\ncommand = "new-command"\n' });
  const before = await snapshotFiles(root);
  await expect(
    prepareBatch(
      inventory,
      "repair",
      inventory.items.filter((item) => item.name === "db")
    )
  ).rejects.toThrow("changed");
  expect(await snapshotFiles(root)).toEqual(before);
});

test("scope sync removes orphaned managed entries and preserves foreign entries", async () => {
  const root = await fixture();
  await writeFiles(root, {
    ".agents/agents.toml":
      'agents = ["claude-code"]\n[skills]\nbeta = "./sources/beta"\n[mcp.keep]\ncommand = "keep"\n',
    ".claude/skills/foreign/SKILL.md": Skill("foreign"),
  });
  const inventory = await readInventory(false, root);

  const batch = await prepareBatch(
    inventory,
    "sync",
    inventory.items.filter((item) => item.declared || item.managed)
  );

  expect(batch.problems).toEqual([]);
  const results = await applyBatch(batch);
  expect(results.every((result) => result.status === "success")).toBe(true);
  expect(await Bun.file(`${root}/.agents/skills/alpha/SKILL.md`).exists()).toBe(false);
  expect(await readFileText(root, ".claude/skills/foreign/SKILL.md")).toBe(Skill("foreign"));
  expect(JSON.parse(await readFileText(root, ".mcp.json")).mcpServers.db).toBeUndefined();
});

test("an update applies approved source buffers rather than fetching again after approval", async () => {
  const root = await fixture();
  await writeFiles(root, {
    ".agents/sources/alpha/SKILL.md": `${Skill("alpha")}Approved change.\n`,
  });
  const inventory = await readInventory(false, root);

  const batch = await prepareBatch(
    inventory,
    "update",
    inventory.items.filter((item) => item.name === "alpha")
  );

  await writeFiles(root, {
    ".agents/sources/alpha/SKILL.md": `${Skill("alpha")}Unreviewed change.\n`,
  });
  const results = await applyBatch(batch);
  expect(results[0]?.status).toBe("success");
  expect(await readFileText(root, ".agents/skills/alpha/SKILL.md")).toBe(
    `${Skill("alpha")}Approved change.\n`
  );
});

test.skipIf(process.platform === "win32")(
  "a partial MCP failure keeps ownership and can be repaired",
  async () => {
    const root = await fixture();
    const manifest = await readFileText(root, ".agents/agents.toml");
    await writeFiles(root, {
      ".agents/agents.toml": manifest.replace(
        'agents = ["claude-code"]',
        'agents = ["claude-code", "codex"]'
      ),
      ".mcp.json": '{"mcpServers":{"db":{"command":"wrong"},"keep":{"command":"keep"}}}',
      ".codex/config.toml": '[mcp_servers.db]\ncommand = "wrong"\n',
    });
    const inventory = await readInventory(false, root);

    const batch = await prepareBatch(
      inventory,
      "repair",
      inventory.items.filter((item) => item.name === "db")
    );

    const directory = path.join(root, ".codex");
    chmodSync(directory, 0o555);

    try {
      const results = await applyBatch(batch);
      expect(results[0]?.status).toBe("failed");
      expect(JSON.parse(await readFileText(root, ".mcp.json")).mcpServers.db.command).toBe("db");
      expect(JSON.parse(await readFileText(root, ".agents/agents.lock")).mcp.db).toBeDefined();
    } finally {
      chmodSync(directory, 0o755);
    }

    const next = await readInventory(false, root);

    const retry = await prepareBatch(
      next,
      "repair",
      next.items.filter((item) => item.name === "db")
    );

    const results = await applyBatch(retry);
    expect(results[0]?.status).toBe("success");
    expect(await readFileText(root, ".codex/config.toml")).toContain('command = "db"');
  }
);

test("repair previews warn when a mutable source cannot restore its locked content", async () => {
  const root = await fixture();
  await writeFiles(root, {
    ".agents/skills/alpha/SKILL.md": "hand edit",
    ".agents/sources/alpha/SKILL.md": `${Skill("alpha")}Changed upstream.`,
  });
  const inventory = await readInventory(false, root);

  const batch = await prepareBatch(
    inventory,
    "repair",
    inventory.items.filter((item) => item.name === "alpha")
  );

  expect(batch.problems).toEqual([]);
  expect(batch.entries[0]?.lines.join("\n")).toContain(
    "source no longer matches the locked content"
  );
});
