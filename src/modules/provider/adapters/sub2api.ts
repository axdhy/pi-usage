import { t } from "../../../core/i18n.ts";
import { isUrlOnDomain, safeError, sameOriginFetch } from "../../../core/security.ts";
import type { Metric, UsageAdapter, UsageSnapshot } from "../../../core/types.ts";

/**
 * First-party provider domains. A relay ("中转站", sub2api) wallet endpoint is
 * never served by one of these, so `canHandle` refuses them and leaves them to
 * the official adapters.
 */
const OFFICIAL_DOMAINS = [
  "chatgpt.com",
  "openai.com",
  "api.deepseek.com",
  "deepseek.com",
  "anthropic.com",
  "x.ai",
  "bigmodel.cn",
  "z.ai",
  "openrouter.ai",
  "opencode.ai",
  "googleapis.com",
];

const USAGE_PATH = "/v1/usage";

// Provider ids that name an explicit CLIProxyAPI/pi-bridge deployment. Those
// hosts keep the pi-bridge adapter (see `canHandle`). Provider ids on
// PI-Desktop are UUIDs, so this never shadows a relay provider there.
const BRIDGE_PROVIDER_HINTS = ["cpa", "cliproxy", "bridge", "proxy"];

type UsageBucket = Record<string, unknown>;

type Sub2ApiUsage = {
  balance?: unknown;
  remaining?: unknown;
  unit?: unknown;
  planName?: unknown;
  isValid?: unknown;
  usage?: { today?: UsageBucket; total?: UsageBucket } | null;
};

const BUCKET_FIELDS = [
  "requests",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "total_tokens",
  "cost",
  "actual_cost",
];

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bucket(value: unknown): UsageBucket | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UsageBucket : undefined;
}

function hasUsageData(bucketValue: UsageBucket | undefined): boolean {
  if (!bucketValue) return false;
  return BUCKET_FIELDS.some((field) => number(bucketValue[field]) !== undefined);
}

function bucketCost(bucketValue: UsageBucket | undefined): number | undefined {
  if (!bucketValue) return undefined;
  return number(bucketValue.cost) ?? number(bucketValue.actual_cost);
}

/**
 * The relay reports raw counters plus a cost. The balance itself is shown as a
 * bare number (its `unit` field is not authoritative), while the cost keeps the
 * `$` prefix users see on the relay dashboard.
 */
function bucketValueText(bucketValue: UsageBucket | undefined): string | undefined {
  if (!bucketValue) return undefined;
  const parts: string[] = [];
  const requests = number(bucketValue.requests);
  if (requests !== undefined) parts.push(`${Math.round(requests).toLocaleString("en-US")} req`);
  const tokens = number(bucketValue.total_tokens);
  if (tokens !== undefined) parts.push(`${Math.round(tokens).toLocaleString("en-US")} tok`);
  const cost = bucketCost(bucketValue);
  if (cost !== undefined) parts.push(`$${cost.toFixed(2)}`);
  return parts.length ? parts.join(" · ") : undefined;
}

export const sub2apiAdapter: UsageAdapter = {
  id: "sub2api",
  label: "Sub2API",
  canHandle(target) {
    if (!target.baseUrl) return false;
    try {
      new URL(target.baseUrl);
    } catch {
      return false;
    }
    // A CLIProxyAPI/pi-bridge deployment is also addressed through a custom
    // domain, so the provider id is the only way to keep it for the bridge
    // adapter. PI-Desktop provider ids are UUIDs, so relay hosts are unaffected.
    const pid = target.providerId.toLowerCase();
    if (BRIDGE_PROVIDER_HINTS.some((hint) => pid.includes(hint))) return false;
    return !OFFICIAL_DOMAINS.some((domain) => isUrlOnDomain(target.baseUrl!, domain));
  },

  async fetch({ target, signal, fetchFn }): Promise<UsageSnapshot> {
    const fetchedAt = new Date().toISOString();
    const displayName = "Sub2API";
    const apiKey = target.auth?.auth.apiKey;
    const baseUrl = target.auth?.auth.baseUrl ?? target.baseUrl;
    if (!baseUrl || !apiKey) {
      return {
        adapterId: this.id,
        sourceProviderId: target.providerId,
        displayName,
        state: "unauthorized",
        fetchedAt,
        accounts: [],
        error: "Missing base URL or API key for the relay /v1/usage endpoint",
      };
    }

    let origin: string;
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      return {
        adapterId: this.id,
        sourceProviderId: target.providerId,
        displayName,
        state: "unknown",
        fetchedAt,
        accounts: [],
        error: "The relay base URL is not a valid URL",
      };
    }

    try {
      const response = await sameOriginFetch(new URL(USAGE_PATH, origin), {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal,
      }, fetchFn, origin);

      if (response.status === 401 || response.status === 403) {
        return {
          adapterId: this.id,
          sourceProviderId: target.providerId,
          displayName,
          state: "unauthorized",
          fetchedAt,
          accounts: [],
          error: `The relay rejected the API key (HTTP ${response.status})`,
        };
      }
      if (response.status === 404) {
        return {
          adapterId: this.id,
          sourceProviderId: target.providerId,
          displayName,
          state: "unknown",
          fetchedAt,
          accounts: [],
          error: "The relay host exposes no /v1/usage endpoint",
        };
      }
      if (!response.ok) throw new Error(`The relay returned HTTP ${response.status}`);

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("json")) {
        return {
          adapterId: this.id,
          sourceProviderId: target.providerId,
          displayName,
          state: "unknown",
          fetchedAt,
          accounts: [],
          error: `The relay /v1/usage endpoint did not return JSON (content-type: ${contentType || "unset"})`,
        };
      }

      let data: Sub2ApiUsage;
      try {
        data = await response.json() as Sub2ApiUsage;
      } catch {
        return {
          adapterId: this.id,
          sourceProviderId: target.providerId,
          displayName,
          state: "unknown",
          fetchedAt,
          accounts: [],
          error: "The relay /v1/usage endpoint returned an unparseable JSON body",
        };
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return {
          adapterId: this.id,
          sourceProviderId: target.providerId,
          displayName,
          state: "unknown",
          fetchedAt,
          accounts: [],
          error: "The relay /v1/usage endpoint returned an unexpected payload",
        };
      }

      // Never rescale: `balance`/`remaining` are exactly the quota numbers the
      // user configured on the relay. `unit` is deliberately not trusted for a
      // currency symbol.
      const balanceValue = number(data.balance) ?? number(data.remaining);
      const today = bucket(data.usage?.today);
      const total = bucket(data.usage?.total);
      if (balanceValue === undefined && !hasUsageData(today) && !hasUsageData(total)) {
        return {
          adapterId: this.id,
          sourceProviderId: target.providerId,
          displayName,
          state: "unknown",
          fetchedAt,
          accounts: [],
          error: "The relay returned neither a balance nor any usage counters",
        };
      }

      const planName = typeof data.planName === "string" && data.planName ? data.planName : undefined;
      const todayCost = bucketCost(today);
      const metrics: Metric[] = [];
      if (balanceValue !== undefined) {
        metrics.push({ kind: "balance", id: "sub2api-balance", label: t("label.balance"), amount: balanceValue, currency: "" });
      }
      if (planName) {
        metrics.push({ kind: "status", id: "sub2api-plan", label: t("label.plan"), value: planName });
      }
      const todayText = bucketValueText(today);
      if (todayText) {
        metrics.push({ kind: "status", id: "sub2api-today", label: t("label.today"), value: todayText });
      }

      const summaryParts: string[] = [];
      if (balanceValue !== undefined) summaryParts.push(`${t("label.balance")} ${balanceValue.toFixed(2)}`);
      if (todayCost !== undefined) summaryParts.push(`${t("label.today")} $${todayCost.toFixed(2)}`);
      const summary = summaryParts.length ? summaryParts.join(" · ") : undefined;

      return {
        adapterId: this.id,
        sourceProviderId: target.providerId,
        displayName,
        state: "ok",
        fetchedAt,
        ...(summary ? { summary } : {}),
        accounts: [{
          id: target.providerId,
          provider: "sub2api",
          label: planName ?? displayName,
          status: data.isValid === false ? "unavailable" : "available",
          metrics,
        }],
      };
    } catch (error) {
      // A failure to reach the relay is "no usable quota data", not a crash:
      // report Unknown with a redacted reason instead of throwing at the caller.
      return {
        adapterId: this.id,
        sourceProviderId: target.providerId,
        displayName,
        state: "unknown",
        fetchedAt,
        accounts: [],
        error: safeError(error),
      };
    }
  },
};
