import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ProviderUsageSnapshot } from "doppelclaude/account-usage";
import { configureDebug, debug, moduleInstanceId } from "doppelclaude/debug";
import { errorMessage } from "doppelclaude/errors";
import { REFUSAL_CUSTOM_TYPE, type RefusalEntryData } from "doppelclaude/refusal-data";
import { createDefaultAccountProbe } from "./account-probe.js";
import { loadActivationSettings } from "./activation-settings.js";
import { acquireBridgeOwner } from "./bridge-owner.js";
import { type CacheAwareCompactionFields, runCacheAwareCompaction } from "./cached-compaction.js";
import { createCompaction } from "./compaction.js";
import { createBridgeModelCatalog } from "./model-catalog.js";
import { PROVIDER_ID } from "./models.js";
import { resolveOauthToken, runShellCommand } from "./oauth-token.js";
import { createPiBridgeRuntime } from "./pi-runtime.js";
import { createAnthropicAgentSdkProvider } from "./provider.js";
import { renderRefusalEntry } from "./refusal.js";
import { loadBridgeSettings } from "./settings.js";

export default function activate(pi: ExtensionAPI): void {
  const activation = loadActivationSettings(process.cwd());
  if (activation.status === "inactive") {
    let notified = false;
    pi.on("session_start", (_event, ctx) => {
      if (notified) return;
      notified = true;
      ctx.ui.notify(activation.message, "info");
    });
    return;
  }
  const { settings } = activation;
  configureDebug({
    ...settings.debug,
    diagnosticLogPath: join(getAgentDir(), "doppelclaude-diag.log"),
  });
  debug("loadSettings:", JSON.stringify(settings));
  const { provider: providerSettings } = settings;
  resolveOauthToken({
    providerSettings,
    env: process.env,
    runCommand: runShellCommand,
    debug,
  });

  const compaction = createCompaction({
    queryFactory: query,
    loadProviderSettings: (cwd) => loadBridgeSettings(cwd).provider,
    loadRetryPolicy: (cwd, projectTrusted) =>
      SettingsManager.create(cwd, getAgentDir(), { projectTrusted }).getRetrySettings(),
  });

  const { owner, ownsLifecycle, release } = acquireBridgeOwner(() => {
    // The runtime teaches the catalog which models Claude actually serves and the provider
    // publishes them, so both sides of that exchange hold the same catalog.
    const modelCatalog = createBridgeModelCatalog();
    const runtime = createPiBridgeRuntime({
      providerSettings,
      modelCatalog,
    });
    const provider = createAnthropicAgentSdkProvider({
      stream: runtime.stream,
      streamSideQuestion: runtime.streamSideQuestion,
      accountProbe: createDefaultAccountProbe(providerSettings),
      modelCatalog,
    });
    return { runtime, provider };
  });
  const { runtime, provider } = owner;
  debug(
    `owner: ${ownsLifecycle ? "created" : "borrowing"} shared Provider/runtime (module=${moduleInstanceId})`,
  );

  pi.registerProvider(provider);
  // Pi hands outputPad to message and tool renderers but not entry renderers.
  pi.registerEntryRenderer<RefusalEntryData>(REFUSAL_CUSTOM_TYPE, (entry, options, theme) =>
    renderRefusalEntry(entry, { ...options, outputPad: pi.getSettings().outputPad ?? 1 }, theme),
  );

  // Structural registration also loads on older Pi releases, where this event is never emitted.
  (
    pi as ExtensionAPI & {
      on(
        event: "provider_usage",
        handler: (
          event: { provider: string; modelId: string; signal?: AbortSignal },
          ctx: ExtensionContext,
        ) => Promise<ProviderUsageSnapshot | undefined>,
      ): void;
    }
  ).on("provider_usage", async (event, ctx) => {
    if (event.provider !== PROVIDER_ID) return undefined;
    return runtime.getUsage({
      conversationKey: ctx.sessionManager.getSessionId(),
      signal: event.signal,
    });
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return undefined;
    const currentModel = ctx.model;
    const cacheEvent = event as typeof event & CacheAwareCompactionFields;
    if (cacheEvent.method === "extension") return undefined;
    if (cacheEvent.method === "cache-aware") {
      try {
        const result = await runCacheAwareCompaction({
          event: cacheEvent,
          model: ctx.model,
          prepare: (cached) =>
            runtime.prepareCompaction({
              sessionId: cached.sessionId,
              model: cached.model,
              context: cached.context,
              customInstructions: event.customInstructions,
              signal: event.signal,
            }),
          standalone: () =>
            compaction.run({
              preparation: event.preparation,
              model: currentModel,
              branchEntries: event.branchEntries,
              customInstructions: event.customInstructions,
              signal: event.signal,
              cwd: ctx.cwd,
              projectTrusted: ctx.isProjectTrusted(),
              requireComplete: true,
            }),
        });
        return result ? { compaction: result } : { cancel: true };
      } catch (error) {
        if (!event.signal?.aborted)
          ctx.ui.notify(`Cached compaction could not finish: ${errorMessage(error)}`, "warning");
        return { cancel: true };
      }
    }
    debug(
      `session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
        `isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
        `turnPrefix=${event.preparation.turnPrefixMessages.length}`,
    );
    try {
      const result = await compaction.run({
        preparation: event.preparation,
        model: ctx.model,
        branchEntries: event.branchEntries,
        customInstructions: event.customInstructions,
        signal: event.signal,
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      debug(`session_before_compact: takeover complete summaryLen=${result.summary.length}`);
      return { compaction: result };
    } catch (err) {
      const msg = errorMessage(err);
      debug(
        "session_before_compact: takeover failed; cancelling to avoid native compact fallback",
        err,
      );
      ctx.ui?.notify?.(
        `Claude bridge compact failed (${msg}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
        "error",
      );
      return { cancel: true };
    }
  });

  if (!ownsLifecycle) return;

  pi.on("session_start", async (event, ctx) => {
    runtime.setHost({
      ui: ctx.ui,
      sessionId: ctx.sessionManager.getSessionId(),
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
    });
    await runtime.designateHost(ctx.sessionManager.getSessionId());
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
      await runtime.clear(`session_start:${event.reason}`);
    }
  });
  pi.on("session_shutdown", async () => {
    await runtime.clear("session_shutdown");
    release();
  });
  pi.on("model_select", async (event) => {
    if (event.previousModel?.provider === PROVIDER_ID && event.model.provider !== PROVIDER_ID) {
      await runtime.closePersistent("provider switch");
    }
  });
  pi.on("session_compact", async (event) => {
    await runtime.markRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`);
  });
  pi.on("session_tree", async () => {
    await runtime.markRebuild("session_tree");
  });
}
