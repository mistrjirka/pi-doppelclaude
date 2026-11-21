import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createBridgeRuntime } from "doppelclaude/bridge-runtime";
import {
  type CacheAwareCompactionEvent,
  runCacheAwareCompaction,
} from "pi-doppelclaude/cached-compaction";
import { createCompaction } from "pi-doppelclaude/compaction";
import { bridgeModel } from "./lib/models.js";

const model = { ...bridgeModel("claude-haiku-4-5"), maxTokens: 64_000 };
function event(reason = "manual"): CacheAwareCompactionEvent {
  return {
    type: "session_before_compact",
    method: "cache-aware",
    reason,
    willRetry: false,
    branchEntries: [],
    signal: undefined,
    preparation: {
      firstKeptEntryId: "kept-entry",
      messagesToSummarize: [
        { role: "user", content: "Finish the approved implementation.", timestamp: 1 },
      ],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      fileOps: { read: new Set(), edited: new Set(), written: new Set() },
      settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
    },
  };
}
function standalone(
  config: {
    truncated?: boolean;
    tool?: boolean;
    omitMarker?: boolean;
    missingResult?: boolean;
  } = {},
) {
  let calls = 0;
  let outputAllowance: string | undefined;
  const compaction = createCompaction({
    queryFactory: ({ prompt, options }) => {
      calls++;
      outputAllowance = options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
      const marker = prompt.match(/<checkpoint-complete-[^>]+>/)?.[0];
      assert.ok(marker, "cold fallback requests an explicit completion marker");
      const text =
        "Approved goal, completed work, validation and next actions." +
        (config.omitMarker ? "" : `\n${marker}`);
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            uuid: "summary",
            session_id: "isolated",
            parent_tool_use_id: null,
            message: {
              model: model.id,
              content: config.tool
                ? [{ type: "tool_use", id: "bad", name: "bash", input: {} }]
                : [{ type: "text", text }],
            },
          } as unknown as SDKMessage;
          if (!config.missingResult)
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              result: text,
              stop_reason: config.truncated ? "max_tokens" : "end_turn",
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
              modelUsage: {},
            } as unknown as SDKMessage;
        },
        async interrupt() {},
        close() {},
      };
    },
    loadProviderSettings: () => ({ systemPromptMode: "claude-code" }),
    loadRetryPolicy: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 0 }),
  });
  return {
    run: (input: CacheAwareCompactionEvent) =>
      compaction.run({
        preparation: input.preparation,
        model,
        branchEntries: [],
        customInstructions: undefined,
        signal: input.signal,
        cwd: "/test/project",
        projectTrusted: true,
        requireComplete: true,
      }),
    calls: () => calls,
    outputAllowance: () => outputAllowance,
  };
}

describe("cache-aware native compaction routing", () => {
  it("uses a complete, explicitly cold isolated summary after a fresh resume", async () => {
    for (const reason of ["manual", "threshold", "overflow"]) {
      const input = event(reason);
      const cold = standalone();
      const result = await runCacheAwareCompaction({
        event: input,
        model,
        prepare: async () => {
          throw new Error("No cached snapshot should be invoked");
        },
        standalone: () => cold.run(input),
      });
      assert.ok(result);
      assert.match(result.summary, /Approved goal/);
      assert.doesNotMatch(result.summary, /checkpoint-complete/);
      assert.equal(result.firstKeptEntryId, "kept-entry");
      assert.equal(result.usage?.cacheRead, 0);
      assert.deepEqual(result.details, {
        readFiles: [],
        modifiedFiles: [],
        method: "standalone",
        requestedMethod: "cache-aware",
        fallbackReason: "No matching cached main input is available.",
      });
      assert.equal(cold.calls(), 1);
      assert.equal(
        cold.outputAllowance(),
        "64000",
        "full registered model allowance, not the main turn cap",
      );
    }
  });

  it("falls back when a captured Pi input has no live native query after resume", async () => {
    const runtime = createBridgeRuntime({
      queryFactory: () => {
        throw new Error("Must not start the persistent bridge");
      },
    });
    const input = event();
    input.cacheRequest = {
      sessionId: "resumed-pi",
      model,
      context: { messages: [] },
      sourceEntryId: "old-input",
      startedAt: 1,
    };
    const cold = standalone();
    const result = await runCacheAwareCompaction({
      event: input,
      model,
      prepare: () =>
        runtime.prepareCompaction({ conversationKey: "resumed-pi", model: model.id, messages: [] }),
      standalone: () => cold.run(input),
    });
    assert.ok(result);
    assert.equal(cold.calls(), 1);
    assert.match(JSON.stringify(result.details), /No matching live cached input/);
  });

  it("does not start a cold model request for unavailable proactive compaction", async () => {
    const input = event("cache-expiry");
    const result = await runCacheAwareCompaction({
      event: input,
      model,
      prepare: async () => {
        throw new Error("No cached request");
      },
      standalone: async () => {
        throw new Error("Proactive fallback must not run");
      },
    });
    assert.equal(result, undefined);
  });

  it("never turns a failed or unsafe cached summary into an unannounced second request", async () => {
    const input = event();
    input.cacheRequest = {
      sessionId: "pi",
      model,
      context: { messages: [] },
      sourceEntryId: "input",
      startedAt: 1,
    };
    await assert.rejects(
      runCacheAwareCompaction({
        event: input,
        model,
        prepare: async () => {
          throw new Error("The cached summary is incomplete.");
        },
        standalone: async () => {
          throw new Error("Must not use a fallback");
        },
      }),
      /cached summary is incomplete/,
    );
  });

  it("rejects cold fallback truncation, tool attempts, missing markers and missing terminal results", async () => {
    for (const config of [
      { truncated: true },
      { tool: true },
      { omitMarker: true },
      { missingResult: true },
    ]) {
      const input = event();
      const cold = standalone(config);
      await assert.rejects(
        runCacheAwareCompaction({
          event: input,
          model,
          prepare: async () => {
            throw new Error("No cached request");
          },
          standalone: () => cold.run(input),
        }),
        /incomplete or unsafe/,
      );
      assert.equal(cold.calls(), 1);
    }
  });
});
