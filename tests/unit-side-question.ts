import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createBridgeRuntime } from "doppelclaude/bridge-runtime";
import { askQuerySideQuestion } from "doppelclaude/side-question";
import { createPiSideQuestionStream } from "pi-doppelclaude/pi-side-question";
import { createAnthropicAgentSdkProvider } from "pi-doppelclaude/provider";
import { bridgeModel } from "./lib/models.js";

const model = bridgeModel("claude-opus-4-8");
const context = normalizeContext({
  messages: [{ role: "user", content: "Explain the retry", timestamp: 1 }],
});

function queryWith(
  askSideQuestion?: (question: string, options?: { signal?: AbortSignal }) => Promise<unknown>,
): Query {
  return Object.assign(Object.create(null), {
    askSideQuestion,
    interrupt: () => {
      throw new Error("Side question must not interrupt the main query");
    },
    close: () => {
      throw new Error("Side question must not close the main query");
    },
  });
}

describe("SDK side-question boundary", () => {
  it("calls only the dedicated control request with independent cancellation", async () => {
    const controller = new AbortController();
    let received: unknown;
    const query = queryWith(async (question, options) => {
      received = { question, signal: options?.signal };
      return { response: "The retry waits.", synthetic: false };
    });
    assert.equal(
      await askQuerySideQuestion(query, "Why retry?", controller.signal),
      "The retry waits.",
    );
    assert.deepEqual(received, { question: "Why retry?", signal: controller.signal });
  });

  it("rejects missing capabilities and malformed control replies", async () => {
    await assert.rejects(askQuerySideQuestion(queryWith(), "Why?"), /no side-question capability/);
    for (const reply of [null, {}, { response: 42 }, { response: "text", synthetic: "yes" }]) {
      await assert.rejects(
        askQuerySideQuestion(
          queryWith(async () => reply),
          "Why?",
        ),
      );
    }
    await assert.rejects(
      askQuerySideQuestion(
        queryWith(async () => ({ response: "Quota unavailable", synthetic: true })),
        "Why?",
      ),
      /Quota unavailable/,
    );
  });

  it("settles cancellation even if the native request ignores its signal", async () => {
    const controller = new AbortController();
    let resolve: (value: unknown) => void = () => {};
    const query = queryWith(
      () =>
        new Promise((finish) => {
          resolve = finish;
        }),
    );
    const pending = askQuerySideQuestion(query, "Why?", controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    resolve({ response: "late" });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(
      askQuerySideQuestion(
        queryWith(async () => {
          throw new Error("Must not call");
        }),
        "Why?",
        alreadyAborted.signal,
      ),
      { name: "AbortError" },
    );
  });
});

describe("bridge side-question isolation", () => {
  it("uses the matching busy query without touching its pending tools or transcript", async () => {
    const runtime = createBridgeRuntime({
      queryFactory: () => {
        throw new Error("Must not spawn a normal query");
      },
    });
    await runtime.designateHost("main-session");
    const main = runtime.test.hostContext;
    const query = queryWith(async () => ({ response: "Side answer" }));
    main.activeQuery = query;
    main.activeModel = model.id;
    main.readyForInput = false;
    main.latestCursor = 7;
    runtime.test.setHostSession({ sessionId: "sdk-session", cursor: 6 });
    const waiting = main.blockOnToolResult("read-1", "read");
    const sessionBefore = structuredClone(runtime.test.getHostSession());
    const answer = await runtime.sideQuestion({
      conversationKey: "main-session",
      model: model.id,
      question: "Why?",
    });
    assert.equal(answer, "Side answer");
    assert.strictEqual(main.activeQuery, query);
    assert.equal(main.latestCursor, 7);
    assert.equal(main.readyForInput, false);
    assert.equal(main.pendingToolCallCount, 1);
    assert.equal(main.currentResponse, null);
    assert.deepEqual(runtime.test.getHostSession(), sessionBefore);
    assert.equal(runtime.test.getStoredSession("sdk-session"), null);
    main.releasePendingToolCalls("test cleanup");
    await waiting;
  });

  it("rejects a missing, changed, closing or stale query without creating a doppel", async () => {
    const runtime = createBridgeRuntime();
    const request = { conversationKey: "unknown", model: model.id, question: "Why?" };
    await assert.rejects(runtime.sideQuestion(request), /No live Claude query/);
    assert.equal(runtime.test.doppels.all().length, 0);
    await runtime.designateHost("unknown");
    const main = runtime.test.hostContext;
    main.activeQuery = queryWith(async () => {
      throw new Error("Must not ask");
    });
    main.activeModel = "different-model";
    await assert.rejects(runtime.sideQuestion(request), /selected model differs/);
    main.activeModel = model.id;
    main.closing = true;
    await assert.rejects(runtime.sideQuestion(request), /No live Claude query/);
    main.closing = false;
    runtime.test.setHostSession({ sessionId: "old", cursor: 1, rebuildReason: "compaction" });
    await assert.rejects(runtime.sideQuestion(request), /No live Claude query/);
  });
});

describe("Pi side-question stream", () => {
  it("routes the capability separately and emits text without a normal provider turn", async () => {
    let normalCalls = 0;
    const requests: unknown[] = [];
    const streamSideQuestion = createPiSideQuestionStream(async (request) => {
      requests.push(request);
      return "Side answer";
    });
    const provider = createAnthropicAgentSdkProvider({
      accountProbe: async () => ({ available: true, supportedModels: [] }),
      stream: () => {
        normalCalls++;
        throw new Error("Normal turn called");
      },
      streamSideQuestion,
    });
    assert.equal(provider.sideQuestionUsesLiveContext, true);
    const controller = new AbortController();
    const stream = provider.streamSideQuestion(model, context, {
      sessionId: "main",
      signal: controller.signal,
    });
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    assert.equal(normalCalls, 0);
    assert.deepEqual(requests, [
      {
        conversationKey: "main",
        model: model.id,
        question: "Explain the retry",
        signal: controller.signal,
      },
    ]);
    assert.deepEqual(result.content, [{ type: "text", text: "Side answer" }]);
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "text_start", "text_delta", "text_end", "done"],
    );
  });

  it("reports independent cancellation as aborted with no late answer", async () => {
    const controller = new AbortController();
    let complete: (answer: string) => void = () => {};
    const stream = createPiSideQuestionStream(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )(model, context, { sessionId: "main", signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    complete("late");
    const result = await stream.result();
    assert.equal(result.stopReason, "aborted");
    assert.deepEqual(result.content, []);
  });

  it("reports native errors and invalid inputs without tool execution", async () => {
    const stream = createPiSideQuestionStream(async () => {
      throw new Error("No live Claude query");
    });
    const result = await stream(model, context, { sessionId: "main" }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /No live Claude query/);
    assert.equal((await stream(model, context).result()).stopReason, "error");
    const image = normalizeContext({
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
          timestamp: 1,
        },
      ],
    });
    assert.match(
      (await stream(model, image, { sessionId: "main" }).result()).errorMessage,
      /text user message/,
    );
  });
});
