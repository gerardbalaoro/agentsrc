import { expect, test } from "bun:test";

import { Codex } from "#harness/adapters/codex/index.ts";
import { createServer } from "#mcp/entry.ts";
import type { Scope } from "#scope.ts";
import { createTempDir, readFileText, writeFiles } from "#test/support/temp.ts";

test("a forwarded variable becomes env_vars and literal values stay in env", () => {
  const server = createServer("db", {
    args: ["./db.js"],
    command: "node",
    env: { MODE: "fast", TOKEN: "${TOKEN}" },
  });

  expect(Codex.mcp.render(server)).toEqual({
    args: ["./db.js"],
    command: "node",
    env: { MODE: "fast" },
    env_vars: ["TOKEN"],
  });
});

test("remote headers map to Codex's three header forms", () => {
  const server = createServer("linear", {
    headers: {
      Authorization: "Bearer ${LINEAR_TOKEN}",
      "X-Org": "acme",
      "X-Trace": "${TRACE_ID}",
    },
    url: "https://mcp.linear.app/mcp",
  });

  expect(Codex.mcp.render(server)).toEqual({
    bearer_token_env_var: "LINEAR_TOKEN",
    env_http_headers: { "X-Trace": "TRACE_ID" },
    http_headers: { "X-Org": "acme" },
    url: "https://mcp.linear.app/mcp",
  });
});

test.each([
  ["a variable renamed in env", { command: "x", env: { TOKEN: "${OTHER}" } }],
  ["a reference in args", { args: ["--key=${KEY}"], command: "x" }],
  ["a reference in the url", { url: "https://${HOST}/mcp" }],
  ["an SSE server", { transport: "sse" as const, url: "https://x.test/sse" }],
  ["text mixed into a non-bearer header", { headers: { "X-Key": "k-${KEY}" }, url: "https://x" }],
])("%s cannot be expressed and names the server", (_case, entry) => {
  expect(() => Codex.mcp.render(createServer("svc", entry))).toThrow(
    "codex cannot express the MCP server svc"
  );
});

test("add writes a section and keeps the user's comments and servers", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await writeFiles(root, {
    ".codex/config.toml": `# my settings\nmodel = "gpt"\n\n[mcp_servers.mine]\ncommand = "mine"\n`,
  });

  await Codex.mcp.add(scope, createServer("db", { command: "node", env: { MODE: "fast" } }));

  expect(await readFileText(root, ".codex/config.toml")).toBe(
    `# my settings\nmodel = "gpt"\n\n[mcp_servers.mine]\ncommand = "mine"\n\n[mcp_servers.db]\ncommand = "node"\nenv = {MODE = "fast"}\n`
  );
  expect(await Codex.mcp.find(scope, "db")).toEqual({
    config: { command: "node", env: { MODE: "fast" } },
    name: "db",
  });
});

test("adding a server again replaces the whole entry, with no leftover fields", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await Codex.mcp.add(scope, createServer("db", { args: ["a"], command: "node" }));

  await Codex.mcp.add(scope, createServer("db", { url: "https://db.test/mcp" }));

  expect(await Codex.mcp.find(scope, "db")).toEqual({
    config: { url: "https://db.test/mcp" },
    name: "db",
  });
});

test("remove deletes only the named server", async () => {
  const root = await createTempDir();
  const scope: Scope = { kind: "project", root };
  await Codex.mcp.add(scope, createServer("a", { command: "a" }));
  await Codex.mcp.add(scope, createServer("b", { command: "b" }));

  await Codex.mcp.remove(scope, "a");

  expect(await Codex.mcp.list(scope)).toEqual([{ config: { command: "b" }, name: "b" }]);
});
