import { expect, test } from "bun:test";

import { validateManifest } from "#manifest/schema.ts";

test("a bare skill string is shorthand for a source table", () => {
  const manifest = validateManifest({ skills: { pdf: "anthropics/skills" } }, "agents.toml");

  expect(manifest.skills).toEqual({ pdf: { source: "anthropics/skills" } });
});

test("an empty manifest has no entries and extends nothing", () => {
  expect(validateManifest({}, "agents.toml")).toEqual({ extends: [], mcp: {}, skills: {} });
});

test("an unknown key is an error that names the file and the key", () => {
  expect(() => validateManifest({ skils: {} }, "/repo/.agents/agents.toml")).toThrow(
    "Invalid manifest /repo/.agents/agents.toml:\n  unknown key: skils"
  );
});

test("an unknown key inside an entry names the full path", () => {
  const manifest = { skills: { pdf: { soruce: "x", source: "y" } } };

  expect(() => validateManifest(manifest, "agents.toml")).toThrow("skills.pdf");
});

test.each([
  ["both package and command", { command: "node", package: "npm:x" }],
  ["none of package, command or url", { args: ["a"] }],
  ["headers on a command", { command: "node", headers: { A: "b" } }],
  ["env on a url", { env: { A: "b" }, url: "https://x.test" }],
  ["a package without the npm: prefix", { package: "x" }],
])("an MCP entry with %s is rejected and named", (_case, entry) => {
  expect(() => validateManifest({ mcp: { svc: entry } }, "agents.toml")).toThrow("mcp.svc");
});

test("an unknown harness id in agents is rejected", () => {
  expect(() => validateManifest({ agents: ["cursor"] }, "agents.toml")).toThrow("agents.0");
});

test("false is accepted for a skill and for a server", () => {
  const manifest = validateManifest({ mcp: { a: false }, skills: { b: false } }, "agents.toml");

  expect(manifest.mcp).toEqual({ a: false });
  expect(manifest.skills).toEqual({ b: false });
});
