import { expect, test } from "bun:test";

import { parseAddRequest, parsePairs } from "#mcp/spec.ts";
import type { AddRequest } from "#mcp/spec.ts";

function request(spec: string, overrides: Partial<AddRequest> = {}): AddRequest {
  return {
    command: [],
    env: {},
    headers: {},
    name: undefined,
    spec,
    transport: undefined,
    ...overrides,
  };
}

test.each([
  ["@upstash/context7-mcp", "context7", { package: "npm:@upstash/context7-mcp" }],
  [
    "npm:@upstash/context7-mcp@^1",
    "context7",
    { package: "npm:@upstash/context7-mcp", version: "^1" },
  ],
  [
    "@modelcontextprotocol/server-github@2.0.0",
    "github",
    { package: "npm:@modelcontextprotocol/server-github", version: "2.0.0" },
  ],
  ["mcp-server-fetch", "fetch", { package: "npm:mcp-server-fetch" }],
  ["plain", "plain", { package: "npm:plain" }],
])("the package %s is named %s", (spec, name, entry) => {
  expect(parseAddRequest(request(spec))).toEqual({ entry, name });
});

test.each([
  ["https://mcp.linear.app/mcp", "linear"],
  ["https://api.example.com/v1", "example"],
  ["http://localhost:3000/mcp", "localhost"],
])("the URL %s is named %s", (url, name) => {
  expect(parseAddRequest(request(url))).toEqual({ entry: { url }, name });
});

test("a URL takes headers and a transport", () => {
  const parsed = parseAddRequest(
    request("https://x.test/sse", { headers: { Authorization: "Bearer ${T}" }, transport: "sse" })
  );

  expect(parsed.entry).toEqual({
    headers: { Authorization: "Bearer ${T}" },
    transport: "sse",
    url: "https://x.test/sse",
  });
});

test("an explicit name does not bypass URL validation", () => {
  expect(() => parseAddRequest(request("https://[", { name: "broken" }))).toThrow(
    "Enter a valid HTTP or HTTPS URL."
  );
});

test("text after -- is a command, and the positional argument is the name", () => {
  const parsed = parseAddRequest(
    request("local-db", { command: ["node", "./db.js", "--port", "1"], env: { A: "1" } })
  );

  expect(parsed).toEqual({
    entry: { args: ["./db.js", "--port", "1"], command: "node", env: { A: "1" } },
    name: "local-db",
  });
});

test("--name overrides the derived name", () => {
  expect(parseAddRequest(request("https://mcp.linear.app/mcp", { name: "tracker" })).name).toBe(
    "tracker"
  );
});

test.each([
  [
    "--header on a package",
    request("pkg", { headers: { A: "b" } }),
    "--header does not apply to a package",
  ],
  [
    "--env on a URL",
    request("https://x.test", { env: { A: "b" } }),
    "--env does not apply to a URL",
  ],
  [
    "--transport on a command",
    request("n", { command: ["x"], transport: "sse" }),
    "--transport does not apply to a command",
  ],
  ["a package that is only prefixes", request("mcp-server-"), "Pass --name"],
  ["a scope without a package name", request("@example"), "is not a package name"],
  ["an empty package range", request("tools@"), "Enter a version range after @"],
])("%s is a usage error", (_case, bad, message) => {
  expect(() => parseAddRequest(bad)).toThrow(message);
});

test("KEY=VALUE pairs keep every = after the first in the value", () => {
  expect(parsePairs(["A=1", "TOKEN=a=b="], "--env")).toEqual({ A: "1", TOKEN: "a=b=" });
  expect(() => parsePairs(["NOVALUE"], "--env")).toThrow("--env needs KEY=VALUE");
  expect(() => parsePairs(["=x"], "--env")).toThrow("--env needs KEY=VALUE");
});
