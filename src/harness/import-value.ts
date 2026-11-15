import type { z } from "zod";

import { OperationError } from "#errors.ts";
import type { HarnessServer } from "#harness/registry.ts";

/** Escape literal manifest interpolation without reading the environment. */
export function literal(value: string) {
  return value.replaceAll("${", () => "$${");
}

/** Reject unsupported configuration fields rather than silently losing their behavior. */
export function parseImported<Schema extends z.ZodType>(
  schema: Schema,
  server: HarnessServer
): z.infer<Schema> {
  const result = schema.safeParse(server.config);

  if (!result.success) {
    throw new OperationError(
      `Cannot import ${server.name}: unsupported or disabled MCP configuration.`
    );
  }

  return result.data;
}
