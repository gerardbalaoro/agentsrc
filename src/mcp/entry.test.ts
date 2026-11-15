import { expect, test } from "bun:test";

import { createServer, hashEntry } from "#mcp/entry.ts";

test("a package entry runs through npx at the locked version, before its own args", () => {
  const entry = { args: ["--verbose"], package: "npm:@upstash/context7-mcp", version: "^1" };
  const server = createServer("context7", entry, "1.0.14");

  expect(server).toEqual({
    args: [
      [{ kind: "text", text: "-y" }],
      [{ kind: "text", text: "@upstash/context7-mcp@1.0.14" }],
      [{ kind: "text", text: "--verbose" }],
    ],
    command: "npx",
    env: {},
    kind: "stdio",
    name: "context7",
  });
});

test("a URL entry defaults to the http transport", () => {
  const server = createServer("linear", { url: "https://mcp.linear.app/mcp" });

  expect(server).toMatchObject({ kind: "remote", transport: "http" });
});

test("the hash ignores key order and changes with any field", () => {
  const base = hashEntry({ command: "node", env: { A: "1", B: "2" } });

  expect(hashEntry({ env: { B: "2", A: "1" }, command: "node" })).toBe(base);
  expect(hashEntry({ command: "node", env: { A: "1", B: "3" } })).not.toBe(base);
  expect(hashEntry({ agents: ["codex"], command: "node", env: { A: "1", B: "2" } })).not.toBe(base);
});
