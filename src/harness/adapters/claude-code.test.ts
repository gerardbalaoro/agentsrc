import { expect, test } from "bun:test";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";

import { ClaudeCode } from "#harness/adapters/claude-code.ts";
import { createServer } from "#mcp/entry.ts";
import type { Scope } from "#scope.ts";
import { createTempDir, readFileText, writeFiles } from "#test/support/temp.ts";

test("references are written in Claude Code's own ${VAR} form", () => {
  const server = createServer("db", {
    args: ["--key=${KEY}"],
    command: "node",
    env: { TOKEN: "${TOKEN}" },
  });

  expect(ClaudeCode.mcp.render(server)).toEqual({
    args: ["--key=${KEY}"],
    command: "node",
    env: { TOKEN: "${TOKEN}" },
  });
});

test("a remote server carries its transport as type", () => {
  const http = createServer("a", { url: "https://a.test/mcp" });
  const sse = createServer("b", { transport: "sse", url: "https://b.test/sse" });

  expect(ClaudeCode.mcp.render(http)).toEqual({ type: "http", url: "https://a.test/mcp" });
  expect(ClaudeCode.mcp.render(sse)).toEqual({ type: "sse", url: "https://b.test/sse" });
});

test("a literal ${ cannot be expressed, because Claude Code would expand it", () => {
  const server = createServer("svc", { args: ["$${NOT_A_REF}"], command: "x" });

  expect(() => ClaudeCode.mcp.render(server)).toThrow(
    "claude-code cannot express the MCP server svc"
  );
});

test("add merges into .mcp.json and keeps the user's own server", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await writeFiles(root, {
    ".mcp.json": `{\n  "mcpServers": {\n    "mine": { "command": "mine" }\n  }\n}\n`,
  });

  await ClaudeCode.mcp.add(scope, createServer("db", { command: "node" }));

  expect(JSON.parse(await readFileText(root, ".mcp.json"))).toEqual({
    mcpServers: { db: { command: "node" }, mine: { command: "mine" } },
  });
});

test("remove deletes only the named server", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await ClaudeCode.mcp.add(scope, createServer("a", { command: "a" }));
  await ClaudeCode.mcp.add(scope, createServer("b", { command: "b" }));

  await ClaudeCode.mcp.remove(scope, "a");

  expect(await ClaudeCode.mcp.list(scope)).toEqual([{ config: { command: "b" }, name: "b" }]);
});

test("a skill is linked into .claude/skills with a relative link", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await writeFiles(root, { ".agents/skills/pdf/SKILL.md": "# pdf\n" });
  const dir = path.join(root, ".agents", "skills", "pdf");

  await ClaudeCode.skills.add(scope, { copy: false, dir, name: "pdf" });

  const link = path.join(root, ".claude", "skills", "pdf");
  expect(await readlink(link)).toBe(path.join("..", "..", ".agents", "skills", "pdf"));
  expect(await ClaudeCode.skills.find(scope, "pdf")).toEqual({ dir: link, name: "pdf" });
});

test("a skill with copy is a real directory, and adding again replaces it", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await writeFiles(root, { ".agents/skills/pdf/SKILL.md": "# v1\n" });
  const dir = path.join(root, ".agents", "skills", "pdf");
  await ClaudeCode.skills.add(scope, { copy: true, dir, name: "pdf" });
  await writeFiles(root, { ".agents/skills/pdf/SKILL.md": "# v2\n" });

  await ClaudeCode.skills.add(scope, { copy: true, dir, name: "pdf" });

  const target = path.join(root, ".claude", "skills", "pdf");
  const stats = await lstat(target);
  expect(stats.isSymbolicLink()).toBe(false);
  expect(await readFile(path.join(target, "SKILL.md"), "utf-8")).toBe("# v2\n");
});

test("removing a linked skill leaves the canonical copy in place", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await writeFiles(root, { ".agents/skills/pdf/SKILL.md": "# pdf\n" });
  const dir = path.join(root, ".agents", "skills", "pdf");
  await ClaudeCode.skills.add(scope, { copy: false, dir, name: "pdf" });

  await ClaudeCode.skills.remove(scope, "pdf");

  expect(await ClaudeCode.skills.list(scope)).toEqual([]);
  expect(await readFileText(root, ".agents/skills/pdf/SKILL.md")).toBe("# pdf\n");
});
