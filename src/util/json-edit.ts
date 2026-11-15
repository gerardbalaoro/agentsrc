import type { ParseError } from "jsonc-parser/lib/esm/main.js";
// The UMD entry forwards require through a parameter, which Bun cannot bundle for Node.
import { applyEdits, modify, parse } from "jsonc-parser/lib/esm/main.js";

import { OperationError } from "#errors.ts";
import type { ConfigValue } from "#util/config-value.ts";

const Formatting = { insertSpaces: true, tabSize: 2 };

/** Parses JSON or JSONC. `file` is used only in the error message. */
export function parseJson(text: string, file: string): ConfigValue {
  const errors: ParseError[] = [];
  const value: ConfigValue = parse(text, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    throw new OperationError(`${file} is not valid JSON.`);
  }

  return value;
}

/** Sets the value at `keys` and keeps comments and the formatting of everything else. */
export function setJsonValue(text: string, keys: string[], value: ConfigValue) {
  return editJson(text, keys, value);
}

export function removeJsonValue(text: string, keys: string[]) {
  return editJson(text, keys, undefined);
}

function editJson(text: string, keys: string[], value: ConfigValue | undefined) {
  const source = text.trim() === "" ? "{}\n" : text;

  return applyEdits(source, modify(source, keys, value, { formattingOptions: Formatting }));
}
