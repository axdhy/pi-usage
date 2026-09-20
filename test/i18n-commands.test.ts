import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, configPath } from "../src/core/config.ts";
import { setLocale } from "../src/core/i18n.ts";
import extension from "../src/index.ts";
import { handleSettings } from "../src/settings.ts";
import { showDetails } from "../src/ui/details.ts";
import { showSkillStats, skillStatsLines } from "../src/ui/skills.ts";

/**
 * Command-surface localisation: every string the user reads from `/usage`,
 * `/usage doctor`, `/usage skills` and `/usage settings` must have a Chinese
 * rendering while the English one stays byte-identical.
 */

const MODEL = { provider: "deepseek", id: "deepseek-chat", baseUrl: "https://api.deepseek.com" };

/** Fake `ctx.ui` that records `notify` calls and can render TUI panels headlessly. */
function fakeContext(mode = "desktop", cwd = process.cwd()) {
  const messages: string[] = [];
  const panels: string[] = [];
  const ctx = {
    mode,
    model: MODEL,
    cwd,
    ui: {
      notify: (message: string) => { messages.push(String(message)); },
      setStatus: () => undefined,
      setWidget: () => undefined,
      custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => unknown) => {
        // A theme that only strips colour, enough for Text/Container rendering.
        const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
        const widget = factory(undefined, theme, undefined, () => undefined) as { render(width: number): string[] };
        panels.push(widget.render(80).join("\n"));
      },
    },
  };
  return { ctx, messages, panels };
}

interface CapturedEnv {
  PI_DESKTOP_DATA_DIR: string | undefined;
  PI_CODING_AGENT_DIR: string | undefined;
  PI_USAGE_LOCALE: string | undefined;
}

function captureEnv(): CapturedEnv {
  return {
    PI_DESKTOP_DATA_DIR: process.env.PI_DESKTOP_DATA_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_USAGE_LOCALE: process.env.PI_USAGE_LOCALE,
  };
}

function restoreEnv(previous: CapturedEnv): void {
  for (const key of Object.keys(previous) as Array<keyof CapturedEnv>) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setLocale("en");
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

/**
 * Boots the extension inside a PI-Desktop-shaped host and runs the commands the
 * localisation tests care about. No network is reachable: the registry exposes
 * no credential resolver and the desktop secret store is empty, so the DeepSeek
 * adapter reports `unauthorized` without a request.
 */
async function runCommands(options: {
  locale: string;
  dataDir: string;
  agentDir: string;
  authStatus: { configured: boolean; source?: string };
}): Promise<{ doctor: string; unknownUsage: string; skills: string; skillsHint: string; settings: string }> {
  const previous = captureEnv();
  process.env.PI_DESKTOP_DATA_DIR = options.dataDir;
  process.env.PI_CODING_AGENT_DIR = options.agentDir;
  process.env.PI_USAGE_LOCALE = options.locale;
  try {
    const handlers = loadExtension();
    const { ctx, messages } = fakeContext("desktop", options.dataDir);
    // Deliberately missing: getProvider / getProviderAuth / getRegisteredProviderIds.
    (ctx as any).modelRegistry = {
      getAll: () => [],
      getAvailable: () => [],
      find: () => undefined,
      getProviderDisplayName: (id: string) => id,
      getProviderAuthStatus: () => options.authStatus,
    };

    await handlers.get("session_start")!({ type: "session_start" }, ctx);
    const command = registeredCommands.get("usage");
    assert.ok(command, "the /usage command must be registered");

    const last = (): string => messages.at(-1) ?? "";
    const run = async (args: string): Promise<string> => {
      messages.length = 0;
      await command(args, ctx);
      return last();
    };

    const result = {
      doctor: await run("doctor"),
      unknownUsage: await run("nonsense"),
      skills: await run("skills"),
      skillsHint: await run("skills extra"),
      settings: await run("settings"),
    };
    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
    return result;
  } finally {
    restoreEnv(previous);
  }
}

test("/usage doctor renders the same English lines and localised Chinese ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-usage-doctor-"));
  const dataDir = join(root, "desktop");
  const agentDir = join(root, "agent");
  await mkdir(dataDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  try {
    const english = await runCommands({ locale: "en", dataDir, agentDir, authStatus: { configured: false } });
    assert.equal(english.doctor, [
      "Model: deepseek/deepseek-chat",
      "Provider base URL: https://api.deepseek.com",
      "Current adapter: deepseek",
      "Current state: unauthorized",
      "Current auth: missing or rejected",
      "DeepSeek auth: not configured",
      "Hint: /usage current shows only deepseek; use /usage all for DeepSeek plus other configured providers.",
      "Problem: No API key resolved from Pi provider auth",
    ].join("\n"));
    assert.equal(english.unknownUsage, "Usage: /usage [all|current|refresh|doctor|skills|settings]");
    assert.equal(english.skillsHint, "Usage: /usage skills");
    assert.equal(english.skills, "Pi Usage · Installed Skill Usage\nNo installed skills found.");
    assert.equal(english.settings.startsWith("Config: "), true, english.settings);
    assert.match(english.settings, /interval=120s timeout=10s/);

    const chinese = await runCommands({ locale: "zh-CN", dataDir, agentDir, authStatus: { configured: true, source: "environment" } });
    assert.ok(chinese.doctor.includes("模型："), chinese.doctor);
    assert.ok(chinese.doctor.includes("当前适配器："), chinese.doctor);
    assert.ok(chinese.doctor.includes("服务商地址："), chinese.doctor);
    assert.equal(chinese.doctor, [
      "模型：deepseek/deepseek-chat",
      "服务商地址：https://api.deepseek.com",
      "当前适配器：deepseek",
      "当前状态：unauthorized",
      "当前认证：缺失或被拒绝",
      "DeepSeek 认证：已配置（environment）",
      "提示：/usage current 只显示 deepseek；用 /usage all 可以看到 DeepSeek 等其它已配置服务商。",
      "问题：No API key resolved from Pi provider auth",
    ].join("\n"));
    assert.equal(chinese.unknownUsage, "用法：/usage [all|current|refresh|doctor|skills|settings]");
    assert.equal(chinese.skillsHint, "用法：/usage skills");
    assert.equal(chinese.skills, "Pi Usage · 技能使用统计\n未发现已安装的 Skill。");
    assert.equal(chinese.settings.startsWith("配置："), true, chinese.settings);
    assert.match(chinese.settings, /interval=120s timeout=10s/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/usage skills localises the table headers and the installed count", async () => {
  setLocale("zh-CN");
  const chinese = skillStatsLines(["agent-reach", "pdf"], [{ skill: "pdf", uses: 3 }]);
  assert.equal(chinese[0], `${"技能".padEnd(11)}  ${"次数"}`);
  assert.equal(chinese[1], `${"-".repeat(11)}  ${"-".repeat(2)}`);
  assert.ok(chinese.some((line) => /^agent-reach\s+0$/.test(line)), chinese.join("\n"));
  assert.ok(chinese.some((line) => /^pdf\s+3$/.test(line)), chinese.join("\n"));
  assert.equal(chinese.at(-1), "已安装 2 个技能。");
  assert.deepEqual(skillStatsLines([], []), ["未发现已安装的 Skill。"]);
  assert.equal(skillStatsLines(["pdf"], [{ skill: "pdf", uses: 1 }]).at(-1), "已安装 1 个技能。");

  const chineseNotify = fakeContext("desktop");
  await showSkillStats(chineseNotify.ctx as any, ["agent-reach", "pdf"], [{ skill: "pdf", uses: 3 }]);
  assert.ok(chineseNotify.messages[0]?.startsWith("Pi Usage · 技能使用统计\n"), chineseNotify.messages[0]);
  assert.ok(chineseNotify.messages[0]?.includes("已安装 2 个技能。"), chineseNotify.messages[0]);

  const chineseTui = fakeContext("tui");
  await showSkillStats(chineseTui.ctx as any, [], []);
  assert.ok(chineseTui.panels[0]?.includes("Pi Usage · 技能使用统计"), chineseTui.panels[0]);
  assert.ok(chineseTui.panels[0]?.includes("未发现已安装的 Skill。"), chineseTui.panels[0]);
  assert.ok(chineseTui.panels[0]?.includes("回车/Esc 关闭"), chineseTui.panels[0]);

  setLocale("en");
  const english = skillStatsLines(["agent-reach", "pdf"], [{ skill: "pdf", uses: 3 }]);
  assert.equal(english[0], `${"Skill".padEnd(11)}  ${"Uses"}`);
  assert.equal(english[1], `${"-".repeat(11)}  ${"-".repeat(4)}`);
  assert.equal(english.at(-1), "2 installed skills.");
  assert.equal(skillStatsLines(["pdf"], []).at(-1), "1 installed skill.");
  assert.deepEqual(skillStatsLines([], []), ["No installed skills found."]);

  const englishUi = fakeContext("desktop");
  await showSkillStats(englishUi.ctx as any, [], []);
  assert.equal(englishUi.messages[0], "Pi Usage · Installed Skill Usage\nNo installed skills found.");
});

test("the details view localises the empty result, its title and the close hint", async () => {
  setLocale("zh-CN");
  const chinese = fakeContext("desktop");
  await showDetails(chinese.ctx as any, []);
  assert.deepEqual(chinese.messages, ["暂无用量数据。"]);

  const chineseTui = fakeContext("tui");
  await showDetails(chineseTui.ctx as any, []);
  assert.ok(chineseTui.panels[0]?.includes("Pi Usage · 服务商用量"), chineseTui.panels[0]);
  assert.ok(chineseTui.panels[0]?.includes("暂无用量数据。"), chineseTui.panels[0]);
  assert.ok(chineseTui.panels[0]?.includes("回车/Esc 关闭"), chineseTui.panels[0]);

  setLocale("en");
  const english = fakeContext("desktop");
  await showDetails(english.ctx as any, []);
  assert.deepEqual(english.messages, ["No usage data available."]);

  const englishTui = fakeContext("tui");
  await showDetails(englishTui.ctx as any, []);
  assert.ok(englishTui.panels[0]?.includes("Pi Usage · Provider Usage"), englishTui.panels[0]);
  assert.ok(englishTui.panels[0]?.includes("Enter/Esc close"), englishTui.panels[0]);
});

test("/usage settings localises the usage hint, the config echo and the save notice", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-usage-settings-i18n-"));
  const previous = captureEnv();
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const path = configPath();

    setLocale("zh-CN");
    const chinese = fakeContext("desktop");
    await handleSettings("widget maybe", chinese.ctx as any, DEFAULT_CONFIG);
    assert.deepEqual(chinese.messages, ["用法：/usage settings [widget|status|skills] [on|off]，或 interval/timeout <秒数>"]);
    assert.equal((await handleSettings("", chinese.ctx as any, DEFAULT_CONFIG)).display.widget, false);
    assert.equal(chinese.messages.at(-1), `配置：${path}\nstatus=true widget=false skills=true interval=120s timeout=10s`);
    assert.equal((await handleSettings("widget on", chinese.ctx as any, DEFAULT_CONFIG)).display.widget, true);
    assert.equal(chinese.messages.at(-1), `Pi Usage 设置已保存到 ${path}`);

    setLocale("en");
    const english = fakeContext("desktop");
    await handleSettings("widget maybe", english.ctx as any, DEFAULT_CONFIG);
    assert.deepEqual(english.messages, ["Usage: /usage settings [widget|status|skills] [on|off], or interval/timeout <seconds>"]);
    await handleSettings("", english.ctx as any, DEFAULT_CONFIG);
    assert.equal(english.messages.at(-1), `Config: ${path}\nstatus=true widget=false skills=true interval=120s timeout=10s`);
    await handleSettings("interval 60", english.ctx as any, DEFAULT_CONFIG);
    assert.equal(english.messages.at(-1), `Pi Usage settings saved to ${path}`);
  } finally {
    restoreEnv(previous);
  }
});
