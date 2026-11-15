import { readFile } from "node:fs/promises";

/** Reads a text file. Returns `undefined` when the file does not exist. */
export async function readText(file: string) {
  try {
    return await readFile(file, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
}
