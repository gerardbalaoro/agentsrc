import { TomlFormat, parse, patch } from "@decimalturn/toml-patch";

import { OperationError } from "#errors.ts";
import { getValue, isTable } from "#util/config-value.ts";
import type { ConfigTable, ConfigValue } from "#util/config-value.ts";

/** Parses TOML. `file` is used only in the error message. */
export function parseToml(text: string, file: string): ConfigTable {
  try {
    return parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new OperationError(`${file} is not valid TOML: ${reason}`);
  }
}

/**
 * Sets the value at `keys` and keeps comments and the formatting of everything else.
 *
 * A new table at a depth below `sectionDepth` is written as its own `[a.b]` section. A deeper
 * table is written inline. With `sectionDepth: 2`, `["mcp", "db"]` becomes `[mcp.db]` and a nested
 * `env` table stays inline.
 */
export function setTomlValue(
  text: string,
  keys: string[],
  value: ConfigValue,
  options: { sectionDepth: number }
) {
  const document: ConfigTable = parse(text);
  const parent = getOrCreateParent(document, keys);
  parent[getLastKey(keys)] = value;

  return patch(text, document, getFormat(options.sectionDepth));
}

export function removeTomlValue(text: string, keys: string[]): string {
  const document: ConfigTable = parse(text);
  const parent = getValue(document, keys.slice(0, -1));

  if (!isTable(parent)) {
    return text;
  }

  Reflect.deleteProperty(parent, getLastKey(keys));
  const parentKeys = keys.slice(0, -1);
  const isParentNowEmpty = parentKeys.length > 0 && Object.keys(parent).length === 0;

  // A parent that existed only through `[parent.child]` headers would be left behind as a new,
  // empty `[parent]` header. A parent with its own header stays, with the user's comments.
  if (isParentNowEmpty && !hasOwnHeader(text, parentKeys)) {
    return removeTomlValue(text, parentKeys);
  }

  return patch(text, document);
}

/** True when the text holds a `[a.b]` header for exactly these keys, written as bare keys. */
function hasOwnHeader(text: string, keys: string[]) {
  const header = `[${keys.join(".")}]`;

  return text.split("\n").some((line) => line.replaceAll(/\s+/gu, "").startsWith(header));
}

function getOrCreateParent(document: ConfigTable, keys: string[]) {
  let node = document;

  for (const key of keys.slice(0, -1)) {
    const child = node[key];
    const table: ConfigTable = isTable(child) ? child : {};
    node[key] = table;
    node = table;
  }

  return node;
}

function getLastKey(keys: string[]) {
  const last = keys.at(-1);

  if (last === undefined) {
    throw new Error("A TOML edit needs at least one key.");
  }

  return last;
}

function getFormat(sectionDepth: number) {
  const format = TomlFormat.default();
  format.inlineTableStart = sectionDepth;
  format.bracketSpacing = false;

  return format;
}
