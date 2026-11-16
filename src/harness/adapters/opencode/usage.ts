// oxlint-disable preserve-caught-error -- Credential export and parse errors can contain secrets; expose safe messages only.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import { request } from "#usage/http.ts";
import type { Transport } from "#usage/http.ts";
import type { Snapshot, UsageSource } from "#usage/model.ts";

const Run = promisify(execFile);
const UsageUrl = "https://opencode.ai/zen/go/v1/usage";

const ExportsSchema = z.array(
  z.object({
    id: z.string().min(1),
    integrationID: z.string(),
    label: z.string(),
    active: z.boolean(),
    value: z.unknown(),
  })
);

const MetadataSchema = z.object({
  email: z.string().optional(),
  accountID: z.string().optional(),
  orgID: z.string().optional(),
  orgName: z.string().optional(),
  server: z.string().optional(),
});

const CredentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key"), key: z.string().min(1), metadata: MetadataSchema.optional() }),
  z.object({ type: z.literal("api"), key: z.string().min(1), metadata: MetadataSchema.optional() }),
  z.object({
    type: z.literal("oauth"),
    access: z.string().min(1),
    metadata: MetadataSchema.optional(),
  }),
]);

const MeterSchema = z.object({
  percent: z.number().finite().nonnegative(),
  resetsAt: z.string().datetime({ offset: true }).nullish(),
});

const UsageSchema = z.object({
  usage: z.object({
    rolling: MeterSchema,
    weekly: MeterSchema.nullish(),
    monthly: MeterSchema.nullish(),
  }),
});

export function createOpenCodeUsage(
  readExport: () => Promise<string> = exportCredentials,
  transport: Transport = fetch,
  now = Date.now
): UsageSource {
  return {
    provider: "opencode",
    async connect() {
      const credentials = await readCredentials(readExport);

      if (!credentials) {
        return null;
      }

      return { read: () => readUsage(credentials, transport, now()) };
    },
  };
}

async function exportCredentials() {
  try {
    // V2 writes current credentials to SQLite; auth.json is a migration source and can be stale.
    // With no target, export reads stored credentials without loading project integrations.
    const result = await Run("opencode", ["auth", "export"], {
      timeout: 25_000,
      maxBuffer: 2_000_000,
    });

    return result.stdout;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "[]";
    }

    throw new Error(
      "Cannot export OpenCode credentials. Update OpenCode and check `opencode auth list`."
    );
  }
}

async function readCredentials(readExport: () => Promise<string>) {
  const text = await readExport();

  try {
    const rows = ExportsSchema.parse(JSON.parse(text));

    const row =
      rows.find((item) => item.active && item.integrationID === "opencode-go") ??
      rows.find((item) => item.active && item.integrationID === "opencode");

    if (!row) {
      return null;
    }

    const value = CredentialSchema.parse(row.value);

    // Console API keys do not establish a Go subscription; Console OAuth can access Go for its organization.
    if (row.integrationID === "opencode" && value.type !== "oauth") {
      return null;
    }

    const { metadata } = value;

    if (metadata?.server) {
      const server = new URL(metadata.server);

      if (server.protocol !== "https:" || server.hostname !== "opencode.ai") {
        throw new Error("Unsupported Console server");
      }
    }

    return {
      token: value.type === "oauth" ? value.access : value.key,
      organizationId: metadata?.orgID,
      account: getAccount(row, metadata),
    };
  } catch {
    throw new Error(
      "Cannot read OpenCode credentials. Check `opencode auth list` and reconnect OpenCode Go."
    );
  }
}

async function readUsage(
  credentials: NonNullable<Awaited<ReturnType<typeof readCredentials>>>,
  transport: Transport,
  now: number
): Promise<Snapshot> {
  const headers = new Headers({
    Authorization: `Bearer ${credentials.token}`,
    Accept: "application/json",
    "User-Agent": "agentsrc",
  });

  if (credentials.organizationId) {
    headers.set("x-opencode-org-id", credentials.organizationId);
  }

  let capturedAt = now;

  const raw = await request("opencode", UsageUrl, headers, {}, async (url, init) => {
    const response = await transport(url, init);
    const date = Date.parse(response.headers.get("date") ?? "");

    if (Number.isFinite(date)) {
      capturedAt = date;
    }

    return response;
  });

  const body = UsageSchema.parse(raw);

  const meters = [
    { value: body.usage.rolling, label: "5h" },
    { value: body.usage.weekly, label: "Weekly" },
    { value: body.usage.monthly, label: "Monthly" },
  ];

  const windows = meters.flatMap(({ value, label }) => {
    if (!value) {
      return [];
    }

    const reset = value.resetsAt ? Date.parse(value.resetsAt) : null;

    // With no rolling usage, Go returns "now + 5h", which moves on every read rather than expiring.
    const isIdle =
      label === "5h" &&
      value.percent === 0 &&
      reset !== null &&
      Math.abs(reset - capturedAt - 18_000_000) <= 2000;

    return [
      {
        label,
        usedPercent: value.percent,
        resetsAt: reset === null || isIdle ? null : new Date(reset).toISOString(),
      },
    ];
  });

  return {
    provider: "opencode",
    displayName: "OpenCode Go",
    account: credentials.account,
    plan: null,
    limited: windows.some((window) => window.usedPercent >= 100),
    windows,
    resets: {
      available: null,
      credits: [],
      supported: false,
      note: "OpenCode Go does not expose banked reset credits or claims.",
    },
  };
}

function getAccount(
  row: z.infer<typeof ExportsSchema>[number],
  metadata: z.infer<typeof MetadataSchema> | undefined
) {
  return {
    name: metadata?.email ?? metadata?.orgName ?? (row.label === "default" ? null : row.label),
    id: metadata?.orgID ?? metadata?.accountID ?? row.id,
  };
}
