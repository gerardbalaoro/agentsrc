import { Ui } from "#ui.ts";
import type { Snapshot } from "#usage/model.ts";

export function createReport(snapshot: Snapshot, now: number) {
  return {
    ...snapshot,
    resets: {
      ...snapshot.resets,
      credits: snapshot.resets.credits.map((credit) => ({ ...credit })),
    },
    fetchedAt: new Date(now).toISOString(),
    windows: snapshot.windows.map((window) => ({
      ...window,
      remainingPercent: Math.max(0, 100 - window.usedPercent),
      status: windowStatus(window, now),
    })),
  };
}

export function reportTitle(report: ReturnType<typeof createReport>, color = false) {
  const name =
    report.displayName ?? `${report.provider.charAt(0).toUpperCase()}${report.provider.slice(1)}`;

  const account = report.account.name ?? report.account.id ?? "account unknown";

  return `${Ui.style(["bold", "cyan"], name, color)} · ${Ui.style("dim", account, color)}${report.limited ? Ui.style(["bold", "red"], " · LIMIT REACHED", color) : ""}`;
}

export function formatReport(report: ReturnType<typeof createReport>, now: number, color = false) {
  const labels = report.windows.map((window) => shortLabel(window.label));
  const width = Math.max(0, ...labels.map((label) => label.length));

  const lines = report.windows.map((window, index) => {
    const remaining = Math.max(0, Math.min(100, window.remainingPercent));
    const filled = Math.round((remaining / 100) * 8);
    const tone = allowanceColor(remaining);
    const bar = `${Ui.style(tone, "█".repeat(filled), color)}${Ui.style("dim", "░".repeat(8 - filled), color)}`;
    const reset = window.resetsAt ? `resets ${countdown(window.resetsAt, now)}` : "reset unknown";

    const status = statusLabel(window);

    const percentage = Ui.style(["bold", tone], `${Math.round(remaining)}% left`, color);

    const warning = status
      ? ` · ${Ui.style(window.status === "limited" ? "red" : "yellow", status, color)}`
      : "";

    return `${(labels[index] ?? "").padEnd(width)}  ${bar}  ${percentage} · ${Ui.style("dim", reset, color)}${warning}`;
  });

  if (lines.length === 0) {
    lines.push("No limits reported");
  }

  if (report.resets.supported !== false && (report.resets.available ?? 0) > 0) {
    lines.push(resetSummary(report.resets, now, color));
  }

  return lines.join("\n");
}

function shortLabel(label: string) {
  return label
    .replace(/^Usage /u, "")
    .replace(/^five hour/u, "5h")
    .replace(/^seven day/u, "Weekly")
    .replace("5-hour", "5h")
    .replace("weekly", "Weekly");
}

function statusLabel(window: ReturnType<typeof createReport>["windows"][number]) {
  if (window.status === "awaiting_refresh") {
    return "refresh due";
  }

  if (window.status === "limited") {
    return "limit reached";
  }

  return null;
}

function resetSummary(resets: Snapshot["resets"], now: number, color: boolean) {
  const prefix = `Resets ${Ui.style("cyan", String(resets.available), color)} available  · `;
  const live = resets.credits.filter((credit) => credit.canClaim);
  const [next] = live.flatMap((credit) => (credit.expiresAt ? [credit.expiresAt] : [])).toSorted();

  if (next) {
    const hours = (Date.parse(next) - now) / 3_600_000;
    const timing = countdown(next, now);
    const label = timing.startsWith("in ") ? "next expires in " : "next expires ";

    return `${prefix}${Ui.style("dim", label, color)}${Ui.style(expiryColor(hours), timing.replace(/^in /u, ""), color)}`;
  }

  const neverExpire = live.length > 0 && live.every((credit) => credit.expiry === "never");

  return `${prefix}${Ui.style("dim", neverExpire ? "does not expire" : "expiry unknown", color)}`;
}

function countdown(at: string, now: number) {
  const minutes = Math.ceil((Date.parse(at) - now) / 60_000);

  if (minutes <= 0) {
    return "now";
  }

  if (minutes < 60) {
    return `in ${minutes}m`;
  }

  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;

    return `in ${hours}h${remainder ? ` ${remainder}m` : ""}`;
  }

  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);

  return `in ${days}d${hours ? ` ${hours}h` : ""}`;
}

function windowStatus(window: Snapshot["windows"][number], now: number) {
  if (window.resetsAt && Date.parse(window.resetsAt) <= now) {
    return "awaiting_refresh";
  }

  return window.usedPercent >= 100 ? "limited" : "available";
}

function allowanceColor(remaining: number): "red" | "yellow" | "green" {
  if (remaining <= 20) {
    return "red";
  }

  if (remaining <= 50) {
    return "yellow";
  }

  return "green";
}

function expiryColor(hours: number): "red" | "yellow" | "dim" {
  if (hours < 12) {
    return "red";
  }

  if (hours < 24) {
    return "yellow";
  }

  return "dim";
}
