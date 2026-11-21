import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface UsageLimit {
  kind: string;
  label: string;
  percent: number | null;
  resetAt: number | null;
  scope?: string;
  active?: boolean;
  severity?: "normal" | "warning" | "critical";
}

export interface ProviderUsageSnapshot {
  provider: string;
  status: "ok" | "stale" | "unavailable" | "error";
  accountId?: string;
  accountLabel?: string;
  profileSource?: string;
  configDir?: string;
  observedAt: number | null;
  limits: UsageLimit[];
  source: string;
  error?: string;
}

export interface UsageProfile {
  profileSource: string;
  configDir: string;
}

/** Capture the child environment once. A later UI selection cannot relabel a live query. */
export function usageProfile(env: NodeJS.ProcessEnv): UsageProfile {
  return {
    profileSource: env.CLAUDE_CODE_OAUTH_TOKEN
      ? "environment-token"
      : env.CLAUDE_CONFIG_DIR
        ? "config-directory"
        : "default",
    configDir: env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"),
  };
}

const ACCOUNT = Type.Object({
  email: Type.Optional(Type.String()),
  organization: Type.Optional(Type.String()),
  subscriptionType: Type.Optional(Type.String()),
  tokenSource: Type.Optional(Type.String()),
  apiProvider: Type.Optional(Type.String()),
});
const NULLABLE_NUMBER = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const CONTROL_WINDOW = Type.Object({
  utilization: NULLABLE_NUMBER,
  resets_at: Type.Union([Type.String(), Type.Null()]),
});
const CONTROL = Type.Object({
  rate_limits_available: Type.Boolean(),
  rate_limits: Type.Union([
    Type.Object({
      five_hour: Type.Optional(Type.Union([CONTROL_WINDOW, Type.Null()])),
      seven_day: Type.Optional(Type.Union([CONTROL_WINDOW, Type.Null()])),
      seven_day_oauth_apps: Type.Optional(Type.Union([CONTROL_WINDOW, Type.Null()])),
      seven_day_opus: Type.Optional(Type.Union([CONTROL_WINDOW, Type.Null()])),
      seven_day_sonnet: Type.Optional(Type.Union([CONTROL_WINDOW, Type.Null()])),
      model_scoped: Type.Optional(
        Type.Array(
          Type.Object({
            display_name: Type.String(),
            utilization: NULLABLE_NUMBER,
            resets_at: Type.Union([Type.String(), Type.Null()]),
          }),
        ),
      ),
    }),
    Type.Null(),
  ]),
});
const RATE_WINDOW = Type.Object({
  utilization: Type.Optional(Type.Number({ minimum: 0 })),
  resetsAt: Type.Optional(Type.Number({ minimum: 0 })),
  status: Type.Optional(
    Type.Union([
      Type.Literal("allowed"),
      Type.Literal("allowed_warning"),
      Type.Literal("rejected"),
    ]),
  ),
});
const RATE_EVENT = Type.Object({
  status: Type.Union([
    Type.Literal("allowed"),
    Type.Literal("allowed_warning"),
    Type.Literal("rejected"),
  ]),
  rateLimitType: Type.Optional(Type.String()),
  utilization: Type.Optional(Type.Number({ minimum: 0 })),
  resetsAt: Type.Optional(Type.Number({ minimum: 0 })),
  unifiedWindows: Type.Optional(Type.Record(Type.String(), RATE_WINDOW)),
});

const WINDOWS: Record<string, { kind: string; label: string }> = {
  five_hour: { kind: "session", label: "5 hours" },
  seven_day: { kind: "weekly_all", label: "7 days" },
  seven_day_oauth_apps: { kind: "weekly_oauth_apps", label: "7 days · OAuth apps" },
  seven_day_opus: { kind: "weekly_opus", label: "7 days · Opus" },
  seven_day_sonnet: { kind: "weekly_sonnet", label: "7 days · Sonnet" },
  seven_day_overage_included: {
    kind: "weekly_overage_included",
    label: "7 days · included models",
  },
};

function limit(
  key: string,
  percent: number | null,
  resetAt: number | null,
  status?: string,
): UsageLimit {
  const meta = WINDOWS[key] ?? { kind: key, label: key.replaceAll("_", " ") };
  return {
    ...meta,
    percent,
    resetAt,
    scope: key,
    active: true,
    severity:
      status === "rejected" || (percent !== null && percent >= 100)
        ? "critical"
        : status === "allowed_warning" || (percent !== null && percent >= 80)
          ? "warning"
          : "normal",
  };
}

function isoTime(value: string | null): number | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function eventTime(value: number | undefined): number | null {
  if (value === undefined) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function copy(snapshot: ProviderUsageSnapshot): ProviderUsageSnapshot {
  return structuredClone(snapshot);
}

export function unavailableUsage(
  error = "No live Claude query is available.",
): ProviderUsageSnapshot {
  return {
    provider: "doppelclaude",
    status: "unavailable",
    observedAt: null,
    limits: [],
    source: "claude-sdk",
    error,
  };
}

/** Cancellation abandons only this caller's wait, never the main query or shared control read. */
export async function independentWait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** One reporter belongs to exactly one SDK subprocess, never to a selected model/profile label. */
export function createAccountUsage(
  query: Pick<Query, "accountInfo" | "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET">,
  profile: UsageProfile,
  options: {
    now?: () => number;
    isCurrent?: () => boolean;
    observe?: (snapshot: ProviderUsageSnapshot) => void;
  } = {},
) {
  const now = options.now ?? Date.now;
  const isCurrent = options.isCurrent ?? (() => true);
  let identity: Promise<Partial<ProviderUsageSnapshot>> | undefined;
  let latest: ProviderUsageSnapshot | undefined;
  let inFlight: Promise<ProviderUsageSnapshot> | undefined;
  let revision = 0;

  const account = () => {
    identity ??= Promise.resolve().then(async () => {
      const info: unknown = await query.accountInfo();
      if (!Value.Check(ACCOUNT, info)) throw new Error("Invalid Claude account information");
      const email = info.email?.trim();
      const organization = info.organization?.trim();
      return {
        ...profile,
        ...(email
          ? {
              accountId: createHash("sha256")
                .update(
                  JSON.stringify([
                    info.apiProvider ?? "firstParty",
                    email.toLowerCase(),
                    organization ?? "",
                  ]),
                )
                .digest("hex")
                .slice(0, 24),
              accountLabel: email,
            }
          : {}),
      };
    });
    return identity;
  };

  const publish = (snapshot: ProviderUsageSnapshot): ProviderUsageSnapshot => {
    if (!isCurrent()) return unavailableUsage("The Claude query changed before usage was read.");
    latest = copy(snapshot);
    try {
      options.observe?.(copy(snapshot));
    } catch {}
    return copy(snapshot);
  };

  const failed = (
    binding: Partial<ProviderUsageSnapshot>,
    status: "unavailable" | "error",
    error: string,
  ) =>
    publish(
      latest
        ? { ...latest, status: "stale", error }
        : { ...unavailableUsage(error), ...binding, status },
    );

  async function read(): Promise<ProviderUsageSnapshot> {
    const startedRevision = revision;
    let binding: Partial<ProviderUsageSnapshot> = profile;
    try {
      binding = await account();
      const method = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof method !== "function") {
        return failed(binding, "unavailable", "This Claude SDK does not expose usage control.");
      }
      const raw: unknown = await method.call(query, { skipBehaviors: true });
      if (!Value.Check(CONTROL, raw)) {
        return failed(binding, "error", "Claude returned an unsupported usage response.");
      }
      if (!isCurrent()) return unavailableUsage("The Claude query changed before usage was read.");
      // A late control response must not overwrite a newer rate-limit event.
      if (revision !== startedRevision && latest) return copy(latest);
      if (!raw.rate_limits_available || raw.rate_limits === null) {
        return failed(
          binding,
          "unavailable",
          "Claude did not provide plan usage for this session.",
        );
      }
      const limits: UsageLimit[] = [];
      for (const key of Object.keys(WINDOWS)) {
        const window = raw.rate_limits[key as keyof typeof raw.rate_limits];
        if (!window || Array.isArray(window) || !("resets_at" in window)) continue;
        limits.push(limit(key, window.utilization, isoTime(window.resets_at)));
      }
      for (const window of raw.rate_limits.model_scoped ?? []) {
        limits.push({
          ...limit(
            `weekly_model:${window.display_name}`,
            window.utilization,
            isoTime(window.resets_at),
          ),
          label: `7 days · ${window.display_name}`,
        });
      }
      if (limits.length === 0)
        return failed(binding, "unavailable", "Claude returned no plan windows.");
      return publish({
        provider: "doppelclaude",
        status: "ok",
        ...binding,
        observedAt: now(),
        limits,
        source: "claude-sdk",
      });
    } catch {
      return failed(binding, "error", "Claude usage control request failed.");
    }
  }

  return {
    get(signal?: AbortSignal): Promise<ProviderUsageSnapshot> {
      signal?.throwIfAborted();
      if (!isCurrent()) return Promise.resolve(unavailableUsage());
      if (!inFlight) {
        const pending = read();
        inFlight = pending;
        void pending.finally(() => {
          if (inFlight === pending) inFlight = undefined;
        });
      }
      return independentWait(inFlight, signal);
    },
    async observeRateLimit(raw: unknown): Promise<void> {
      if (!Value.Check(RATE_EVENT, raw) || !isCurrent()) return;
      const observedAt = now();
      const eventRevision = ++revision;
      try {
        const binding = await account();
        if (!isCurrent() || eventRevision !== revision) return;
        const windows = new Map(latest?.limits.map((item) => [item.kind, item]) ?? []);
        const incoming = Object.entries(raw.unifiedWindows ?? {});
        if (raw.rateLimitType && !incoming.some(([key]) => key === raw.rateLimitType)) {
          incoming.push([raw.rateLimitType, raw]);
        }
        for (const [key, window] of incoming) {
          if (window.utilization === undefined && window.resetsAt === undefined) continue;
          const item = limit(
            key,
            window.utilization === undefined ? null : window.utilization * 100,
            eventTime(window.resetsAt),
            window.status ?? raw.status,
          );
          windows.set(item.kind, item);
        }
        if (windows.size === 0) return;
        publish({
          provider: "doppelclaude",
          status: "ok",
          ...binding,
          observedAt,
          limits: [...windows.values()],
          source: "claude-rate-limit-event",
        });
      } catch {
        // A missing account binding must not break the main response or publish another profile's quota.
      }
    },
  };
}

export type AccountUsage = ReturnType<typeof createAccountUsage>;
