import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Query, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import {
  createAccountUsage,
  type ProviderUsageSnapshot,
  usageProfile,
} from "doppelclaude/account-usage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function control(percent: number | null = 42): SDKControlGetUsageResponse {
  return {
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: percent, resets_at: "2026-11-21T12:00:00Z" },
      seven_day: { utilization: 17, resets_at: null },
      model_scoped: [{ display_name: "Fable", utilization: null, resets_at: null }],
    },
  } as SDKControlGetUsageResponse;
}

function query(read: () => Promise<SDKControlGetUsageResponse>, email = "a@example.test") {
  let accountReads = 0;
  const controls: unknown[] = [];
  const sdk: Pick<
    Query,
    "accountInfo" | "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"
  > = {
    accountInfo: async () => {
      accountReads++;
      return { email, organization: "Example", apiProvider: "firstParty" };
    },
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options) => {
      controls.push(options);
      return read();
    },
  };
  return { sdk, controls, accountReads: () => accountReads };
}

describe("account-bound Claude usage", () => {
  it("reads the active query account and snapshots the child profile without auth data", async () => {
    const env = { CLAUDE_CONFIG_DIR: "/profiles/a", CLAUDE_CODE_OAUTH_TOKEN: "secret-test-token" };
    const profile = usageProfile(env);
    const native = query(async () => control(0));
    const reporter = createAccountUsage(native.sdk, profile, { now: () => 123 });
    env.CLAUDE_CONFIG_DIR = "/profiles/b";
    const first = await reporter.get();
    const second = await reporter.get();
    assert.equal(first.configDir, "/profiles/a");
    assert.equal(first.profileSource, "environment-token");
    assert.equal(first.accountLabel, "a@example.test");
    assert.equal(first.accountId?.length, 24);
    assert.equal(first.observedAt, 123);
    assert.equal(first.status, "ok");
    assert.equal(first.limits.find((limit) => limit.kind === "session")?.percent, 0);
    assert.equal(
      first.limits.find((limit) => limit.kind === "session")?.resetAt,
      Date.parse("2026-11-21T12:00:00Z"),
    );
    assert.equal(
      first.limits.find((limit) => limit.kind.startsWith("weekly_model:"))?.percent,
      null,
    );
    assert.equal(second.accountId, first.accountId);
    assert.equal(native.accountReads(), 1);
    assert.deepEqual(native.controls, [{ skipBehaviors: true }, { skipBehaviors: true }]);
    assert.doesNotMatch(JSON.stringify(first), /secret-test-token/);
    const other = await createAccountUsage(
      query(async () => control(90), "b@example.test").sdk,
      usageProfile({ CLAUDE_CONFIG_DIR: "/profiles/b" }),
    ).get();
    assert.notEqual(other.accountId, first.accountId);
    assert.equal(other.limits[0].percent, 90);
  });

  it("publishes all allowed unified windows with fraction conversion and reset times", async () => {
    const pushes: ProviderUsageSnapshot[] = [];
    const native = query(async () => control());
    const reporter = createAccountUsage(native.sdk, usageProfile({}), {
      now: () => 555,
      observe: (snapshot) => pushes.push(snapshot),
    });
    await reporter.observeRateLimit({
      status: "allowed",
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.13, resetsAt: 1_793_037_600, status: "allowed" },
        seven_day: { utilization: 0.74, resetsAt: 1_793_257_200, status: "allowed" },
      },
    });
    assert.equal(native.controls.length, 0);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].source, "claude-rate-limit-event");
    assert.equal(pushes[0].accountLabel, "a@example.test");
    assert.deepEqual(
      pushes[0].limits.map((item) => [item.kind, item.percent, item.resetAt]),
      [
        ["session", 13, 1_793_037_600_000],
        ["weekly_all", 74, 1_793_257_200_000],
      ],
    );
  });

  it("retains unknown values and does not substitute zero for an unavailable response", async () => {
    let value = control(null);
    const reporter = createAccountUsage(query(async () => value).sdk, usageProfile({}), {
      now: () => 10,
    });
    assert.equal((await reporter.get()).limits[0].percent, null);
    value = { ...value, rate_limits_available: false, rate_limits: null };
    const stale = await reporter.get();
    assert.equal(stale.status, "stale");
    assert.equal(stale.observedAt, 10);
    assert.equal(stale.limits[0].percent, null);
    const missing = await createAccountUsage(query(async () => value).sdk, usageProfile({})).get();
    assert.equal(missing.status, "unavailable");
    assert.equal(missing.observedAt, null);
    assert.deepEqual(missing.limits, []);
  });

  it("deduplicates concurrent control reads and cancels only one caller", async () => {
    const pending = deferred<SDKControlGetUsageResponse>();
    const native = query(() => pending.promise);
    const reporter = createAccountUsage(native.sdk, usageProfile({}));
    const abort = new AbortController();
    const first = reporter.get(abort.signal);
    const second = reporter.get();
    abort.abort();
    await assert.rejects(first, { name: "AbortError" });
    pending.resolve(control(63));
    assert.equal((await second).limits[0].percent, 63);
    assert.equal(native.controls.length, 1);
  });

  it("does not publish an old query's late result after the active session changes", async () => {
    const pending = deferred<SDKControlGetUsageResponse>();
    let current = true;
    const pushes: ProviderUsageSnapshot[] = [];
    const reporter = createAccountUsage(query(() => pending.promise).sdk, usageProfile({}), {
      isCurrent: () => current,
      observe: (snapshot) => pushes.push(snapshot),
    });
    const result = reporter.get();
    current = false;
    pending.resolve(control());
    assert.equal((await result).status, "unavailable");
    assert.deepEqual(pushes, []);
  });

  it("does not overwrite a newer rate event with a late control snapshot", async () => {
    const pending = deferred<SDKControlGetUsageResponse>();
    const started = deferred<void>();
    const native = query(() => {
      started.resolve();
      return pending.promise;
    });
    const reporter = createAccountUsage(native.sdk, usageProfile({}));
    const result = reporter.get();
    await started.promise;
    await reporter.observeRateLimit({
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: 1_793_037_600,
    });
    pending.resolve(control(12));
    const snapshot = await result;
    assert.equal(snapshot.limits[0].percent, 100);
    assert.equal(snapshot.limits[0].severity, "critical");
    assert.equal(snapshot.source, "claude-rate-limit-event");
  });

  it("sanitizes control errors and malformed account data", async () => {
    const failed = await createAccountUsage(
      query(async () => {
        throw new Error("Authorization: Bearer secret-credential");
      }).sdk,
      usageProfile({}),
    ).get();
    assert.equal(failed.status, "error");
    assert.doesNotMatch(JSON.stringify(failed), /secret-credential|Bearer/);
    const malformed = query(async () => control()).sdk;
    malformed.accountInfo = async () => ({ email: 123 }) as never;
    const result = await createAccountUsage(malformed, usageProfile({})).get();
    assert.equal(result.status, "error");
    assert.equal(result.accountId, undefined);
  });
});
