import { z } from "zod";

import { UsageError } from "#errors.ts";
import { HarnessIds } from "#harness/ids.ts";
import type { ConfigTable } from "#util/config-value.ts";

const AgentsSchema = z.array(z.enum(HarnessIds));
const TextTableSchema = z.record(z.string(), z.string());

const SkillTableSchema = z.strictObject({
  agents: AgentsSchema.optional(),
  copy: z.boolean().optional(),
  path: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  skill: z.string().min(1).optional(),
  source: z.string().min(1),
});

const SkillEntrySchema = z.union([
  z.literal(false),
  z
    .string()
    .min(1)
    .transform((source): SkillEntry => ({ source })),
  SkillTableSchema,
]);

const PackageEntrySchema = z.strictObject({
  agents: AgentsSchema.optional(),
  args: z.array(z.string()).optional(),
  env: TextTableSchema.optional(),
  package: z.string().regex(/^npm:.+/u, "must be `npm:<name>`"),
  version: z.string().min(1).optional(),
});

const CommandEntrySchema = z.strictObject({
  agents: AgentsSchema.optional(),
  args: z.array(z.string()).optional(),
  command: z.string().min(1),
  env: TextTableSchema.optional(),
});

const UrlEntrySchema = z.strictObject({
  agents: AgentsSchema.optional(),
  headers: TextTableSchema.optional(),
  transport: z.enum(["http", "sse"]).optional(),
  url: z.string().min(1),
});

const McpEntrySchema = z.union([
  z.literal(false),
  PackageEntrySchema,
  CommandEntrySchema,
  UrlEntrySchema,
]);

const ManifestSchema = z.strictObject({
  agents: AgentsSchema.optional(),
  extends: z.array(z.string().min(1)).default([]),
  mcp: z.record(z.string(), McpEntrySchema).default({}),
  skills: z.record(z.string(), SkillEntrySchema).default({}),
});

export type SkillEntry = z.infer<typeof SkillTableSchema>;

export type McpEntry =
  | z.infer<typeof PackageEntrySchema>
  | z.infer<typeof CommandEntrySchema>
  | z.infer<typeof UrlEntrySchema>;

export type Manifest = z.infer<typeof ManifestSchema>;

/** Validates a parsed manifest. `label` names the file in the error message. */
export function validateManifest(value: ConfigTable, label: string): Manifest {
  const result = ManifestSchema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  const problems = result.error.issues.map((issue) => `  ${describeIssue(issue)}`);
  throw new UsageError(`Invalid manifest ${label}:\n${problems.join("\n")}`);
}

function describeIssue(issue: z.core.$ZodIssue) {
  const key = issue.path.join(".");

  if (issue.code === "unrecognized_keys") {
    const unknown = issue.keys.map((name) => (key ? `${key}.${name}` : name)).join(", ");

    return `unknown key: ${unknown}`;
  }

  const isMcpEntry = issue.path[0] === "mcp" && issue.path.length === 2;

  if (issue.code === "invalid_union" && isMcpEntry) {
    return `${key}: must be \`false\`, or have exactly one of \`package\`, \`command\` or \`url\` and only the fields that apply to it`;
  }

  const isSkillEntry = issue.path[0] === "skills" && issue.path.length === 2;

  if (issue.code === "invalid_union" && isSkillEntry) {
    return `${key}: must be a source string, a table with \`source\`, or \`false\``;
  }

  return `${key}: ${issue.message}`;
}
