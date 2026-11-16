import path from "node:path";

// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- These parsers validate untrusted provider responses, including string or epoch timestamps.
import { z } from "zod";

import { readCredentialsFile } from "#usage/auth.ts";
import { request } from "#usage/http.ts";
import type { Transport } from "#usage/http.ts";
import type { Credit, Snapshot, UsageSource } from "#usage/model.ts";

const PercentSchema = z.number().finite().min(0);
const CountSchema = z.number().int().nonnegative();

const ExpirySchema = z
  .union([z.string().datetime({ offset: true }), z.number().finite()])
  .nullish();

const CodexWindowSchema = z.object({
  used_percent: PercentSchema,
  limit_window_seconds: z.number().positive().optional(),
  reset_at: z.number().finite().optional(),
  reset_after_seconds: z.number().finite().nonnegative().optional(),
});

const RateLimitSchema = z.object({
  limit_reached: z.boolean().optional(),
  primary_window: CodexWindowSchema.nullish(),
  secondary_window: CodexWindowSchema.nullish(),
});

const InventorySchema = z.object({
  available_count: CountSchema,
  credits: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.string().optional(),
        expires_at: ExpirySchema,
        reset_type: z.string().optional(),
      })
    )
    .optional(),
});

const CodexSchema = z.object({
  plan_type: z.string().optional(),
  rate_limit: RateLimitSchema.nullish(),
  code_review_rate_limit: RateLimitSchema.nullish(),
  additional_rate_limits: z
    .array(
      z.object({
        limit_name: z.string().optional(),
        metered_feature: z.string().optional(),
        rate_limit: RateLimitSchema,
      })
    )
    .nullish(),
  rate_limit_reset_credits: z.object({ available_count: CountSchema }).nullish(),
});

export function parseCodex(raw: unknown, inventory: unknown, now: number): Snapshot {
  const body = CodexSchema.parse(raw);

  const limits = [
    { label: "Usage", value: body.rate_limit },
    { label: "Code review", value: body.code_review_rate_limit },
    ...(body.additional_rate_limits ?? []).map((entry) => ({
      label: entry.limit_name ?? entry.metered_feature ?? "Additional",
      value: entry.rate_limit,
    })),
  ];

  const windows = limits.flatMap(({ label, value }) =>
    [value?.primary_window, value?.secondary_window].flatMap((window, index) => {
      if (!window) {
        return [];
      }

      const seconds = window.limit_window_seconds ?? null;
      const period = windowLabel(seconds, index);

      const reset =
        window.reset_at ??
        (window.reset_after_seconds === undefined ? null : now / 1000 + window.reset_after_seconds);

      return [
        {
          id: `${label}:${index}`,
          label: `${label} ${period}`,
          usedPercent: window.used_percent,
          resetsAt: reset === null ? null : timestamp(reset),
        },
      ];
    })
  );

  const parsedInventory = InventorySchema.safeParse(inventory);
  const list = parsedInventory.success ? parsedInventory.data : null;

  const credits = (list?.credits ?? [])
    .filter((credit) => !credit.status || credit.status === "available")
    .map((credit) => {
      const expiresAt = timestamp(credit.expires_at);

      return {
        id: credit.id,
        count: 1,
        label: credit.reset_type ?? "Full reset",
        restores:
          credit.reset_type === undefined || credit.reset_type === "codex_rate_limits"
            ? windows.flatMap((window) => (window.id ? [window.id] : []))
            : [],
        expiresAt,
        expiry: expiryStatus(credit.expires_at),
        canClaim: !expiresAt || Date.parse(expiresAt) > now,
      };
    });

  const available = body.rate_limit_reset_credits?.available_count ?? list?.available_count ?? null;
  const agrees = list === null || available === list.available_count;

  return {
    provider: "codex",
    account: { name: null, id: null },
    plan: body.plan_type ?? null,
    limited:
      limits.some(({ value }) => value?.limit_reached === true) ||
      windows.some((window) => window.usedPercent >= 100),
    windows,
    resets: {
      available,
      credits: agrees ? credits : [],
      note: inventoryNote(list === null, agrees),
    },
  };
}

function timestamp(value: z.infer<typeof ExpirySchema>) {
  if (value === null || value === undefined) {
    return null;
  }

  return new Date(typeof value === "number" ? value * 1000 : value).toISOString();
}

function windowLabel(seconds: number | null, index: number) {
  if (seconds === 18_000) {
    return "5-hour";
  }

  if (seconds === 604_800) {
    return "weekly";
  }

  return index === 0 ? "primary" : "secondary";
}

function inventoryNote(missing: boolean, agrees: boolean) {
  if (missing) {
    return "Reset inventory unavailable; expiry and claim IDs unknown.";
  }

  if (!agrees) {
    return "Reset count changed during retrieval; run usage again for expiry and claim IDs.";
  }

  return null;
}

function expiryStatus(value: z.infer<typeof ExpirySchema>): Credit["expiry"] {
  if (value === undefined) {
    return "unknown";
  }

  return value === null ? "never" : "dated";
}

const CodexBase = "https://chatgpt.com/backend-api/wham";

const AuthSchema = z.object({
  tokens: z
    .object({
      access_token: z.string().min(1),
      id_token: z.string().optional(),
      account_id: z.string().optional(),
    })
    .nullish(),
});

const IdentitySchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  sub: z.string().optional(),
  "https://api.openai.com/profile": z.object({ email: z.string().optional() }).optional(),
  "https://api.openai.com/auth": z.object({ chatgpt_account_id: z.string().optional() }).optional(),
});

interface Credentials {
  token: string;
  accountId?: string;
  accountName?: string;
  userId?: string;
}

export function createCodexUsage(
  directory: () => string,
  transport: Transport = fetch,
  now = Date.now
): UsageSource {
  return {
    provider: "codex",
    async connect() {
      const credentials = await readCredentials(directory());

      if (!credentials) {
        return null;
      }

      return {
        read: () => readCodexUsage(credentials, transport, now()),
        claimReset: (claim) =>
          claimCodexReset(credentials, claim.creditId, claim.requestId, transport),
      };
    },
  };
}

async function readCredentials(directory: string): Promise<Credentials | null> {
  const auth = await readCredentialsFile(path.join(directory, "auth.json"), AuthSchema);

  if (!auth) {
    return null;
  }

  if (!auth.tokens) {
    throw new Error(
      "Codex subscription usage requires ChatGPT login; API keys do not expose subscription limits."
    );
  }

  const identity = readIdentity(auth.tokens.id_token) ?? readIdentity(auth.tokens.access_token);

  return {
    token: auth.tokens.access_token,
    accountId:
      auth.tokens.account_id ?? identity?.["https://api.openai.com/auth"]?.chatgpt_account_id,
    userId: identity?.sub,
    accountName:
      identity?.email ?? identity?.["https://api.openai.com/profile"]?.email ?? identity?.name,
  };
}

/** JWT claims are display metadata only; the provider authenticates the original token. */
function readIdentity(token: string | undefined) {
  const payload = token?.split(".")[1];

  if (!payload) {
    return null;
  }

  try {
    const parsed = IdentitySchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"))
    );

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function readCodexUsage(
  credentials: Credentials,
  transport: Transport = fetch,
  now = Date.now()
) {
  const headers = codexHeaders(credentials);
  const body = await request("codex", `${CodexBase}/usage`, headers, {}, transport);

  const inventory = await request(
    "codex",
    `${CodexBase}/rate-limit-reset-credits`,
    headers,
    {},
    transport
  ).catch(() => null);

  return {
    ...parseCodex(body, inventory, now),
    account: {
      name: credentials.accountName ?? null,
      id: credentials.accountId ?? credentials.userId ?? null,
    },
  };
}

export async function claimCodexReset(
  credentials: Credentials,
  creditId: string,
  requestId: string,
  transport: Transport = fetch
) {
  const body = await request(
    "codex",
    `${CodexBase}/rate-limit-reset-credits/consume`,
    codexHeaders(credentials),
    {
      method: "POST",
      body: JSON.stringify({ credit_id: creditId, redeem_request_id: requestId }),
    },
    transport
  );

  const outcome = z
    .object({ code: z.enum(["reset", "already_redeemed", "nothing_to_reset", "no_credit"]) })
    .parse(body).code;

  return { outcome, success: outcome === "reset" || outcome === "already_redeemed" };
}

function codexHeaders(credentials: Credentials) {
  const headers = new Headers({
    Authorization: `Bearer ${credentials.token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
  });

  if (credentials.accountId) {
    headers.set("ChatGPT-Account-Id", credentials.accountId);
  }

  return headers;
}
