import { expect, test } from "bun:test";
import path from "node:path";

import { addManifestEntry, disableManifestEntry, removeManifestEntry } from "#manifest/edit.ts";
import { createTempDir, readFileText, writeFiles } from "#test/support/temp.ts";

const Existing = `# team manifest\n[skills]\n# pinned\npdf = { source = "anthropics/skills", ref = "v1" }\n\n[mcp.linear]\nurl = "https://mcp.linear.app/mcp"\n`;

async function createManifest(text?: string) {
  const root = await createTempDir();

  if (text !== undefined) {
    await writeFiles(root, { ".agents/agents.toml": text });
  }

  return { file: path.join(root, ".agents", "agents.toml"), root };
}

test("add creates the manifest when there is none", async () => {
  const { file, root } = await createManifest();

  await addManifestEntry(file, "skills", "pdf", { source: "anthropics/skills" }, { force: false });

  expect(await readFileText(root, ".agents/agents.toml")).toBe(
    `[skills]\npdf = "anthropics/skills"\n`
  );
});

test("a server is added as its own section and the file's comments stay", async () => {
  const { file, root } = await createManifest(Existing);
  const entry = { env: { KEY: "${KEY}" }, package: "npm:@upstash/context7-mcp", version: "^1" };

  await addManifestEntry(file, "mcp", "context7", entry, { force: false });

  expect(await readFileText(root, ".agents/agents.toml")).toBe(
    `${Existing}\n[mcp.context7]\nenv = {KEY = "\${KEY}"}\npackage = "npm:@upstash/context7-mcp"\nversion = "^1"\n`
  );
});

test("adding a name that exists fails and leaves the file unchanged", async () => {
  const { file, root } = await createManifest(Existing);
  const add = addManifestEntry(file, "mcp", "linear", { command: "x" }, { force: false });

  await expect(add).rejects.toThrow("already has the entry mcp.linear");
  expect(await readFileText(root, ".agents/agents.toml")).toBe(Existing);
});

test("force replaces the whole entry, with no field left from the old one", async () => {
  const { file, root } = await createManifest(Existing);

  await addManifestEntry(file, "skills", "pdf", { source: "o/new" }, { force: true });

  const text = await readFileText(root, ".agents/agents.toml");
  expect(text).toContain(`pdf = "o/new"`);
  expect(text).not.toContain("v1");
  expect(text).toContain("# team manifest");
});

test("remove deletes an own entry and reports false for an absent one", async () => {
  const { file, root } = await createManifest(Existing);

  expect(await removeManifestEntry(file, "mcp", "linear")).toBe(true);
  expect(await removeManifestEntry(file, "mcp", "absent")).toBe(false);
  expect(await readFileText(root, ".agents/agents.toml")).toBe(
    `# team manifest\n[skills]\n# pinned\npdf = { source = "anthropics/skills", ref = "v1" }\n`
  );
});

test("disable writes false for an entry that only an extended manifest declares", async () => {
  const { file, root } = await createManifest(Existing);

  await disableManifestEntry(file, "skills", "legacy");
  await disableManifestEntry(file, "mcp", "context7");

  const text = await readFileText(root, ".agents/agents.toml");
  expect(text).toContain("legacy = false");
  expect(text).toContain("context7 = false");
  expect(text).toContain("[mcp.linear]");
});
