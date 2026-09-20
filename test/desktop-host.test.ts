import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { UsageSnapshot } from "../src/core/types.ts";
import extension from "../src/index.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import {
  localProviderEntries,
  readSecretStore,
  resolveLocalAuth,
} from "../src/core/local-auth.ts";
import { ProviderUsageController } from "../src/modules/provider/controller.ts";
import { pillText } from "../src/ui/format.ts";

/**
 * PI-Desktop host simulation.
 *
 * The sidecar injects a deliberately incomplete host API: `ctx.ui` has no
 * `theme`, and `ctx.modelRegistry` has no `getProvider`/`getProviderAuth`/
 * `getRegisteredProviderIds`. Nothing here may throw or read a theme.
 */

const CODEX_PROVIDER = "8fd0bf45-2add-4c42-877d-117d6cd3d060";
const DEEPSEEK_MODEL = { provider: "deepseek", id: "deepseek-chat", baseUrl: "https://api.deepseek.com" };
const CODEX_MODEL = { provider: CODEX_PROVIDER, id: "gpt-5.6-terra", baseUrl: "https://chatgpt.com/backend-api" };

const fixture = async (name: string): Promise<string> => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function secretFileName(secretRef: string): string {
  return createHash("sha256").update(secretRef).digest("hex");
}

function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64");
}

interface DesktopFixture {
  dataDir: string;
  agentDir: string;
  key: Buffer;
}

async function makeDesktopFixture(): Promise<DesktopFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-usage-desktop-"));
  const dataDir = join(root, "desktop");
  const agentDir = join(root, "agent");
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const key = randomBytes(32);
  await writeFile(join(dataDir, "secrets", ".machine-key"), key);
  return { dataDir, agentDir, key };
}

async function writeSecret(fixture: DesktopFixture, secretRef: string, plaintext: string): Promise<void> {
  const encoded = encryptSecret(plaintext, fixture.key);
  await writeFile(join(fixture.dataDir, "secrets", `${secretFileName(secretRef)}.bin`), encoded, "utf8");
}

async function withIsolatedEnv<T>(fixture: DesktopFixture, run: () => Promise<T>): Promise<T> {
  const previousData = process.env.PI_DESKTOP_DATA_DIR;
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousLocale = process.env.PI_USAGE_LOCALE;
  process.env.PI_DESKTOP_DATA_DIR = fixture.dataDir;
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  // Pin the language: the extension resolves it from the client database and
  // `Intl` at session start, and every assertion in this file is English.
  process.env.PI_USAGE_LOCALE = "en";
  try {
    return await run();
  } finally {
    if (previousData === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = previousData;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousLocale === undefined) delete process.env.PI_USAGE_LOCALE;
    else process.env.PI_USAGE_LOCALE = previousLocale;
  }
}

interface FakeHost {
  ctx: any;
  statuses: Array<{ key: string; text: string | undefined }>;
  widgetCalls: () => number;
  themeReads: () => number;
  notifications: string[];
}

function desktopContext(options: {
  model: { provider: string; id: string; baseUrl: string };
  cwd: string;
  hostileTheme?: boolean;
}): FakeHost {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  let widgetCalls = 0;
  let themeReads = 0;
  const notifications: string[] = [];
  const ui: Record<string, unknown> = {
    notify: (message: string) => { notifications.push(String(message)); },
    setStatus: (key: string, text: string | undefined) => { statuses.push({ key, text }); },
    setWidget: () => { widgetCalls += 1; },
    confirm: async () => false,
    select: async () => undefined,
    input: async () => undefined,
  };

  if (options.hostileTheme) {
    Object.defineProperty(ui, "theme", {
      configurable: true,
      get() {
        themeReads += 1;
        throw new Error("theme must not be read");
      },
    });
  }

  // Deliberately missing: getProvider, getProviderAuth, getRegisteredProviderIds.
  const modelRegistry = {
    getAll: () => [],
    getAvailable: () => [],
    find: () => undefined,
    getProviderDisplayName: (id: string) => id,
    getProviderAuthStatus: () => ({ configured: false }),
    hasConfiguredAuth: () => false,
  };

  return {
    ctx: { model: options.model, cwd: options.cwd, ui, modelRegistry, mode: "desktop" },
    statuses,
    widgetCalls: () => widgetCalls,
    themeReads: () => themeReads,
    notifications,
  };
}

const registeredCommands = new Map<string, (args: string, ctx: any) => Promise<unknown>>();

function loadExtension(): Map<string, (event: any, ctx: any) => Promise<unknown>> {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
  const pi = {
    registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<unknown> }) => {
      registeredCommands.set(name, options.handler);
    },
    on: (name: string, handler: (event: any, ctx: any) => Promise<unknown>) => { handlers.set(name, handler); },
    getCommands: () => [],
  };
  extension(pi as any);
  return handlers;
}

test("desktop session_start renders provider pills without ever using ctx.ui.theme", async () => {
  const desktop = await makeDesktopFixture();
  await writeSecret(desktop, `secret:provider:${CODEX_PROVIDER}:oauth`, JSON.stringify({
    type: "oauth",
    access: "fake-access-token",
    refresh: "fake-refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "dddd6bf6-e6e5-4e5e-b2e1-61ded58c5710",
  }));
  await writeFile(join(desktop.dataDir, "pi-usage-local.json"), JSON.stringify({
    version: 1,
    providers: [{ providerId: CODEX_PROVIDER, label: "Codex", baseUrl: "https://chatgpt.com/backend-api", kind: "oauth" }],
  }), "utf8");

  const codexBody = await fixture("openai-codex-usage.json");
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: any) => {
    requested.push(String(input));
    if (String(input).includes("chatgpt.com")) {
      return new Response(codexBody, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);

  try {
    await withIsolatedEnv(desktop, async () => {
      const handlers = loadExtension();
      const host = desktopContext({ model: CODEX_MODEL, cwd: desktop.dataDir, hostileTheme: true });

      await handlers.get("session_start")!({ type: "session_start" }, host.ctx);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const pills = host.statuses.filter((entry) => entry.text !== undefined);
      assert.ok(pills.length > 0, "expected at least one status pill");
      assert.ok(pills.some((pill) => pill.key === `pi-usage:${CODEX_PROVIDER}`), `expected a pi-usage pill per provider, got ${JSON.stringify(pills)}`);
      assert.match(pills.map((pill) => pill.text).join(" | "), /%/, "Codex 5h/7d quota pill must contain a percentage");
      assert.ok(requested.some((url) => url.includes("chatgpt.com/backend-api/wham/usage")));

      // The host theme is actively hostile; rendering must still work.
      assert.throws(() => (host.ctx.ui as any).theme, /theme must not be read/);
      // ...and the widget stays untouched because display.widget defaults to false.
      assert.equal(host.widgetCalls(), 0);

      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(unhandled, []);

      await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, host.ctx);
      const last = host.statuses.at(-1);
      assert.equal(last?.text, undefined, "shutdown must clear every desktop pill");
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.off("unhandledRejection", onUnhandled);
  }
});

test("desktop secret store supplies the DeepSeek API key to the adapter", async () => {
  const desktop = await makeDesktopFixture();
  await writeSecret(desktop, "secret:provider:deepseek:api_key", "sk-test-deepseek-key");
  await writeFile(join(desktop.dataDir, "pi-usage-local.json"), JSON.stringify({
    version: 1,
    providers: [{ providerId: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", kind: "api_key" }],
  }), "utf8");

  const deepseekBody = await fixture("deepseek-balance.json");
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(deepseekBody, { status: 200, headers: { "content-type": "application/json" } });
  };
  const controller = new ProviderUsageController(DEFAULT_CONFIG, mockFetch);

  await withIsolatedEnv(desktop, async () => {
    const host = desktopContext({ model: DEEPSEEK_MODEL, cwd: desktop.dataDir });
    const snapshots = await controller.refreshLocal(host.ctx, true);

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.state, "ok");
    const balance = calls.find((call) => call.url.includes("api.deepseek.com/user/balance"));
    assert.ok(balance, "expected a DeepSeek balance request");
    assert.equal(balance.headers.Authorization, "Bearer sk-test-deepseek-key");
  });
});

test("refreshAll tolerates a registry without credential APIs", async () => {
  const desktop = await makeDesktopFixture();
  const controller = new ProviderUsageController(DEFAULT_CONFIG, async () => new Response("{}", { status: 200 }));

  const registry = {
    getAll: () => [CODEX_MODEL],
    getAvailable: () => [CODEX_MODEL],
    find: () => undefined,
    // getRegisteredProviderIds / getProvider / getProviderAuth intentionally absent.
  };
  const ctx: any = { model: CODEX_MODEL, cwd: desktop.dataDir, ui: {}, modelRegistry: registry };

  await withIsolatedEnv(desktop, async () => {
    const snapshots = await controller.refreshAll(ctx, true);
    assert.ok(Array.isArray(snapshots));
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.sourceProviderId, CODEX_PROVIDER);
  });
});

test("local-auth ignores malformed local files and skips undecryptable secrets", async () => {
  const desktop = await makeDesktopFixture();
  await writeFile(join(desktop.dataDir, "pi-usage-local.json"), "{ not json", "utf8");
  await writeFile(join(desktop.dataDir, "secrets", "deadbeef.bin"), Buffer.from("not-a-real-payload").toString("base64"), "utf8");
  await writeSecret(desktop, "secret:provider:deepseek:api_key", "sk-test-deepseek-key");

  await withIsolatedEnv(desktop, async () => {
    assert.deepEqual(await localProviderEntries(), []);

    const secrets = await readSecretStore();
    assert.equal(secrets.size, 1);
    assert.equal(secrets.get(secretFileName("secret:provider:deepseek:api_key")), "sk-test-deepseek-key");

    assert.equal(await resolveLocalAuth({ providerId: "unknown-provider", kind: "api_key" }), undefined);

    const resolved = await resolveLocalAuth({ providerId: "deepseek", kind: "api_key", baseUrl: "https://api.deepseek.com" });
    assert.equal(resolved?.auth.apiKey, "sk-test-deepseek-key");
    assert.equal(resolved?.auth.baseUrl, "https://api.deepseek.com");
  });
});

test("pillText summarises unhealthy, healthy and metric-only snapshots", () => {
  const healthy: UsageSnapshot = {
    adapterId: "openai-codex",
    sourceProviderId: CODEX_PROVIDER,
    displayName: "OpenAI Codex",
    state: "ok",
    fetchedAt: new Date().toISOString(),
    summary: "Codex · 5h 99% · 7d 78%",
    accounts: [],
  };
  assert.equal(pillText(healthy), "Codex · 5h 99% · 7d 78%");
  assert.equal(pillText({ ...healthy, displayName: "DeepSeek", summary: "Balance ¥42.76" }), "DeepSeek · Balance ¥42.76");

  const summaryAlreadyPrefixes = pillText({
    ...healthy,
    summary: "OpenAI Codex · Codex · 5h 99% · 7d 78%",
  });
  assert.equal(summaryAlreadyPrefixes, "OpenAI Codex · Codex · 5h 99% · 7d 78%");

  const long = pillText({ ...healthy, summary: `Codex · ${"9".repeat(300)}` });
  assert.equal(long.length, 140);
  assert.ok(long.endsWith("…"));

  const unauthorized: UsageSnapshot = {
    adapterId: "none",
    sourceProviderId: "deepseek",
    displayName: "DeepSeek",
    state: "unauthorized",
    fetchedAt: new Date().toISOString(),
    accounts: [],
  };
  assert.equal(pillText(unauthorized), "DeepSeek · Unauthorized");

  const metricsOnly: UsageSnapshot = {
    adapterId: "openai-codex",
    sourceProviderId: CODEX_PROVIDER,
    displayName: "OpenAI Codex",
    state: "ok",
    fetchedAt: new Date().toISOString(),
    accounts: [{
      id: "codex-account",
      provider: "openai-codex",
      label: "ChatGPT Plus",
      metrics: [{ kind: "quota-window", id: "primary-window", label: "Codex 5h", remainingFraction: 0.5 }],
    }],
  };
  assert.match(pillText(metricsOnly), /^OpenAI Codex · Codex 5h ━+─+ 50% left/);
});

test("a local provider entry can force an adapter for a UUID provider id", async () => {
  const desktop = await makeDesktopFixture();
  const providerId = "14aec6e3-a30a-4092-8856-5b819fe474dd";
  const secretRef = `secret:provider:${providerId}:api_key`;
  await writeSecret(desktop, secretRef, "sk-test-deepseek-key");
  await writeFile(join(desktop.dataDir, "pi-usage-local.json"), JSON.stringify({
    version: 1,
    providers: [{
      providerId,
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      kind: "api_key",
      adapter: "deepseek",
      secretRef,
    }],
  }), "utf8");

  // PI-Desktop provider ids are UUIDs, which the DeepSeek adapter's canHandle rejects.
  const model = { provider: providerId, id: "deepseek-flash", baseUrl: "https://api.deepseek.com" };
  const deepseekBody = await fixture("deepseek-balance.json");
  const calls: string[] = [];
  const controller = new ProviderUsageController(DEFAULT_CONFIG, async (input) => {
    calls.push(String(input));
    return new Response(deepseekBody, { status: 200, headers: { "content-type": "application/json" } });
  });

  await withIsolatedEnv(desktop, async () => {
    const host = desktopContext({ model, cwd: desktop.dataDir });
    const snapshots = await controller.refreshLocal(host.ctx, true);

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.adapterId, "deepseek");
    assert.equal(snapshots[0]?.state, "ok");
    assert.ok(calls.some((url) => url.includes("api.deepseek.com/user/balance")));
    assert.equal(pillText(snapshots[0]!), "DeepSeek · Balance ¥23.41");
  });
});

test("desktop shows only the active model's provider pill", async () => {
  const desktop = await makeDesktopFixture();
  const deepseekProvider = "14aec6e3-a30a-4092-8856-5b819fe474dd";
  await writeSecret(desktop, `secret:provider:${CODEX_PROVIDER}:oauth`, JSON.stringify({
    type: "oauth",
    access: "fake-access-token",
    accountId: "dddd6bf6-e6e5-4e5e-b2e1-61ded58c5710",
  }));
  await writeSecret(desktop, `secret:provider:${deepseekProvider}:api_key`, "sk-test-deepseek-key");
  await writeFile(join(desktop.dataDir, "pi-usage-local.json"), JSON.stringify({
    version: 1,
    providers: [
      { providerId: CODEX_PROVIDER, label: "Codex", baseUrl: "https://chatgpt.com/backend-api", kind: "oauth", adapter: "openai-codex" },
      {
        providerId: deepseekProvider,
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        kind: "api_key",
        adapter: "deepseek",
        secretRef: `secret:provider:${deepseekProvider}:api_key`,
      },
    ],
  }), "utf8");

  const codexBody = await fixture("openai-codex-usage.json");
  const deepseekBody = await fixture("deepseek-balance.json");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    const body = url.includes("chatgpt.com") ? codexBody : url.includes("api.deepseek.com") ? deepseekBody : undefined;
    if (!body) return new Response("Not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await withIsolatedEnv(desktop, async () => {
      const handlers = loadExtension();
      const host = desktopContext({ model: CODEX_MODEL, cwd: desktop.dataDir });

      // Replay the status log to see which pills are actually on screen.
      const livePills = (): Array<{ key: string; text: string }> => {
        const state = new Map<string, string>();
        for (const entry of host.statuses) {
          if (entry.text === undefined) state.delete(entry.key);
          else state.set(entry.key, entry.text);
        }
        return [...state.entries()].map(([key, text]) => ({ key, text }));
      };

      await handlers.get("session_start")!({ type: "session_start" }, host.ctx);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const codexOnly = livePills();
      assert.equal(codexOnly.length, 1, `expected exactly one pill, got ${JSON.stringify(codexOnly)}`);
      assert.equal(codexOnly[0]?.key, `pi-usage:${CODEX_PROVIDER}`);
      assert.match(codexOnly[0]!.text, /%/);

      // Switching to a DeepSeek model must replace the Codex pill, not add one.
      host.ctx.model = { provider: deepseekProvider, id: "deepseek-flash", baseUrl: "https://api.deepseek.com" };
      await handlers.get("model_select")!({ type: "model_select", model: host.ctx.model }, host.ctx);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const deepseekOnly = livePills();
      assert.equal(deepseekOnly.length, 1, `expected exactly one pill after switching, got ${JSON.stringify(deepseekOnly)}`);
      assert.equal(deepseekOnly[0]?.key, `pi-usage:${deepseekProvider}`);
      assert.equal(deepseekOnly[0]?.text, "DeepSeek · Balance ¥23.41");

      // Switching back restores the Codex pill.
      host.ctx.model = CODEX_MODEL;
      await handlers.get("model_select")!({ type: "model_select", model: CODEX_MODEL }, host.ctx);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const backToCodex = livePills();
      assert.equal(backToCodex.length, 1);
      assert.equal(backToCodex[0]?.key, `pi-usage:${CODEX_PROVIDER}`);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("desktop relay providers show Unknown when the host serves no usage JSON", async () => {
  const desktop = await makeDesktopFixture();
  const providerId = "94cea82e-6ec4-4291-bb30-ebe03520cf4f";
  const secretRef = `secret:provider:${providerId}:api_key`;
  await writeSecret(desktop, secretRef, "sk-test-relay-key");
  await writeFile(join(desktop.dataDir, "pi-usage-local.json"), JSON.stringify({
    version: 1,
    providers: [{ providerId, label: "AIR-OpenAI", baseUrl: "https://airopenai.cc", kind: "api_key", secretRef }],
  }), "utf8");

  // /v1/usage returns 200 + the relay's SPA HTML: no quota data is reachable.
  const model = { provider: providerId, id: "gpt-5.6-terra", baseUrl: "https://airopenai.cc" };
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    requested.push(String(input));
    return new Response("<!doctype html><html><body>relay SPA</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  try {
    await withIsolatedEnv(desktop, async () => {
      const handlers = loadExtension();
      const host = desktopContext({ model, cwd: desktop.dataDir });

      await handlers.get("session_start")!({ type: "session_start" }, host.ctx);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const live = new Map<string, string>();
      for (const entry of host.statuses) {
        if (entry.text === undefined) live.delete(entry.key);
        else live.set(entry.key, entry.text);
      }

      assert.ok(requested.some((url) => url.endsWith("/v1/usage")), `expected a relay /v1/usage request, got ${JSON.stringify(requested)}`);
      assert.equal(live.size, 1, `expected exactly one pill, got ${JSON.stringify([...live])}`);
      // index.ts renders pillText(snapshot) for the active provider.
      assert.equal(live.get(`pi-usage:${providerId}`), "Sub2API · Unknown");

      // Same provider fetched directly: the pill is `${displayName} · Unknown`.
      const controller = new ProviderUsageController(DEFAULT_CONFIG, globalThis.fetch);
      const snapshots = await controller.refreshLocal(host.ctx, true);
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]?.adapterId, "sub2api");
      assert.equal(snapshots[0]?.displayName, "Sub2API");
      assert.equal(pillText(snapshots[0]!), `${snapshots[0]!.displayName} · Unknown`);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("desktop plugin settings own the refresh interval and rebuild the timer", async () => {
  const desktop = await makeDesktopFixture();
  const settingsDir = join(desktop.dataDir, "plugins", "data", "imported.pi-usage");
  await mkdir(settingsDir, { recursive: true });
  const settingsFile = join(settingsDir, "settings.json");
  await writeFile(settingsFile, JSON.stringify({ intervalSeconds: 300 }), "utf8");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  const originalSetInterval = globalThis.setInterval;
  const delays: number[] = [];
  const ticks: Array<{ delay: number; fire: () => void }> = [];
  globalThis.setInterval = ((callback: () => void, delay?: number, ...args: unknown[]) => {
    delays.push(delay ?? 0);
    ticks.push({ delay: delay ?? 0, fire: callback });
    return originalSetInterval(callback as (...params: unknown[]) => void, delay, ...args);
  }) as typeof setInterval;

  try {
    await withIsolatedEnv(desktop, async () => {
      const handlers = loadExtension();
      const host = desktopContext({ model: CODEX_MODEL, cwd: desktop.dataDir });

      await handlers.get("session_start")!({ type: "session_start" }, host.ctx);
      await new Promise((resolve) => setTimeout(resolve, 25));

      // The desktop value (300s) outranks the plugin default (120s).
      assert.ok(delays.includes(300_000), `expected a 300s refresh timer, got ${JSON.stringify(delays)}`);
      const usageCommand = registeredCommands.get("usage");
      assert.ok(usageCommand, "the /usage command must be registered");
      await usageCommand("settings", host.ctx);
      const configLine = host.notifications.find((message) => message.startsWith("Config: ")) ?? "";
      assert.match(configLine, /interval=300s/, `expected the desktop interval in effect, got ${JSON.stringify(configLine)}`);

      // /usage settings cannot override a desktop-owned interval, and says so.
      host.notifications.length = 0;
      await usageCommand("settings interval 60", host.ctx);
      assert.match(
        host.notifications.join("\n"),
        /Desktop plugin settings override refresh\.intervalSeconds/,
        `expected an override notice, got ${JSON.stringify(host.notifications)}`,
      );

      // A value changed in the desktop UI is adopted by the next tick, which
      // rebuilds the timer with the new period (no session reload required).
      await new Promise((resolve) => setTimeout(resolve, 25));
      await writeFile(settingsFile, JSON.stringify({ intervalSeconds: 1200 }), "utf8");
      const refreshTick = ticks.find((entry) => entry.delay === 300_000);
      assert.ok(refreshTick, "expected the refresh timer callback");
      refreshTick.fire();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(delays.includes(1_200_000), `expected a rebuilt 1200s timer, got ${JSON.stringify(delays)}`);
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
  }
});
