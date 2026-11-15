import { homedir } from "node:os";
import path from "node:path";

/** True for a value that names a place on disk, as skills.sh decides it. */
export function isLocalPath(value: string) {
  return (
    value === "." ||
    value === ".." ||
    value === "~" ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value)
  );
}

/** Makes a local path absolute. A relative path resolves against `base`. */
export function resolveLocalPath(value: string, base: string) {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }

  return path.resolve(base, value);
}
