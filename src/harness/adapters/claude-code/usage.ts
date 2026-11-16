import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

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

const ClaudeWindowSchema = z.object({
  utilization: PercentSchema,
  resets_at: z.string().datetime({ offset: true }).nullish(),
});

const GrantsSchema = z.object({
  eligible: z.boolean(),
  ineligible_reason: z.string().nullish(),
  grants: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_-]{1,40}$/u),
        resets_left: CountSchema,
        ends_at: ExpirySchema,
        paused: z.boolean().optional(),
        usable_now: z.boolean().optional(),
        clears: z.array(z.string()).optional(),
        type: z.string().optional(),
        gives_back_weekly: z.boolean().optional(),
      })
    )
    .optional(),
});

const ClaudeSchema = z.object({ cedar_ember: z.unknown().optional() }).catchall(z.unknown());

export function parseClaude(raw: unknown, now: number): Snapshot {
  const body = ClaudeSchema.parse(raw);

  const windows = Object.entries(body).flatMap(([key, value]) => {
    if (
      key === "seven_day_breakdown" ||
      (!key.startsWith("five_hour") && !key.startsWith("seven_day"))
    ) {
      return [];
    }

    if (value === null) {
      return [];
    }

    const window = ClaudeWindowSchema.parse(value);

    return [
      {
        id: key,
        label: key.replaceAll("_", " "),
        usedPercent: window.utilization,
        resetsAt: window.resets_at ?? null,
      },
    ];
  });

  const parsedGrants = GrantsSchema.safeParse(body.cedar_ember);
  const grants = parsedGrants.success ? parsedGrants.data : null;

  const credits = (grants?.grants ?? []).map((grant) => {
    const expiresAt = timestamp(grant.ends_at);

    return {
      id: grant.id,
      count: grant.resets_left,
      label: grant.gives_back_weekly
        ? "Fable reset (returns Fable weekly usage)"
        : (grant.type ?? ((grant.clears ?? []).join(", ") || "Reset")),
      expiresAt,
      restores: grant.clears ?? [],
      expiry: expiryStatus(grant.ends_at),
      canClaim:
        grants?.eligible === true &&
        grant.usable_now === true &&
        !grant.paused &&
        grant.resets_left > 0 &&
        (!expiresAt || Date.parse(expiresAt) > now),
    };
  });

  return {
    provider: "claude",
    account: { name: null, id: null },
    plan: null,
    windows,
    limited: windows.some((window) => window.usedPercent >= 100),
    resets: {
      available: grants
        ? credits.filter((credit) => credit.canClaim).reduce((sum, credit) => sum + credit.count, 0)
        : null,
      credits,
      note: grantNote(grants),
    },
  };
}

function timestamp(value: z.infer<typeof ExpirySchema>) {
  if (value === null || value === undefined) {
    return null;
  }

  return new Date(typeof value === "number" ? value * 1000 : value).toISOString();
}

function grantNote(grants: z.infer<typeof GrantsSchema> | null | undefined) {
  if (!grants) {
    return "Reset grants not reported.";
  }

  if (!grants.eligible) {
    return `Not eligible for resets: ${grants.ineligible_reason ?? "provider restriction"}.`;
  }

  return null;
}

function expiryStatus(value: z.infer<typeof ExpirySchema>): Credit["expiry"] {
  if (value === undefined) {
    return "unknown";
  }

  return value === null ? "never" : "dated";
}

const Run = promisify(execFile);
const ClaudeBase = "https://api.anthropic.com/api";

const AuthSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1) }).optional(),
});

const ConfigSchema = z.object({
  oauthAccount: z
    .object({
      organizationUuid: z.string().optional(),
      accountUuid: z.string().optional(),
      emailAddress: z.string().optional(),
      displayName: z.string().optional(),
    })
    .optional(),
});

interface Credentials {
  token: string;
  accountId?: string;
  accountName?: string;
  organizationId?: string;
}

export function createClaudeUsage(
  directory: () => string,
  configFile: () => string,
  transport: Transport = fetch,
  now = Date.now
): UsageSource {
  return {
    provider: "claude",
    async connect() {
      const credentials = await readCredentials(directory(), configFile());

      if (!credentials) {
        return null;
      }

      return {
        read: () => readClaudeUsage(credentials, transport, now()),
        claimReset: (claim) =>
          claimClaudeReset(credentials, claim.creditId, claim.requestId, transport),
      };
    },
  };
}

async function readCredentials(directory: string, configFile: string): Promise<Credentials | null> {
  let auth = await readCredentialsFile(path.join(directory, ".credentials.json"), AuthSchema);

  if (auth === null && process.platform === "darwin") {
    try {
      const result = await Run(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 5000 }
      );

      auth = AuthSchema.parse(JSON.parse(result.stdout));
    } catch {
      return null;
    }
  }

  if (!auth?.claudeAiOauth) {
    return null;
  }

  const config = await readCredentialsFile(configFile, ConfigSchema);

  return {
    token: auth.claudeAiOauth.accessToken,
    accountId: config?.oauthAccount?.accountUuid,
    accountName: config?.oauthAccount?.emailAddress ?? config?.oauthAccount?.displayName,
    organizationId: config?.oauthAccount?.organizationUuid,
  };
}

export async function readClaudeUsage(
  credentials: Credentials,
  transport: Transport = fetch,
  now = Date.now()
) {
  const body = await request(
    "claude",
    `${ClaudeBase}/oauth/usage?cedar_ember=1`,
    claudeHeaders(credentials),
    {},
    transport
  );

  return {
    ...parseClaude(body, now),
    account: { name: credentials.accountName ?? null, id: credentials.accountId ?? null },
  };
}

export async function claimClaudeReset(
  credentials: Credentials,
  creditId: string,
  requestId: string,
  transport: Transport = fetch
) {
  if (!/^[a-z0-9_-]{1,40}$/u.test(creditId)) {
    throw new Error("Invalid Claude grant ID.");
  }

  if (!credentials.organizationId) {
    throw new Error("Claude organization is missing. Sign in with Claude Code again.");
  }

  const body = await request(
    "claude",
    `${ClaudeBase}/organizations/${encodeURIComponent(credentials.organizationId)}/reset_rate_limits`,
    claudeHeaders(credentials),
    {
      method: "POST",
      body: JSON.stringify({ program: "cedar_ember", grant_id: creditId, request_id: requestId }),
    },
    transport
  );

  const outcome = z
    .object({
      result: z.enum([
        "reset",
        "already_used",
        "not_limited",
        "cooldown",
        "ineligible",
        "unavailable",
      ]),
    })
    .parse(body).result;

  return { outcome, success: outcome === "reset" || outcome === "already_used" };
}

function claudeHeaders(credentials: Credentials) {
  return {
    Authorization: `Bearer ${credentials.token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-cli/2.1.294 (external, cli)",
  };
}
