/** Harness ids, as skills.sh spells them. */
export const HarnessIds = ["claude-code", "codex", "opencode"] as const;

export type HarnessId = (typeof HarnessIds)[number];
