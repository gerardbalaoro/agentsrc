export interface Window {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface Credit {
  id: string;
  count: number;
  label: string;
  expiresAt: string | null;
  expiry: "dated" | "never" | "unknown";
  canClaim: boolean;
}

export interface Snapshot {
  provider: string;
  displayName?: string;
  account: { name: string | null; id: string | null };
  plan: string | null;
  limited: boolean;
  windows: Window[];
  resets: { supported?: boolean; available: number | null; credits: Credit[]; note: string | null };
}

export interface ResetClaim {
  creditId: string;
  requestId: string;
}

export interface UsageAccount {
  read: () => Promise<Snapshot>;
  claimReset?: (claim: ResetClaim) => Promise<{ outcome: string; success: boolean }>;
}

export interface UsageSource {
  provider: string;
  connect: () => Promise<UsageAccount | null>;
}
