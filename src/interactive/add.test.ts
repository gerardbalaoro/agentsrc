import { expect, test } from "bun:test";

import { createAddForm, discoverAdditions } from "#interactive/add.ts";
import { applyBatch, prepareBatch } from "#interactive/batch.ts";
import { describeEntry, readInventory } from "#interactive/inventory.ts";
import { createTempDir, readFileText, snapshotFiles, writeFiles } from "#test/support/temp.ts";

function fill(kind: "skills" | "mcp", values: Record<string, string>) {
  const form = createAddForm(kind, ["claude-code"]);
  form.fields = form.fields.map((field) => ({
    ...field,
    value: values[field.label] ?? field.value,
  }));

  return form;
}

test("MCP additions retain arguments and references, hide literals, and write only after approval", async () => {
  const root = await createTempDir();
  const inventory = await readInventory(false, root);

  const form = fill("mcp", {
    Name: "db",
    Type: "command",
    Source: "database-server",
    Arguments: '["--read-only"]',
    Environment: '{"TOKEN":"${TOKEN}","DEBUG":"private-literal"}',
  });

  const additions = await discoverAdditions(form, inventory.workspace, root);
  const [first] = additions;

  if (!first) {
    throw new Error("Expected a discovered MCP server.");
  }

  expect(describeEntry(first).join("\n")).not.toContain("private-literal");
  const before = await snapshotFiles(root);
  const batch = await prepareBatch(inventory, "add", additions);
  expect(batch.problems).toEqual([]);
  expect(batch.warnings.join("\n")).toContain("literal values");
  expect(await snapshotFiles(root)).toEqual(before);
  const results = await applyBatch(batch);
  expect(results[0]?.status).toBe("success");
  const server = JSON.parse(await readFileText(root, ".mcp.json")).mcpServers.db;
  expect(server.args).toEqual(["--read-only"]);
  expect(server.env).toEqual({ TOKEN: "${TOKEN}", DEBUG: "private-literal" });
});

test("skill source discovery returns choices without importing every discovered skill", async () => {
  const root = await createTempDir();
  await writeFiles(root, {
    "source/one/SKILL.md": "---\nname: one\ndescription: One\n---\nOne.",
    "source/two/SKILL.md": "---\nname: two\ndescription: Two\n---\nTwo.",
  });
  const inventory = await readInventory(false, root);

  const choices = await discoverAdditions(
    fill("skills", { Source: "./source" }),
    inventory.workspace,
    root
  );

  expect(choices.map((item) => item.name)).toEqual(["one", "two"]);
  expect(await Bun.file(`${root}/.agents/agents.toml`).exists()).toBe(false);

  const batch = await prepareBatch(
    inventory,
    "add",
    choices.filter((item) => item.name === "two")
  );

  const results = await applyBatch(batch);
  expect(results[0]?.status).toBe("success");
  expect(await Bun.file(`${root}/.agents/skills/one/SKILL.md`).exists()).toBe(false);
  expect(await readFileText(root, ".agents/skills/two/SKILL.md")).toContain("Two.");
});

test("invalid MCP fields cannot create a manifest", async () => {
  const root = await createTempDir();
  const inventory = await readInventory(false, root);
  await expect(
    discoverAdditions(
      fill("mcp", { Name: "db", Source: "db", Arguments: "[1]" }),
      inventory.workspace,
      root
    )
  ).rejects.toThrow("Arguments");
  await expect(
    discoverAdditions(
      fill("mcp", { Name: "db", Source: "db", Environment: '{"TOKEN":123}' }),
      inventory.workspace,
      root
    )
  ).rejects.toThrow("Environment");
  await expect(
    discoverAdditions(
      fill("mcp", { Name: "db", Source: "db", Harnesses: "unknown" }),
      inventory.workspace,
      root
    )
  ).rejects.toThrow("Unknown harness");
  expect(await Bun.file(`${root}/.agents/agents.toml`).exists()).toBe(false);
});
