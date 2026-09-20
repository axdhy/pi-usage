import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UsageConfig } from "./config.ts";
import { desktopDataDir } from "./local-auth.ts";

/**
 * PI-Desktop writes plugin settings to a flat `<dataDir>/plugins/data/<plugin
 * id>/settings.json`. This extension's desktop plugin id is `imported.pi-usage`,
 * so the host-owned refresh interval shows up as `{"intervalSeconds": 300}`.
 *
 * The file belongs to the desktop app: everything here is read-only, cached by
 * `mtimeMs`+size (the timer re-reads it on every tick), and silent on failure.
 */

export const DESKTOP_PLUGIN_ID = "imported.pi-usage";
export const INTERVAL_MIN_SECONDS = 30;
export const INTERVAL_MAX_SECONDS = 3600;
const SETTINGS_FILE = "settings.json";

export function clampIntervalSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(INTERVAL_MAX_SECONDS, Math.max(INTERVAL_MIN_SECONDS, value));
}

/** `<dataDir>/plugins/data/<pluginId>/settings.json` for this extension. */
export function desktopSettingsPath(): string {
  return join(desktopDataDir(), "plugins", "data", DESKTOP_PLUGIN_ID, SETTINGS_FILE);
}

interface CachedInterval {
  mtimeMs: number;
  size: number;
  value: number | undefined;
}

const cache = new Map<string, CachedInterval>();

interface FileInterval {
  exists: boolean;
  value: number | undefined;
}

async function intervalFromFile(file: string): Promise<FileInterval> {
  let mtimeMs: number;
  let size: number;
  try {
    const stats = await stat(file);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    cache.delete(file);
    return { exists: false, value: undefined };
  }

  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return { exists: true, value: cached.value };
  }

  let value: number | undefined;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { intervalSeconds?: unknown };
    value = clampIntervalSeconds(parsed?.intervalSeconds);
  } catch {
    value = undefined;
  }
  cache.set(file, { mtimeMs, size, value });
  return { exists: true, value };
}

/** Every other plugin's settings file, used only when ours does not exist. */
async function siblingSettingsFiles(): Promise<string[]> {
  const dataDir = join(desktopDataDir(), "plugins", "data");
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry !== DESKTOP_PLUGIN_ID)
    .map((entry) => join(dataDir, entry, SETTINGS_FILE));
}

/**
 * `<dataDir>/plugins/data/imported.pi-usage/settings.json` -> `intervalSeconds`,
 * clamped to `[30, 3600]`. Falls back to scanning sibling plugin settings when
 * our own file is missing. Returns `undefined` for anything unreadable.
 */
export async function readDesktopIntervalSeconds(): Promise<number | undefined> {
  try {
    const primary = await intervalFromFile(desktopSettingsPath());
    if (primary.exists) return primary.value;
    for (const file of await siblingSettingsFiles()) {
      const found = await intervalFromFile(file);
      if (found.value !== undefined) return found.value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adopt the desktop-configured interval into `config` when it differs from the
 * value currently in effect. Returns `true` when the caller must rebuild its
 * timer. The desktop value always wins over the plugin's own `config.json`.
 */
export async function syncDesktopInterval(config: UsageConfig): Promise<boolean> {
  const intervalSeconds = await readDesktopIntervalSeconds();
  if (intervalSeconds === undefined || intervalSeconds === config.refresh.intervalSeconds) return false;
  config.refresh.intervalSeconds = intervalSeconds;
  return true;
}
