import { createDecipheriv, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthResult } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * PI-Desktop stores provider credentials in its own encrypted secret store
 * instead of exposing `modelRegistry.getProviderAuth()`. These helpers read
 * that store so usage adapters keep working inside the desktop host.
 *
 * Format: `<dataDir>/secrets/.machine-key` holds the raw 32 byte AES key and
 * `<dataDir>/secrets/<sha256(secretRef)>.bin` holds base64 `iv(12) | ciphertext
 * | tag(16)` encrypted with aes-256-gcm.
 */

const SECRETS_DIR = "secrets";
const MACHINE_KEY_FILE = ".machine-key";
const LOCAL_PROVIDERS_FILE = "pi-usage-local.json";
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const AES_KEY_BYTES = 32;

export interface LocalProviderEntry {
  providerId: string;
  label?: string;
  baseUrl?: string;
  kind?: "api_key" | "oauth";
  /** Force a specific usage adapter, bypassing `canHandle` (e.g. a UUID provider id). */
  adapter?: string;
  secretRef?: string;
  configuredModelIds?: string[];
}

export function desktopDataDir(): string {
  const configured = process.env.PI_DESKTOP_DATA_DIR;
  return configured?.trim() ? configured : join(homedir(), ".pi-desktop");
}

/** Default secret reference used by PI-Desktop for a provider API key. */
export function defaultSecretRef(providerId: string): string {
  return `secret:provider:${providerId}:api_key`;
}

/** `secrets/<file>` base name (without the `.bin` suffix) for a secret ref. */
export function secretFileName(secretRef: string): string {
  return createHash("sha256").update(secretRef).digest("hex");
}

/**
 * Decrypt every `*.bin` entry in the desktop secret store.
 *
 * Returns a map of `sha256(secretRef)` -> plaintext. Unreadable, corrupt or
 * undecryptable entries are skipped silently: a single bad file must never
 * break usage reporting, and no plaintext may ever reach a log.
 */
export async function readSecretStore(): Promise<Map<string, string>> {
  const secrets = new Map<string, string>();
  const directory = join(desktopDataDir(), SECRETS_DIR);

  let key: Buffer;
  try {
    const raw = await readFile(join(directory, MACHINE_KEY_FILE));
    if (raw.length < AES_KEY_BYTES) return secrets;
    key = raw.subarray(0, AES_KEY_BYTES);
  } catch {
    return secrets;
  }

  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return secrets;
  }

  for (const file of files) {
    if (!file.endsWith(".bin")) continue;
    try {
      const encoded = (await readFile(join(directory, file), "utf8")).trim();
      const payload = Buffer.from(encoded, "base64");
      if (payload.length <= GCM_IV_BYTES + GCM_TAG_BYTES) continue;
      const iv = payload.subarray(0, GCM_IV_BYTES);
      const tag = payload.subarray(payload.length - GCM_TAG_BYTES);
      const ciphertext = payload.subarray(GCM_IV_BYTES, payload.length - GCM_TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      if (plaintext) secrets.set(file.slice(0, -".bin".length), plaintext);
    } catch {
      // Missing/misaligned entries are expected when the store changes shape.
    }
  }

  return secrets;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/**
 * Read `<dataDir>/pi-usage-local.json`. A missing or malformed file yields an
 * empty list rather than an error.
 */
export async function localProviderEntries(): Promise<LocalProviderEntry[]> {
  try {
    const raw = await readFile(join(desktopDataDir(), LOCAL_PROVIDERS_FILE), "utf8");
    const parsed = JSON.parse(raw) as { providers?: unknown };
    if (!Array.isArray(parsed.providers)) return [];
    const entries: LocalProviderEntry[] = [];
    for (const value of parsed.providers) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
      if (!providerId) continue;
      const configuredModelIds = stringList(record.configuredModelIds);
      entries.push({
        providerId,
        ...(typeof record.label === "string" && record.label ? { label: record.label } : {}),
        ...(typeof record.baseUrl === "string" && record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        ...(typeof record.adapter === "string" && record.adapter ? { adapter: record.adapter } : {}),
        ...(record.kind === "oauth" ? { kind: "oauth" as const } : record.kind === "api_key" ? { kind: "api_key" as const } : {}),
        ...(typeof record.secretRef === "string" && record.secretRef ? { secretRef: record.secretRef } : {}),
        ...(configuredModelIds.length ? { configuredModelIds } : {}),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

interface OAuthCredential {
  access: string;
  accountId?: string;
}

function jsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Strict shape for decrypted PI-Desktop OAuth blobs: `{ access, accountId }`. */
function oauthFromRecord(record: Record<string, unknown> | undefined): OAuthCredential | undefined {
  if (!record) return undefined;
  const access = record.access;
  const accountId = record.accountId;
  if (typeof access !== "string" || !access) return undefined;
  if (typeof accountId !== "string" || !accountId) return undefined;
  return { access, accountId };
}

/** Flexible shape for Pi credential files: `access|apiKey` + `accountId|chatgpt_account_id`. */
function credentialFromRecord(record: Record<string, unknown> | undefined): OAuthCredential | undefined {
  if (!record) return undefined;
  const access = record.access ?? record.apiKey ?? record.key;
  const accountId = record.accountId ?? record.chatgpt_account_id ?? record.account_id;
  if (typeof access !== "string" || !access) return undefined;
  return { access, ...(typeof accountId === "string" && accountId ? { accountId } : {}) };
}

async function readAgentCredential(providerId: string): Promise<OAuthCredential | undefined> {
  try {
    const raw = await readFile(join(getAgentDir(), "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const record = parsed[providerId];
    if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
    return credentialFromRecord(record as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

async function readCodexCredential(): Promise<OAuthCredential | undefined> {
  try {
    const raw = await readFile(join(homedir(), ".codex", "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as { tokens?: Record<string, unknown> };
    const tokens = parsed.tokens;
    if (!tokens || typeof tokens !== "object") return undefined;
    const access = tokens.access_token;
    const accountId = tokens.account_id;
    if (typeof access !== "string" || !access) return undefined;
    return { access, ...(typeof accountId === "string" && accountId ? { accountId } : {}) };
  } catch {
    return undefined;
  }
}

function apiKeyAuth(apiKey: string, baseUrl?: string): AuthResult {
  return { auth: { apiKey, ...(baseUrl ? { baseUrl } : {}) }, source: "PI-Desktop secret store" };
}

function oauthAuth(credential: OAuthCredential, baseUrl?: string): AuthResult {
  // `openai-codex` and `anthropic` both read `authRecord.apiKey ?? authRecord.access`,
  // so expose the token under both names. `accountId` is not part of `ModelAuth`
  // but is consumed by the Codex adapter via a record cast.
  const auth = {
    apiKey: credential.access,
    access: credential.access,
    ...(credential.accountId ? { accountId: credential.accountId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  } as unknown as AuthResult["auth"];
  return { auth, source: "PI-Desktop secret store" };
}

/**
 * Resolve provider auth for a local provider entry using PI-Desktop's secret
 * store, with Pi/Codex credential files as OAuth fallbacks. Returns `undefined`
 * when nothing usable is found so adapters report `unauthorized` instead of
 * throwing. Never logs or returns secret material in error paths.
 */
export async function resolveLocalAuth(entry: LocalProviderEntry): Promise<AuthResult | undefined> {
  if (entry.kind === "oauth") {
    const secrets = await readSecretStore();
    for (const value of secrets.values()) {
      const credential = oauthFromRecord(jsonObject(value));
      if (credential) return oauthAuth(credential, entry.baseUrl);
    }
    const fallback = (await readAgentCredential(entry.providerId)) ?? (await readCodexCredential());
    return fallback ? oauthAuth(fallback, entry.baseUrl) : undefined;
  }

  const secrets = await readSecretStore();
  const secretRef = entry.secretRef?.trim() || defaultSecretRef(entry.providerId);
  const apiKey = secrets.get(secretFileName(secretRef))?.trim();
  if (!apiKey) return undefined;
  return apiKeyAuth(apiKey, entry.baseUrl);
}
