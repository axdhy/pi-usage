import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopDataDir } from "./local-auth.ts";

/**
 * The extension runs inside PI-Desktop's agent sidecar, which exposes no
 * locale/settings API on the bridge or on `ctx`. The only way to follow the
 * client language is to read the host's own files:
 *
 * - `<dataDir>/pi.sqlite` -> `kv(ns, key, value_json)` row `app/app`, whose JSON
 *   carries the `language` field (`auto` | `en` | `zh-CN` | ...).
 * - fallback: Node's own locale (`Intl.DateTimeFormat().resolvedOptions()`),
 *   which is what Electron's `app.getLocale()` resolves to on the same machine.
 *
 * Everything here is read-only and silent: a missing runtime, database or field
 * must never fail extension startup.
 */

export type Locale = "zh-CN" | "en";

export type I18nKey =
  | "relativeTime.resetDue"
  | "relativeTime.minutes"
  | "relativeTime.hours"
  | "relativeTime.hoursOnly"
  | "relativeTime.days"
  | "wrapper.reset"
  | "percentLeft"
  | "loading"
  | "state.unauthorized"
  | "state.bridgeNotFound"
  | "state.unsupported"
  | "state.unknown"
  | "state.noQuota"
  | "state.stale"
  | "label.balance"
  | "label.plan"
  | "label.today"
  | "line.error"
  | "line.noQuotaReported"
  | "flag.disabled"
  | "flag.unavailable"
  | "settings.desktopOverride"
  | "details.title"
  | "details.empty"
  | "close.hint"
  | "skills.title"
  | "skills.empty"
  | "skills.headerSkill"
  | "skills.headerUses"
  | "skills.installed"
  | "settings.usage"
  | "settings.config"
  | "settings.saved"
  | "usage.hint"
  | "usage.skillsHint"
  | "doctor.model"
  | "doctor.baseUrl"
  | "doctor.adapter"
  | "doctor.state"
  | "doctor.auth"
  | "doctor.deepSeekAuth"
  | "doctor.activeProvider"
  | "doctor.authMissing"
  | "doctor.authResolved"
  | "doctor.originMissing"
  | "doctor.originInvalid"
  | "doctor.configured"
  | "doctor.configuredWithSource"
  | "doctor.notConfigured"
  | "doctor.hint"
  | "doctor.problem"
  | "doctor.fix";

const MESSAGES: Record<I18nKey, Record<Locale, string>> = {
  "relativeTime.resetDue": { en: "reset due", "zh-CN": "即将重置" },
  "relativeTime.minutes": { en: "resets in {n}m", "zh-CN": "{n} 分钟后重置" },
  "relativeTime.hours": { en: "resets in {h}h {m}m", "zh-CN": "{h} 小时 {m} 分钟后重置" },
  "relativeTime.hoursOnly": { en: "resets in {h}h", "zh-CN": "{h} 小时后重置" },
  "relativeTime.days": { en: "resets in {d}d {h}h", "zh-CN": "{d} 天 {h} 小时后重置" },
  "wrapper.reset": { en: " ({text})", "zh-CN": "（{text}）" },
  percentLeft: { en: "{n}% left", "zh-CN": "剩余 {n}%" },
  loading: { en: "Loading...", "zh-CN": "加载中…" },
  "state.unauthorized": { en: "Unauthorized", "zh-CN": "未授权" },
  "state.bridgeNotFound": { en: "Bridge Not Found", "zh-CN": "未安装桥接" },
  "state.unsupported": { en: "Unsupported", "zh-CN": "不支持" },
  "state.unknown": { en: "Unknown", "zh-CN": "未知" },
  "state.noQuota": { en: "No Quota", "zh-CN": "无额度" },
  "state.stale": { en: "stale", "zh-CN": "数据过期" },
  "label.balance": { en: "Balance", "zh-CN": "余额" },
  "label.plan": { en: "Plan", "zh-CN": "套餐" },
  "label.today": { en: "Today", "zh-CN": "今日" },
  "line.error": { en: "Error", "zh-CN": "错误" },
  "line.noQuotaReported": { en: "No quota reported", "zh-CN": "未返回额度" },
  "flag.disabled": { en: "disabled", "zh-CN": "已禁用" },
  "flag.unavailable": { en: "unavailable", "zh-CN": "不可用" },
  "settings.desktopOverride": {
    en: "Desktop plugin settings override refresh.intervalSeconds",
    "zh-CN": "桌面插件设置已覆盖刷新间隔",
  },
  "details.title": { en: "Pi Usage · Provider Usage", "zh-CN": "Pi Usage · 服务商用量" },
  "details.empty": { en: "No usage data available.", "zh-CN": "暂无用量数据。" },
  "close.hint": { en: "Enter/Esc close", "zh-CN": "回车/Esc 关闭" },
  "skills.title": { en: "Pi Usage · Installed Skill Usage", "zh-CN": "Pi Usage · 技能使用统计" },
  "skills.empty": { en: "No installed skills found.", "zh-CN": "未发现已安装的 Skill。" },
  "skills.headerSkill": { en: "Skill", "zh-CN": "技能" },
  "skills.headerUses": { en: "Uses", "zh-CN": "次数" },
  "skills.installed": { en: "{n} installed skill{s}.", "zh-CN": "已安装 {n} 个技能。" },
  "settings.usage": {
    en: "Usage: /usage settings [widget|status|skills] [on|off], or interval/timeout <seconds>",
    "zh-CN": "用法：/usage settings [widget|status|skills] [on|off]，或 interval/timeout <秒数>",
  },
  "settings.config": { en: "Config: {path}", "zh-CN": "配置：{path}" },
  "settings.saved": { en: "Pi Usage settings saved to {path}", "zh-CN": "Pi Usage 设置已保存到 {path}" },
  "usage.hint": {
    en: "Usage: /usage [all|current|refresh|doctor|skills|settings]",
    "zh-CN": "用法：/usage [all|current|refresh|doctor|skills|settings]",
  },
  "usage.skillsHint": { en: "Usage: /usage skills", "zh-CN": "用法：/usage skills" },
  "doctor.model": { en: "Model: {value}", "zh-CN": "模型：{value}" },
  "doctor.baseUrl": { en: "Provider base URL: {value}", "zh-CN": "服务商地址：{value}" },
  "doctor.adapter": { en: "Current adapter: {value}", "zh-CN": "当前适配器：{value}" },
  "doctor.state": { en: "Current state: {value}", "zh-CN": "当前状态：{value}" },
  "doctor.auth": { en: "Current auth: {value}", "zh-CN": "当前认证：{value}" },
  "doctor.deepSeekAuth": { en: "DeepSeek auth: {value}", "zh-CN": "DeepSeek 认证：{value}" },
  // Used when no model is active: `Hint: /usage current shows only the active provider; ...`.
  "doctor.activeProvider": { en: "the active provider", "zh-CN": "当前服务商" },
  "doctor.authMissing": { en: "missing or rejected", "zh-CN": "缺失或被拒绝" },
  "doctor.authResolved": { en: "resolved without displaying secret", "zh-CN": "已解析（未显示密钥）" },
  "doctor.originMissing": { en: "not exposed by model", "zh-CN": "模型未提供" },
  "doctor.originInvalid": { en: "invalid provider URL", "zh-CN": "服务商地址无效" },
  "doctor.configured": { en: "configured", "zh-CN": "已配置" },
  "doctor.configuredWithSource": { en: "configured ({source})", "zh-CN": "已配置（{source}）" },
  "doctor.notConfigured": { en: "not configured", "zh-CN": "未配置" },
  "doctor.hint": {
    en: "Hint: /usage current shows only {provider}; use /usage all for DeepSeek plus other configured providers.",
    "zh-CN": "提示：/usage current 只显示 {provider}；用 /usage all 可以看到 DeepSeek 等其它已配置服务商。",
  },
  "doctor.problem": { en: "Problem: {error}", "zh-CN": "问题：{error}" },
  "doctor.fix": {
    en: "Fix: install and enable pi-bridge on the CLIProxyAPI server.",
    "zh-CN": "修复：请在 CLIProxyAPI 服务端安装并启用 pi-bridge。",
  },
};

const ENV_OVERRIDE = "PI_USAGE_LOCALE";
const LANGUAGE_PATTERN = /"language"\s*:\s*"([A-Za-z-]{2,10})"/g;

/** Anything that starts with `zh` renders with the simplified Chinese strings. */
function normalize(locale: string): Locale {
  const value = locale.trim().toLowerCase();
  if (!value || value === "auto") return "en";
  return value.startsWith("zh") ? "zh-CN" : "en";
}

// Deliberately NOT detected at import time: the default must stay English so a
// host without a readable preference never changes existing output.
let current: Locale = "en";

export function setLocale(locale: string): void {
  current = normalize(locale);
}

export function getLocale(): Locale {
  return current;
}

/** Text for `key` in the active locale, with `{name}` placeholders substituted. */
export function t(key: I18nKey, params?: Record<string, string | number>): string {
  const template = MESSAGES[key][current] ?? MESSAGES[key].en;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match);
}

interface SqliteStatement {
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

/**
 * `node:sqlite` is experimental and may be unavailable in the bundled sidecar
 * runtime; `import` is dynamic so a missing module degrades to the scan path.
 */
async function languageViaSqlite(file: string): Promise<string | undefined> {
  let sqlite: SqliteModule;
  try {
    sqlite = (await import("node:sqlite")) as unknown as SqliteModule;
  } catch {
    return undefined;
  }
  if (typeof sqlite?.DatabaseSync !== "function") return undefined;

  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const row = db
      .prepare("SELECT value_json FROM kv WHERE ns = ? AND key = ? LIMIT 1")
      .get("app", "app") as { value_json?: unknown } | undefined;
    const raw = row?.value_json;
    if (typeof raw !== "string" || !raw) return undefined;
    const parsed = JSON.parse(raw) as { language?: unknown };
    return typeof parsed.language === "string" ? parsed.language : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a half-open handle is not interesting.
    }
  }
}

/**
 * Byte-scan fallback for runtimes without `node:sqlite`. The WAL is scanned
 * last because it holds the most recent commit.
 */
async function languageViaScan(files: string[]): Promise<string | undefined> {
  let found: string | undefined;
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(LANGUAGE_PATTERN)) {
      if (match[1]) found = match[1];
    }
  }
  return found;
}

async function hostLanguage(): Promise<string | undefined> {
  const dataDir = desktopDataDir();
  const file = join(dataDir, "pi.sqlite");
  const viaSqlite = await languageViaSqlite(file);
  if (viaSqlite) return viaSqlite;
  return languageViaScan([file, join(dataDir, "pi.sqlite-wal")]);
}

function systemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the display language: `PI_USAGE_LOCALE` (tests/CLI override), then the
 * host's stored preference, then the runtime locale. Never throws.
 */
export async function detectLocale(): Promise<void> {
  try {
    const override = process.env[ENV_OVERRIDE]?.trim();
    if (override) {
      setLocale(override);
      return;
    }
    const stored = await hostLanguage();
    if (stored && stored.trim() && stored.trim().toLowerCase() !== "auto") {
      // Only `zh*` renders as Chinese; every other host language is English.
      setLocale(stored);
      return;
    }
    setLocale(systemLocale() ?? "en");
  } catch {
    setLocale("en");
  }
}

/** Same as `detectLocale`, named for the session_start boot path. */
export async function initLocale(): Promise<void> {
  await detectLocale();
}
