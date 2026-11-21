import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridgeRuntime } from "doppelclaude/bridge-runtime";
import {
  type CachedInput,
  observedCacheTiming,
  summarizeCachedInput,
} from "doppelclaude/cached-compaction";
import { BridgeSessionStore } from "doppelclaude/session-store";

const MODEL = "claude-opus-4-8";
const INPUT = [
  { role: "user" as const, content: "Finish the approved implementation and its tests." },
];
const TOOLS = [
  {
    name: "bash",
    description: "Run a command",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];
const ENTRIES: SessionStoreEntry[] = [
  { type: "user", uuid: "input-uuid", parentUuid: null, message: INPUT[0] },
  {
    type: "assistant",
    uuid: "pending-tool-uuid",
    parentUuid: "input-uuid",
    message: {
      id: "api-reply",
      role: "assistant",
      content: [{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "long-test" } }],
    },
  },
];
function snapshot(): CachedInput {
  return {
    model: MODEL,
    messages: structuredClone(INPUT),
    tools: structuredClone(TOOLS),
    responseMessageId: "api-reply",
    queryOptions: {
      cwd: "/test/project",
      model: MODEL,
      systemPrompt: "Original system prompt",
      effort: "high",
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      env: {
        CLAUDE_CONFIG_DIR: "/profiles/a",
        CLAUDE_CODE_OAUTH_TOKEN: "not-logged",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1",
      },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
interface FakeOptions {
  cacheRead?: number;
  stopReason?: string;
  omitMarker?: boolean;
  missingResult?: boolean;
  model?: string;
  tool?: boolean;
  hold?: Promise<void>;
}
function factory(config: FakeOptions = {}) {
  const observed: { options?: Options; closes: number; calls: number; prompt?: string } = {
    closes: 0,
    calls: 0,
  };
  const entered = deferred<void>();
  const queryFactory = (request: {
    prompt: AsyncIterable<SDKUserMessage>;
    options?: Options;
  }): Query => {
    observed.options = request.options;
    observed.calls++;
    const generator = (async function* (): AsyncGenerator<SDKMessage> {
      for await (const prompt of request.prompt) {
        const content = prompt.message.content;
        observed.prompt =
          typeof content === "string"
            ? content
            : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
        const marker = observed.prompt.match(/<checkpoint-complete-[^>]+>/)?.[0];
        assert.ok(marker);
        entered.resolve();
        if (config.hold) await config.hold;
        const text =
          "Current goal, approved work, exact test evidence, and next actions." +
          (config.omitMarker ? "" : `\n${marker}`);
        yield {
          type: "assistant",
          uuid: "summary-output",
          session_id: request.options?.sessionId,
          parent_tool_use_id: null,
          message: {
            id: "summary-api-reply",
            role: "assistant",
            model: config.model ?? MODEL,
            content: config.tool
              ? [{ type: "tool_use", id: "bad", name: "bash", input: {} }]
              : [{ type: "text", text }],
          },
        } as unknown as SDKMessage;
        if (!config.missingResult)
          yield {
            type: "result",
            subtype: "success",
            result: text,
            is_error: false,
            stop_reason: config.stopReason ?? "end_turn",
            usage: {
              input_tokens: 20,
              output_tokens: 40,
              cache_read_input_tokens: config.cacheRead ?? 5000,
              cache_creation_input_tokens: 0,
            },
            modelUsage: {},
          } as unknown as SDKMessage;
      }
    })();
    return Object.assign(generator, {
      close() {
        observed.closes++;
      },
      interrupt() {
        throw new Error("Must not interrupt a query to prepare a summary");
      },
    }) as unknown as Query;
  };
  return { queryFactory, observed, entered: entered.promise };
}
function prepare(
  native: ReturnType<typeof factory>,
  changes: Partial<Parameters<typeof summarizeCachedInput>[0]> = {},
) {
  return summarizeCachedInput({
    queryFactory: native.queryFactory,
    snapshot: snapshot(),
    request: { conversationKey: "pi-main", model: MODEL, messages: structuredClone(INPUT) },
    sourceSessionId: "sdk-main",
    entries: structuredClone(ENTRIES),
    ...changes,
  });
}

describe("cached summary preparation", () => {
  it("forks at the exact native input prefix with unchanged prompt/model/tool schemas", async () => {
    const native = factory();
    const original = snapshot();
    const result = await prepare(native, { snapshot: original });
    const options = native.observed.options;
    assert.ok(options);
    const forkStore = options.sessionStore;
    assert.ok(forkStore);
    assert.ok(forkStore.delete);
    assert.equal(options.resume, "sdk-main");
    assert.equal(options.forkSession, true);
    assert.notEqual(options.resumeSessionAt, "input-uuid");
    assert.notEqual(options.sessionId, "sdk-main");
    assert.equal(options.model, original.queryOptions.model);
    assert.deepEqual(options.systemPrompt, original.queryOptions.systemPrompt);
    assert.equal(options.effort, original.queryOptions.effort);
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, "/profiles/a");
    assert.equal(options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
    assert.equal(original.queryOptions.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "1");
    assert.equal(options.env?.DISABLE_AUTO_COMPACT, "1");
    assert.equal(options.maxTurns, 1);
    assert.deepEqual(options.settings, { disableAllHooks: true });
    assert.equal(result.details.complete, true);
    assert.equal(result.details.cacheHit, true);
    assert.equal(result.details.cacheReadTokens, 5000);
    assert.equal(result.details.sourceEntryUuid, "input-uuid");
    assert.doesNotMatch(result.summary, /checkpoint-complete/);
    const forkEntries = await forkStore.load({
      sessionId: "sdk-main",
      projectKey: "/test/project",
    });
    assert.ok(forkEntries);
    assert.deepEqual(forkEntries.slice(0, -1), ENTRIES);
    const boundary = forkEntries.at(-1);
    assert.ok(boundary);
    assert.equal(boundary.uuid, options.resumeSessionAt);
    assert.equal(boundary.parentUuid, "input-uuid");
    assert.equal(boundary.type, "assistant");
    assert.match(JSON.stringify(boundary.message), /Synthetic checkpoint boundary/);
    assert.doesNotMatch(JSON.stringify(boundary.message), /tool_use|tool_result/);
    await assert.rejects(
      forkStore.append({ sessionId: "sdk-main", projectKey: "/test/project" }, []),
      /outside its own session/,
    );
    await assert.rejects(
      forkStore.delete({ sessionId: "sdk-main", projectKey: "/test/project" }),
      /delete its source session/,
    );
    const config = options.mcpServers?.["custom-tools"];
    assert.ok(config && config.type === "sdk");
    const client = new Client({ name: "summary-schema-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools,
        TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input_schema,
        })),
      );
      const call = await client.callTool({ name: "bash", arguments: { command: "must-not-run" } });
      assert.equal(call.isError, true);
    } finally {
      await client.close();
      await config.instance.close();
    }
  });

  it("keeps a live pending command and its eventual result while the summary runs", async () => {
    const held = deferred<void>();
    const native = factory({ hold: held.promise });
    const store = new BridgeSessionStore();
    store.replace("sdk-main", ENTRIES);
    const runtime = createBridgeRuntime({ queryFactory: native.queryFactory, sessionStore: store });
    await runtime.designateHost("pi-main");
    const main = runtime.test.hostContext;
    const live = Object.assign(Object.create(null), {
      close() {
        throw new Error("Must not close the live command");
      },
      interrupt() {
        throw new Error("Must not interrupt the live command");
      },
    }) as Query;
    main.activeQuery = live;
    main.activeModel = MODEL;
    main.cachedInput = snapshot();
    main.persistent = true;
    main.readyForInput = false;
    main.latestCursor = 1;
    runtime.test.setHostSession({ sessionId: "sdk-main", cursor: 1 });
    const command = main.blockOnToolResult("tool-1", "bash");
    const before = store.load("sdk-main");
    const pending = runtime.prepareCompaction({
      conversationKey: "pi-main",
      model: MODEL,
      messages: structuredClone(INPUT),
    });
    await native.entered;
    assert.strictEqual(main.activeQuery, live);
    assert.equal(main.pendingToolCallCount, 1);
    assert.equal(main.readyForInput, false);
    held.resolve();
    const result = await pending;
    assert.equal(result.details.complete, true);
    assert.strictEqual(main.activeQuery, live);
    assert.deepEqual(store.load("sdk-main"), before);
    assert.equal(
      main.deliverToolResult("tool-1", { content: [{ type: "text", text: "Tests passed once." }] }),
      "bash",
    );
    assert.deepEqual(await command, { content: [{ type: "text", text: "Tests passed once." }] });
    assert.equal(main.pendingToolCallCount, 0);
    assert.equal(native.observed.calls, 1);
  });

  it("accepts a complete cold-cache summary and reports the miss accurately", async () => {
    const result = await prepare(factory({ cacheRead: 0 }));
    assert.equal(result.details.cacheHit, false);
    assert.equal(result.details.cacheReadTokens, 0);
    assert.equal(result.details.complete, true);
  });

  it("rejects truncated, incomplete, missing-terminal, wrong-model and tool-using summaries", async () => {
    for (const config of [
      { stopReason: "max_tokens" },
      { omitMarker: true },
      { missingResult: true },
      { model: "claude-haiku-4-5" },
      { tool: true },
    ])
      await assert.rejects(prepare(factory(config)));
  });

  it("rejects changed or unresolved inputs before starting a summary request", async () => {
    const native = factory();
    await assert.rejects(
      prepare(native, {
        request: {
          conversationKey: "pi-main",
          model: MODEL,
          messages: [{ role: "user", content: "Changed branch" }],
        },
      }),
      /does not match/,
    );
    const incomplete = snapshot();
    incomplete.messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "unresolved", name: "bash", input: {} }],
    });
    await assert.rejects(
      prepare(native, {
        snapshot: incomplete,
        request: { conversationKey: "pi-main", model: MODEL, messages: incomplete.messages },
      }),
      /completed tool boundary/,
    );
    await assert.rejects(prepare(native, { entries: [] }), /not been mirrored/);
    assert.equal(native.observed.calls, 0);
  });

  it("cancels only the summary branch, even when its iterator ignores abort", async () => {
    const hold = deferred<void>();
    const native = factory({ hold: hold.promise });
    const controller = new AbortController();
    const pending = prepare(native, {
      request: {
        conversationKey: "pi-main",
        model: MODEL,
        messages: structuredClone(INPUT),
        signal: controller.signal,
      },
    });
    await native.entered;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.ok(native.observed.closes >= 1);
    hold.resolve();
  });
});

describe("observed Claude cache lifetime", () => {
  it("uses actual positive creation counts and chooses the shorter mixed lifetime", () => {
    assert.deepEqual(observedCacheTiming({ cache_creation: { ephemeral_1h_input_tokens: 10 } }), {
      ttlMs: 3_600_000,
    });
    assert.deepEqual(
      observedCacheTiming({
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
      }),
      { ttlMs: 300_000 },
    );
    assert.equal(observedCacheTiming({ cache_read_input_tokens: 1000 }), undefined);
    assert.equal(
      observedCacheTiming({
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      }),
      undefined,
    );
    assert.equal(
      observedCacheTiming({ cache_creation: { ephemeral_1h_input_tokens: "1000" } }),
      undefined,
    );
    assert.deepEqual(observedCacheTiming({ cache_read_input_tokens: 1000 }, 3_600_000), {
      ttlMs: 3_600_000,
    });
    assert.deepEqual(
      observedCacheTiming(
        { cache_read_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 10 } },
        300_000,
      ),
      { ttlMs: 300_000 },
    );
    assert.equal(observedCacheTiming({ cache_read_input_tokens: 0 }, 3_600_000), undefined);
    assert.equal(observedCacheTiming({ cache_read_input_tokens: 1000 }, 42), undefined);
  });
});
