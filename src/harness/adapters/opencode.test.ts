import { expect, test } from "bun:test";

import { OpenCode } from "#harness/adapters/opencode.ts";
import { createServer } from "#mcp/entry.ts";
import type { Scope } from "#scope.ts";
import { createTempDir, readFileText, writeFiles } from "#test/support/temp.ts";

test("a stdio server becomes a local entry with one command array", () => {
  const server = createServer("db", {
    args: ["./db.js"],
    command: "node",
    env: { MODE: "fast", TOKEN: "${TOKEN}" },
  });

  expect(OpenCode.mcp.render(server)).toEqual({
    command: ["node", "./db.js"],
    environment: { MODE: "fast", TOKEN: "{env:TOKEN}" },
    type: "local",
  });
});

test("a remote server keeps text around a header reference", () => {
  const server = createServer("linear", {
    headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
    url: "https://mcp.linear.app/mcp",
  });

  expect(OpenCode.mcp.render(server)).toEqual({
    headers: { Authorization: "Bearer {env:LINEAR_TOKEN}" },
    type: "remote",
    url: "https://mcp.linear.app/mcp",
  });
});

test.each([
  ["a reference in args", { args: ["--key=${KEY}"], command: "x" }],
  ["a reference in the url", { url: "https://${HOST}/mcp" }],
  ["an SSE server", { transport: "sse" as const, url: "https://x.test/sse" }],
  ["a literal that OpenCode would expand", { command: "x", env: { A: "{env:HOME}" } }],
])("%s cannot be expressed and names the server", (_case, entry) => {
  expect(() => OpenCode.mcp.render(createServer("svc", entry))).toThrow(
    "opencode cannot express the MCP server svc"
  );
});

test("add writes under mcp.servers and keeps JSONC comments", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await writeFiles(root, {
    "opencode.jsonc": `{\n  // my theme\n  "theme": "dark"\n}\n`,
  });

  await OpenCode.mcp.add(scope, createServer("db", { command: "node" }));

  const text = await readFileText(root, "opencode.jsonc");
  expect(text).toContain("// my theme");
  expect(JSON.parse(text.replace("// my theme", ""))).toEqual({
    mcp: { servers: { db: { command: ["node"], type: "local" } } },
    theme: "dark",
  });
});

test("the config in .opencode is used when it is the one that exists", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await writeFiles(root, { ".opencode/opencode.json": "{}\n" });

  const file = await OpenCode.mcp.add(scope, createServer("db", { command: "node" }));

  expect(file).toBe(`${root}/.opencode/opencode.json`);
  expect(await OpenCode.mcp.find(scope, "db")).toEqual({
    config: { command: ["node"], type: "local" },
    name: "db",
  });
});

test("remove deletes only the named server", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await OpenCode.mcp.add(scope, createServer("a", { command: "a" }));
  await OpenCode.mcp.add(scope, createServer("b", { command: "b" }));

  await OpenCode.mcp.remove(scope, "a");

  expect(await OpenCode.mcp.list(scope)).toEqual([
    { config: { command: ["b"], type: "local" }, name: "b" },
  ]);
});

test("a v1 config, with servers directly under mcp, is not read as v2 servers", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await writeFiles(root, {
    "opencode.json": `{ "mcp": { "old": { "type": "local", "command": ["old"] } } }\n`,
  });

  expect(await OpenCode.mcp.list(scope)).toEqual([]);
});
