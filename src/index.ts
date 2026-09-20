import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadConfig, type UsageConfig } from "./core/config.ts";
import type { UsageSnapshot } from "./core/types.ts";
import { ProviderUsageController } from "./modules/provider/controller.ts";
import { SkillUsageController } from "./modules/skills/controller.ts";
import { showDetails } from "./ui/details.ts";
import { showSkillStats } from "./ui/skills.ts";
import { compactSnapshot, pillText, snapshotLines } from "./ui/format.ts";
import { handleSettings } from "./settings.ts";
import { safeError } from "./core/security.ts";
import { initLocale, t } from "./core/i18n.ts";
import { readDesktopIntervalSeconds, syncDesktopInterval } from "./core/desktop-settings.ts";

const STATUS_ID = "pi-usage";
const WIDGET_ID = "pi-usage-provider";
const DESKTOP_STATUS_PREFIX = `${STATUS_ID}:`;

export default function (pi: ExtensionAPI) {
  let config: UsageConfig;
  let controller: ProviderUsageController;
  let timer: ReturnType<typeof setInterval> | undefined;
  let modelWatchTimer: ReturnType<typeof setInterval> | undefined;
  let lastContext: ExtensionContext | undefined;
  let observedModelKey: string | undefined;
  let renderGeneration = 0;
  const skillController = new SkillUsageController(pi);
  let desktopStatusKeys = new Set<string>();

  function modelKey(model: Model<Api> | undefined): string | undefined {
    return model ? `${model.provider}/${model.id}/${model.baseUrl}` : undefined;
  }

  function liveModel(ctx: ExtensionContext): Model<Api> | undefined {
    return ctx.model;
  }

  function displayOrigin(baseUrl: string | undefined): string {
    if (!baseUrl) return t("doctor.originMissing");
    try {
      return new URL(baseUrl).origin;
    } catch {
      return t("doctor.originInvalid");
    }
  }

  /**
   * PI-Desktop's sidecar exposes no credential resolver on the registry. That
   * is the signal we use to switch to per-provider status pills.
   */
  function desktopHost(ctx: ExtensionContext): boolean {
    return typeof (ctx.modelRegistry as unknown as { getProviderAuth?: unknown } | undefined)?.getProviderAuth !== "function";
  }

  function toneFor(state: UsageSnapshot["state"] | undefined): "success" | "warning" | "dim" {
    return state === "ok" ? "success" : state === "stale" ? "warning" : "dim";
  }

  /** Colour helper that tolerates hosts without a theme (PI-Desktop). */
  function paint(ctx: ExtensionContext, tone: "success" | "warning" | "dim", text: string): string {
    try {
      const theme = (ctx.ui as unknown as { theme?: { fg?: (tone: string, text: string) => string } }).theme;
      return typeof theme?.fg === "function" ? theme.fg(tone, text) : text;
    } catch {
      return text;
    }
  }

  function setStatusSafe(ctx: ExtensionContext, key: string, text: string | undefined): void {
    const ui = ctx.ui as unknown as { setStatus?: (key: string, text: string | undefined) => void };
    if (typeof ui.setStatus !== "function") return;
    try {
      ui.setStatus(key, text);
    } catch {
      // A host without a status area simply drops the update.
    }
  }

  function setWidgetSafe(ctx: ExtensionContext, content: string[] | undefined): void {
    const ui = ctx.ui as unknown as { setWidget?: (id: string, content: string[] | undefined, options?: { placement?: string }) => void };
    if (typeof ui.setWidget !== "function") return;
    try {
      ui.setWidget(WIDGET_ID, content, { placement: "belowEditor" });
    } catch {
      // The widget is decorative and must never break a refresh.
    }
  }

  function providerDisplayName(ctx: ExtensionContext, providerId: string): string {
    const registry = ctx.modelRegistry as unknown as { getProviderDisplayName?: (id: string) => string | undefined };
    if (typeof registry.getProviderDisplayName !== "function") return providerId;
    try {
      return registry.getProviderDisplayName(providerId) || providerId;
    } catch {
      return providerId;
    }
  }

  function providerAuthStatus(ctx: ExtensionContext, providerId: string): { configured: boolean; source?: string } | undefined {
    const registry = ctx.modelRegistry as unknown as { getProviderAuthStatus?: (id: string) => { configured?: boolean; source?: string } | null | undefined };
    if (typeof registry.getProviderAuthStatus !== "function") return undefined;
    try {
      const status = registry.getProviderAuthStatus(providerId);
      if (!status) return undefined;
      return { configured: Boolean(status.configured), ...(status.source ? { source: status.source } : {}) };
    } catch {
      return undefined;
    }
  }

  function clearDesktopPills(ctx: ExtensionContext): void {
    for (const key of desktopStatusKeys) setStatusSafe(ctx, key, undefined);
    desktopStatusKeys = new Set();
  }

  /**
   * Desktop shows a single pill for the provider behind the active model, keyed
   * by `pi-usage:<providerId>`: switching to a DeepSeek model replaces the Codex
   * pill instead of stacking one pill per configured provider.
   */
  function renderDesktopPills(ctx: ExtensionContext, snapshots: UsageSnapshot[], model: Model<Api> | undefined = ctx.model): void {
    if (!config.display.status) {
      clearDesktopPills(ctx);
      return;
    }
    const active = model?.provider
      ? snapshots.find((snapshot) => snapshot.sourceProviderId === model.provider)
      : snapshots.length === 1
        ? snapshots[0]
        : undefined;
    const next = new Set<string>();
    if (active) {
      const key = `${DESKTOP_STATUS_PREFIX}${active.sourceProviderId}`;
      next.add(key);
      setStatusSafe(ctx, key, paint(ctx, toneFor(active.state), pillText(active)));
    }
    for (const key of desktopStatusKeys) {
      if (!next.has(key)) setStatusSafe(ctx, key, undefined);
    }
    desktopStatusKeys = next;
  }

  function render(ctx: ExtensionContext, snapshot?: UsageSnapshot, model: Model<Api> | undefined = ctx.model): void {
    const current = controller.currentView(ctx, snapshot, model);
    if (desktopHost(ctx)) {
      renderDesktopPills(ctx, current ? [current] : [], model);
      return;
    }
    setStatusSafe(ctx, STATUS_ID, config.display.status ? paint(ctx, toneFor(current?.state), compactSnapshot(current)) : undefined);
    if (config.display.widget) setWidgetSafe(ctx, current ? snapshotLines(current) : undefined);
  }

  async function refreshCurrent(ctx: ExtensionContext, force = false, model: Model<Api> | undefined = liveModel(ctx)): Promise<UsageSnapshot | undefined> {
    lastContext = ctx;
    const generation = ++renderGeneration;
    try {
      // If we already have a cached snapshot for this provider, render it immediately
      // with group recalculation so model switches are instant without flicker.
      const cached = model ? controller.cache.values().find((item) => item.sourceProviderId === model.provider) : undefined;
      render(ctx, cached, model);
      const snapshot = await controller.refreshCurrent(ctx, force, model);
      if (generation === renderGeneration) render(ctx, snapshot, model);
      return snapshot;
    } catch (error) {
      const fallback = model ? controller.cache.values().find((item) => item.sourceProviderId === model.provider) : undefined;
      const failure: UsageSnapshot | undefined = fallback ?? (model ? {
        adapterId: "none",
        sourceProviderId: model.provider,
        displayName: providerDisplayName(ctx, model.provider),
        state: "unavailable",
        fetchedAt: new Date().toISOString(),
        accounts: [],
        error: safeError(error),
      } : undefined);
      if (generation === renderGeneration) render(ctx, failure, model);
      return failure;
    }
  }

  /**
   * Desktop refresh: PI-Desktop exposes credentials through its own secret
   * store, so refresh only providers we can authenticate locally and render one
   * pill per provider.
   */
  /**
   * Desktop refresh: query only the active model's provider, using
   * PI-Desktop's own secret store for credentials.
   */
  async function refreshDesktop(ctx: ExtensionContext, force = false, model: Model<Api> | undefined = ctx.model): Promise<UsageSnapshot[]> {
    lastContext = ctx;
    const generation = ++renderGeneration;
    const activeProviderId = model?.provider;
    const activeCached = (): UsageSnapshot[] =>
      activeProviderId ? controller.cache.values().filter((item) => item.sourceProviderId === activeProviderId) : [];
    try {
      const cached = activeCached();
      if (cached.length) renderDesktopPills(ctx, cached, model);
      const snapshot = await controller.refreshCurrent(ctx, force, model);
      const snapshots = snapshot ? [snapshot] : [];
      if (generation === renderGeneration) renderDesktopPills(ctx, snapshots, model);
      return snapshots;
    } catch {
      const fallback = activeCached();
      if (generation === renderGeneration) renderDesktopPills(ctx, fallback, model);
      return fallback;
    }
  }

  function refreshActive(ctx: ExtensionContext, force = false): Promise<unknown> {
    return desktopHost(ctx) ? refreshDesktop(ctx, force) : refreshCurrent(ctx, force);
  }

  /**
   * Re-reads the desktop-owned interval before every refresh so a value changed
   * in PI-Desktop's plugin settings takes effect within one old cycle, then
   * rebuilds the timer with the new period.
   */
  async function tick(ctx: ExtensionContext): Promise<void> {
    if (await syncDesktopInterval(config)) startTimer(lastContext ?? ctx);
    if (lastContext) await refreshActive(lastContext);
  }

  function startTimer(ctx: ExtensionContext): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { void tick(ctx); }, config.refresh.intervalSeconds * 1000);
    timer.unref?.();
    lastContext = ctx;
    observedModelKey = modelKey(liveModel(ctx));

    // pi-web versions can update ctx.model without reliably delivering model_select
    // to package extensions. This watcher performs no network I/O unless the model
    // identity actually changes, and keeps the footer honest during that gap.
    if (modelWatchTimer) clearInterval(modelWatchTimer);
    modelWatchTimer = setInterval(() => {
      if (!lastContext) return;
      const nextModel = liveModel(lastContext);
      const nextKey = modelKey(nextModel);
      if (nextKey === observedModelKey) return;
      observedModelKey = nextKey;
      if (desktopHost(lastContext)) void refreshDesktop(lastContext, false, nextModel);
      else void refreshCurrent(lastContext, false, nextModel);
    }, 750);
    modelWatchTimer.unref?.();
  }

  async function command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const [action = config.display.detailsDefault, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (action === "settings") {
      const previous = JSON.stringify(config);
      let next = await handleSettings(rest.join(" "), ctx, config);
      if (next.refresh.intervalSeconds !== config.refresh.intervalSeconds) {
        // The desktop plugin settings own this value: report the override and
        // keep the effective interval instead of the plugin's config.json one.
        const desktopInterval = await readDesktopIntervalSeconds();
        if (desktopInterval !== undefined) {
          ctx.ui.notify(t("settings.desktopOverride"), "warning");
          next = { ...next, refresh: { ...next.refresh, intervalSeconds: desktopInterval } };
        }
      }
      if (JSON.stringify(next) === previous) return;
      config = next;
      controller.setConfig(config);
      if (!config.skills.enabled) skillController.finishRun();
      startTimer(ctx);
      const cached = ctx.model ? controller.cache.values().find((item) => item.sourceProviderId === ctx.model?.provider) : undefined;
      render(ctx, cached);
      return;
    }
    if (action === "skills") {
      if (rest.length > 0) {
        ctx.ui.notify(t("usage.skillsHint"), "warning");
        return;
      }
      const installedSkills = skillController.installedSkills(ctx.cwd);
      const stats = await skillController.globalStats();
      await showSkillStats(ctx, installedSkills, stats);
      return;
    }
    if (action === "doctor") {
      const current = await controller.refreshCurrent(ctx, false);
      const deepSeekAuth = providerAuthStatus(ctx, "deepseek");
      const lines = [
        t("doctor.model", { value: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none" }),
        t("doctor.baseUrl", { value: displayOrigin(ctx.model?.baseUrl) }),
        t("doctor.adapter", { value: current?.adapterId ?? "none" }),
        t("doctor.state", { value: current?.state ?? "unavailable" }),
        t("doctor.auth", { value: t(current?.state === "unauthorized" ? "doctor.authMissing" : "doctor.authResolved") }),
        t("doctor.deepSeekAuth", {
          value: deepSeekAuth?.configured
            ? (deepSeekAuth.source ? t("doctor.configuredWithSource", { source: deepSeekAuth.source }) : t("doctor.configured"))
            : t("doctor.notConfigured"),
        }),
        t("doctor.hint", { provider: ctx.model?.provider ?? t("doctor.activeProvider") }),
        ...(current?.error ? [t("doctor.problem", { error: current.error })] : []),
        ...(current?.state === "not-installed" ? [t("doctor.fix")] : []),
      ];
      ctx.ui.notify(lines.join("\n"), current?.state === "ok" || current?.state === "stale" ? "info" : "warning");
      return;
    }
    if (action === "refresh") {
      const snapshot = await refreshCurrent(ctx, true);
      await showDetails(ctx, snapshot ? [controller.currentView(ctx, snapshot) ?? snapshot] : []);
      return;
    }
    if (action === "current") {
      const snapshot = await refreshCurrent(ctx);
      await showDetails(ctx, snapshot ? [controller.currentView(ctx, snapshot) ?? snapshot] : []);
      return;
    }
    if (action !== "all") {
      ctx.ui.notify(t("usage.hint"), "warning");
      return;
    }
    const snapshots = await controller.refreshAll(ctx, false);
    await showDetails(ctx, snapshots);
  }

  pi.registerCommand("usage", { description: "Show provider quotas, balances, and skill activations", handler: command });

  pi.on("session_start", async (_event, ctx) => {
    // Language first: every render below must use the client's language.
    await initLocale();
    config = await loadConfig();
    // A PI-Desktop plugin setting outranks the plugin's own config.json.
    await syncDesktopInterval(config);
    controller = new ProviderUsageController(config);
    skillController.refreshCatalog(ctx.cwd);
    startTimer(ctx);
    await refreshActive(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (config.skills.enabled) await skillController.captureInput(event.text, ctx);
  });
  pi.on("agent_start", async (_event, _ctx) => {
    if (config.skills.enabled) await skillController.beginRun();
  });
  pi.on("agent_end", async () => {
    skillController.finishRun();
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!config.skills.enabled || event.toolName !== "read") return;
    const path = (event.input as { path?: unknown }).path;
    if (typeof path === "string") skillController.captureReadCall(event.toolCallId, path, ctx);
  });
  pi.on("tool_result", async (event) => {
    if (config.skills.enabled && event.toolName === "read") {
      await skillController.captureReadResult(event.toolCallId, event.isError);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    observedModelKey = modelKey(event.model);
    if (desktopHost(ctx)) {
      await refreshDesktop(ctx, false, event.model);
      return;
    }
    const cached = event.model ? controller.cache.values().find((item) => item.sourceProviderId === event.model.provider) : undefined;
    render(ctx, cached, event.model);
    await refreshCurrent(ctx, false, event.model);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    if (modelWatchTimer) clearInterval(modelWatchTimer);
    timer = undefined;
    modelWatchTimer = undefined;
    observedModelKey = undefined;
    skillController.finishRun();
    renderGeneration++;
    clearDesktopPills(ctx);
    lastContext = undefined;
    controller?.cache.clear();
  });
}
