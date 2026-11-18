import { expect, test } from "bun:test";

import { selectEntries } from "#interactive/selection.ts";

test("selection spans tabs and preserves entries hidden by a later filter", () => {
  let selected = selectEntries(new Set(), { kind: "toggle", id: "skills:alpha" });
  selected = selectEntries(selected, { kind: "all", ids: ["mcp:db", "mcp:web"] });
  selected = selectEntries(selected, { kind: "all", ids: ["mcp:web"] });
  expect([...selected]).toEqual(["skills:alpha", "mcp:db", "mcp:web"]);
  expect([...selectEntries(selected, { kind: "toggle", id: "mcp:web" })]).toEqual([
    "skills:alpha",
    "mcp:db",
  ]);
});

test("scope changes clear selection and completed results remove only successful entries", () => {
  const selected = new Set(["skills:alpha", "mcp:db"]);
  expect([...selectEntries(selected, { kind: "completed", ids: ["skills:alpha"] })]).toEqual([
    "mcp:db",
  ]);
  expect(selectEntries(selected, { kind: "scope" }).size).toBe(0);
});
