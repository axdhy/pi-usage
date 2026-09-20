import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDesktopIntervalSeconds } from "../src/core/desktop-settings.ts";
import { detectLocale, getLocale, setLocale } from "../src/core/i18n.ts";
import type { Metric, UsageSnapshot } from "../src/core/types.ts";
import { deepSeekAdapter } from "../src/modules/provider/adapters/deepseek.ts";
import { sub2apiAdapter } from "../src/modules/provider/adapters/sub2api.ts";
import { compactQuotaSummary, pillText, relativeTime } from "../src/ui/format.ts";

const fixture = async (name: string): Promise<string> => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const unauthorized = (displayName: string, state: UsageSnapshot["state"] = "unauthorized"): UsageSnapshot => ({
  adapterId: "none",
  sourceProviderId: "deepseek",
  displayName,
  state,
  fetchedAt: new Date().toISOString(),
  accounts: [],
});

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Restores `PI_USAGE_LOCALE` and the module locale after every scenario. */
async function withEnvironment<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setLocale("en");
  }
}

/** Writes the `kv(app, app)` row PI-Desktop stores its preferences in. */
async function writeHostLanguage(dataDir: string, value: string): Promise<void> {
  try {
    const sqlite = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new sqlite.DatabaseSync(join(dataDir, "pi.sqlite"));
    db.exec("CREATE TABLE IF NOT EXISTS kv (ns TEXT, key TEXT, value_json TEXT, updated_at INTEGER)");
    db.exec("DELETE FROM kv");
    db.prepare("INSERT INTO kv (ns, key, value_json, updated_at) VALUES (?, ?, ?, ?)").run("app", "app", value, Date.now());
    db.close();
  } catch {
    // Runtimes without `node:sqlite`: i18n falls back to scanning the file.
    await writeFile(join(dataDir, "pi.sqlite"), `kv(app/app) = ${value}`, "utf8");
  }
}

// The very first test observes the pristine module state: nothing may switch the
// language automatically, otherwise every English assertion elsewhere breaks.
test("the locale defaults to English and is never auto-detected at import time", () => {
  const previous = process.env.PI_USAGE_LOCALE;
  delete process.env.PI_USAGE_LOCALE;
  try {
    assert.equal(getLocale(), "en");
    assert.equal(relativeTime(new Date(Date.now() + 2 * 3_600_000).toISOString()), "resets in 2h");
    assert.equal(pillText(unauthorized("DeepSeek")), "DeepSeek · Unauthorized");
  } finally {
    if (previous !== undefined) process.env.PI_USAGE_LOCALE = previous;
    setLocale("en");
  }
});

test("PI_USAGE_LOCALE=zh-CN renders Chinese pills for every provider shape", async () => {
  const dataDir = await tempDir("pi-usage-zh-");
  await withEnvironment({ PI_USAGE_LOCALE: "zh-CN", PI_DESKTOP_DATA_DIR: dataDir }, async () => {
    await detectLocale();
    assert.equal(getLocale(), "zh-CN");

    // Codex: quota windows, including the `…（2 小时后重置）` wrapper.
    const windows: Array<Extract<Metric, { kind: "quota-window" }>> = [
      { kind: "quota-window", id: "primary", label: "Codex 5h", remainingFraction: 0.73, resetAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
      { kind: "quota-window", id: "secondary", label: "Codex 7d", remainingFraction: 0.55, resetAt: new Date(Date.now() + 77 * 3_600_000).toISOString() },
    ];
    const summary = compactQuotaSummary("Codex", windows);
    assert.equal(summary, "Codex · 5h 73%（2 小时后重置） · 7d 55%（3 天 5 小时后重置）");
    assert.equal(pillText({ ...unauthorized("OpenAI Codex", "ok"), summary }), summary);
    assert.ok(pillText({ ...unauthorized("OpenAI Codex", "ok"), summary })!.includes("小时"));

    // DeepSeek balance, straight from the adapter.
    const deepseekBody = await fixture("deepseek-balance.json");
    const deepseek = await deepSeekAdapter.fetch({
      target: { providerId: "deepseek", baseUrl: "https://api.deepseek.com", auth: { auth: { apiKey: "sk-test" }, source: "test" } },
      signal: new AbortController().signal,
      force: false,
      fetchFn: async () => new Response(deepseekBody, { status: 200, headers: { "content-type": "application/json" } }),
    });
    assert.equal(deepseek.summary, "余额 ¥23.41");
    assert.equal(pillText(deepseek), "DeepSeek · 余额 ¥23.41");

    // Sub2API relay wallet.
    const relayBody = await fixture("sub2api-usage.json");
    const relay = await sub2apiAdapter.fetch({
      target: { providerId: "94cea82e-6ec4-4291-bb30-ebe03520cf4f", baseUrl: "https://airopenai.cc", auth: { auth: { apiKey: "relay-key" }, source: "test" } },
      signal: new AbortController().signal,
      force: false,
      fetchFn: async () => new Response(relayBody, { status: 200, headers: { "content-type": "application/json" } }),
    });
    assert.equal(relay.summary, "余额 9999392.29 · 今日 $0.88");
    assert.equal(pillText(relay), "Sub2API · 余额 9999392.29 · 今日 $0.88");

    // Machine states stay provider-prefixed and localised.
    assert.equal(pillText(unauthorized("Sub2API", "unknown")), "Sub2API · 未知");
    assert.equal(pillText(unauthorized("DeepSeek")), "DeepSeek · 未授权");
  });
});

test("English output stays byte-identical to the previous format", async () => {
  const dataDir = await tempDir("pi-usage-en-");
  await withEnvironment({ PI_USAGE_LOCALE: "en", PI_DESKTOP_DATA_DIR: dataDir }, async () => {
    await detectLocale();
    assert.equal(getLocale(), "en");
    const windows: Array<Extract<Metric, { kind: "quota-window" }>> = [
      { kind: "quota-window", id: "primary", label: "Codex 5h", remainingFraction: 0.73, resetAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
      { kind: "quota-window", id: "secondary", label: "Codex 7d", remainingFraction: 0.55, resetAt: new Date(Date.now() + 77 * 3_600_000).toISOString() },
    ];
    assert.equal(compactQuotaSummary("Codex", windows), "Codex · 5h 73% (resets in 2h) · 7d 55% (resets in 3d 5h)");
    assert.equal(pillText(unauthorized("Sub2API", "unknown")), "Sub2API · Unknown");
    assert.equal(pillText(unauthorized("DeepSeek")), "DeepSeek · Unauthorized");
  });
});

test("detectLocale reads the client language from the host database", async () => {
  const dataDir = await tempDir("pi-usage-locale-");
  await withEnvironment({ PI_USAGE_LOCALE: undefined, PI_DESKTOP_DATA_DIR: dataDir }, async () => {
    await writeHostLanguage(dataDir, JSON.stringify({ theme: "dark", language: "zh-CN" }));
    await detectLocale();
    assert.equal(getLocale(), "zh-CN");

    // `language: "auto"` means "no explicit choice": the runtime locale wins.
    await writeHostLanguage(dataDir, JSON.stringify({ language: "auto" }));
    await detectLocale();
    assert.ok(["en", "zh-CN"].includes(getLocale()), `unexpected locale ${getLocale()}`);

    // A missing field must not throw either.
    await writeHostLanguage(dataDir, JSON.stringify({ theme: "dark" }));
    await detectLocale();
    assert.ok(["en", "zh-CN"].includes(getLocale()), `unexpected locale ${getLocale()}`);

    // A missing data directory degrades to the runtime locale, silently.
    await withEnvironment({ PI_DESKTOP_DATA_DIR: join(dataDir, "does-not-exist") }, async () => {
      await detectLocale();
      assert.ok(["en", "zh-CN"].includes(getLocale()), `unexpected locale ${getLocale()}`);
    });
  });
});

test("readDesktopIntervalSeconds reads, clamps and tolerates the plugin settings file", async () => {
  const dataDir = await tempDir("pi-usage-settings-");
  const settingsDir = join(dataDir, "plugins", "data", "imported.pi-usage");
  await mkdir(settingsDir, { recursive: true });
  const settingsFile = join(settingsDir, "settings.json");

  await withEnvironment({ PI_DESKTOP_DATA_DIR: dataDir }, async () => {
    assert.equal(await readDesktopIntervalSeconds(), undefined);
    await writeFile(settingsFile, JSON.stringify({ intervalSeconds: 300 }), "utf8");
    assert.equal(await readDesktopIntervalSeconds(), 300);
    await writeFile(settingsFile, JSON.stringify({ intervalSeconds: 5 }), "utf8");
    assert.equal(await readDesktopIntervalSeconds(), 30);
    await writeFile(settingsFile, JSON.stringify({ intervalSeconds: 99999 }), "utf8");
    assert.equal(await readDesktopIntervalSeconds(), 3600);
    await writeFile(settingsFile, JSON.stringify({ intervalSeconds: "12000" }), "utf8");
    assert.equal(await readDesktopIntervalSeconds(), undefined);
    await writeFile(settingsFile, "{ not json", "utf8");
    assert.equal(await readDesktopIntervalSeconds(), undefined);
  });
});

test("readDesktopIntervalSeconds falls back to a sibling plugin settings file", async () => {
  const dataDir = await tempDir("pi-usage-settings-fallback-");
  const other = join(dataDir, "plugins", "data", "pi.todo");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "settings.json"), JSON.stringify({ intervalSeconds: 240 }), "utf8");

  await withEnvironment({ PI_DESKTOP_DATA_DIR: dataDir }, async () => {
    assert.equal(await readDesktopIntervalSeconds(), 240);
  });
});
