import { t } from "../core/i18n.ts";
import type { Metric, UsageSnapshot } from "../core/types.ts";

export function percentBar(value: number, width = 10): string {
  const count = Math.round(Math.min(1, Math.max(0, value)) * width);
  return `${"━".repeat(count)}${"─".repeat(width - count)}`;
}

export function relativeTime(value?: string): string | undefined {
  if (!value) return undefined;
  const delta = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(delta)) return undefined;
  if (delta <= 0) return t("relativeTime.resetDue");
  const minutes = Math.ceil(delta / 60000);
  if (minutes < 60) return t("relativeTime.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 48) {
    return mins ? t("relativeTime.hours", { h: hours, m: mins }) : t("relativeTime.hoursOnly", { h: hours });
  }
  return t("relativeTime.days", { d: Math.floor(hours / 24), h: hours % 24 });
}

type QuotaWindowMetric = Extract<Metric, { kind: "quota-window" }>;

export function compactQuotaSummary(
  providerLabel: string,
  metrics: QuotaWindowMetric[],
  maxWindows = metrics.length,
): string | undefined {
  const selected = metrics.slice(0, Math.max(0, maxWindows));
  if (!selected.length) return undefined;
  const escaped = providerLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = new RegExp(`^${escaped}\\s+`, "i");
  const parts = selected.map((metric) => {
    const label = metric.label.replace(prefix, "");
    const reset = relativeTime(metric.resetAt);
    return `${label} ${Math.round(metric.remainingFraction * 100)}%${reset ? t("wrapper.reset", { text: reset }) : ""}`;
  });
  return `${providerLabel} · ${parts.join(" · ")}`;
}

export function metricText(metric: Metric): string {
  switch (metric.kind) {
    case "balance": {
      // An empty currency means "no currency symbol and no separator space" (a
      // relay balance is a bare quota number, not necessarily USD).
      const symbol = metric.currency === "CNY" || metric.currency === "RMB" ? "¥" : metric.currency === "USD" ? "$" : metric.currency ? `${metric.currency} ` : "";
      return `${metric.label}: ${symbol}${metric.amount.toFixed(2)}${metric.detail ? ` · ${metric.detail}` : ""}`;
    }
    case "quota-window": {
      const reset = relativeTime(metric.resetAt);
      return `${metric.label} ${percentBar(metric.remainingFraction)} ${t("percentLeft", { n: Math.round(metric.remainingFraction * 100) })}${reset ? ` · ${reset}` : ""}`;
    }
    case "usage-limit": return `${metric.label}: ${metric.used}/${metric.limit} ${metric.unit}`;
    case "status": return `${metric.label}: ${metric.value}`;
  }
}

export function compactSnapshot(snapshot?: UsageSnapshot): string {
  if (!snapshot) return t("loading");
  if (snapshot.state !== "ok" && snapshot.state !== "stale") {
    switch (snapshot.state) {
      case "unauthorized": return `${snapshot.displayName} · ${t("state.unauthorized")}`;
      case "not-installed": return `${snapshot.displayName} · ${t("state.bridgeNotFound")}`;
      case "unsupported": return `${snapshot.displayName} · ${t("state.unsupported")}`;
      case "unknown": return `${snapshot.displayName} · ${t("state.unknown")}`;
      case "empty": return snapshot.summary ? `${snapshot.displayName} · ${snapshot.summary}` : `${snapshot.displayName} · ${t("state.noQuota")}`;
      default: return `${snapshot.displayName} · ${snapshot.state}`;
    }
  }
  return `${snapshot.summary ?? snapshot.displayName}${snapshot.stale ? ` · ${t("state.stale")}` : ""}`;
}

const MAX_PILL_LENGTH = 140;

/**
 * One-line status text for PI-Desktop's status pills. Prefers the adapter's
 * pre-built summary, falls back to the formatted metrics, and truncates to keep
 * the pill readable.
 */
export function pillText(snapshot: UsageSnapshot): string {
  const text = pillBody(snapshot);
  return text.length <= MAX_PILL_LENGTH ? text : `${text.slice(0, MAX_PILL_LENGTH - 1)}…`;
}

function pillBody(snapshot: UsageSnapshot): string {
  if (snapshot.state !== "ok" && snapshot.state !== "stale") return compactSnapshot(snapshot);
  const name = snapshot.displayName;
  if (snapshot.summary) {
    // `Codex · 5h 92% …` already names the provider family; only add the
    // provider label when the summary shares no word with it (`DeepSeek`).
    const sharesWord = name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((word) => word.length > 2 && snapshot.summary!.toLowerCase().includes(word));
    return sharesWord ? snapshot.summary : `${name} · ${snapshot.summary}`;
  }
  const metrics = snapshot.accounts.flatMap((account) => account.metrics).map(metricText);
  if (metrics.length) return `${name} · ${metrics.join(" · ")}`;
  return compactSnapshot(snapshot);
}

export function snapshotLines(snapshot: UsageSnapshot): string[] {
  const lines = [`${snapshot.displayName} [${snapshot.state}]${snapshot.stale ? ` · ${t("state.stale")}` : ""}`];
  if (snapshot.error) lines.push(`  ${t("line.error")}: ${snapshot.error}`);
  if (snapshot.diagnostic) lines.push(`  ${snapshot.diagnostic}`);
  for (const account of snapshot.accounts) {
    const flags = [account.status, account.disabled ? t("flag.disabled") : undefined, account.unavailable ? t("flag.unavailable") : undefined].filter(Boolean).join(", ");
    lines.push(`  ${account.provider} · ${account.label}${flags ? ` (${flags})` : ""}`);
    if (account.error) lines.push(`    ${t("line.error")}: ${account.error}`);
    if (!account.metrics.length) lines.push(`    ${t("line.noQuotaReported")}`);
    for (const metric of account.metrics) lines.push(`    ${metricText(metric)}`);
  }
  return lines;
}
