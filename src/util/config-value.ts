// oxlint-disable anti-slop/no-runtime-typeof -- This module is the boundary that gives a parsed config file its type.

/** Any value that a TOML or JSON config file can hold. */
export type ConfigValue = string | number | boolean | null | Date | ConfigValue[] | ConfigTable;

export interface ConfigTable {
  [key: string]: ConfigValue;
}

export function isTable(value: ConfigValue | undefined): value is ConfigTable {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** Follows `keys` down from `root`. Returns `undefined` when a key is absent on the way. */
export function getValue(root: ConfigValue, keys: string[]): ConfigValue | undefined {
  let node: ConfigValue | undefined = root;

  for (const key of keys) {
    node = isTable(node) ? node[key] : undefined;
  }

  return node;
}

/** Compares two config values. The order of keys in a table does not matter. */
export function isSameValue(
  left: ConfigValue | undefined,
  right: ConfigValue | undefined
): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => isSameValue(item, right[index]))
    );
  }

  if (isTable(left) && isTable(right)) {
    const keys = Object.keys(left);

    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => key in right && isSameValue(left[key], right[key]))
    );
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  return left === right;
}
