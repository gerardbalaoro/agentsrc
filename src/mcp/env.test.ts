import { expect, test } from "bun:test";

import { getReference, hasReference, parseEnvValue } from "#mcp/env.ts";

test("text with no reference is one literal part", () => {
  expect(parseEnvValue("plain $HOME value", "env.A")).toEqual([
    { kind: "text", text: "plain $HOME value" },
  ]);
});

test("a reference inside text is split out", () => {
  const value = parseEnvValue("Bearer ${TOKEN}", "headers.Authorization");

  expect(value).toEqual([
    { kind: "text", text: "Bearer " },
    { kind: "env", name: "TOKEN" },
  ]);
  expect(hasReference(value)).toBe(true);
  expect(getReference(value)).toBeUndefined();
});

test("a value that is only a reference reports its variable", () => {
  expect(getReference(parseEnvValue("${API_KEY}", "env.API_KEY"))).toBe("API_KEY");
});

test("$${ is a literal ${ and not a reference", () => {
  const value = parseEnvValue("echo $${NOT_A_REF}", "args");

  expect(value).toEqual([{ kind: "text", text: "echo ${NOT_A_REF}" }]);
  expect(hasReference(value)).toBe(false);
});

test("a malformed reference is rejected with the field name", () => {
  expect(() => parseEnvValue("${not valid}", "env.A")).toThrow("env.A");
  expect(() => parseEnvValue("${UNCLOSED", "env.A")).toThrow("not a valid reference");
  expect(() => parseEnvValue("${}", "env.A")).toThrow("not a valid reference");
});
