// oxlint-disable preserve-caught-error -- Credential parse errors may contain secrets.
import { readFile } from "node:fs/promises";

import type { z } from "zod";

export async function readCredentialsFile<T>(
  file: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(file, "utf-8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw new Error(
      `Cannot read provider credentials at ${file}. Sign in with the provider CLI again.`
    );
  }
}
