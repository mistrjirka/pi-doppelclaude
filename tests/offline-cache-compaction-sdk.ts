/**
 * Offline native-SDK integration. All model traffic goes to a localhost fixture server.
 * Synthetic token counters prove accounting propagation, not an Anthropic cache hit.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { createBridgeRuntime } from "doppelclaude/bridge-runtime";
import { BridgeSessionStore } from "doppelclaude/session-store";

const MODEL = "claude-sonnet-4-6";
type Payload = {
  max_tokens: number;
  model: string;
  system?: unknown;
  tools?: unknown;
  thinking?: unknown;
  messages: Array<{ role: string; content: unknown }>;
};

function withoutCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, item]) => [key, withoutCacheMarkers(item)]),
    );
  }
  return value;
}
function blocks(content: unknown): unknown[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : (content as unknown[]);
}
function assertInputPrefix(parent: Payload, child: Payload) {
  assert.equal(child.model, parent.model, "same model");
  assert.deepEqual(child.system, parent.system, "same system prompt and cache breakpoints");
  assert.deepEqual(child.tools, parent.tools, "same advertised tools and cache breakpoints");
  assert.deepEqual(child.thinking, parent.thinking, "same thinking configuration");
  assert.ok(child.messages.length >= parent.messages.length, "original input remains a prefix");
  for (let i = 0; i < parent.messages.length; i++) {
    assert.equal(child.messages[i].role, parent.messages[i].role);
    const expected = blocks(withoutCacheMarkers(parent.messages[i].content));
    const actual = blocks(withoutCacheMarkers(child.messages[i].content));
    assert.deepEqual(
      actual.slice(0, expected.length),
      expected,
      `original message ${i} content prefix`,
    );
    if (i < parent.messages.length - 1) assert.equal(actual.length, expected.length);
  }
  // The CLI moves its final breakpoint forward. The original final block must still
  // be within Anthropic's 20-block lookup window, with an unchanged lifetime policy.
  const parentBlocks = parent.messages.flatMap((message) => blocks(message.content)) as Array<
    Record<string, unknown>
  >;
  const childBlocks = child.messages.flatMap((message) => blocks(message.content)) as Array<
    Record<string, unknown>
  >;
  let oldBoundary = -1;
  for (const [index, block] of parentBlocks.entries()) if (block.cache_control) oldBoundary = index;
  assert.equal(oldBoundary, parentBlocks.length - 1, "main input ends at a cache breakpoint");
  const reachable = childBlocks.findIndex(
    (block, index) => index >= oldBoundary && Boolean(block.cache_control),
  );
  assert.ok(
    reachable >= oldBoundary && reachable - oldBoundary < 20,
    "original boundary remains reachable by cache lookback",
  );
  assert.deepEqual(
    childBlocks[reachable].cache_control,
    parentBlocks[oldBoundary].cache_control,
    "unchanged cache lifetime request",
  );
}
function sse(
  res: ServerResponse,
  id: string,
  text: string | undefined,
  tool: string | undefined,
  cached: boolean,
) {
  const usage = {
    input_tokens: 80,
    output_tokens: 1,
    cache_read_input_tokens: cached ? 2000 : 0,
    cache_creation_input_tokens: cached ? 0 : 2000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cached ? 0 : 2000 },
  };
  const block = tool
    ? { type: "tool_use", id: "offline-tool-1", name: tool, input: {} }
    : { type: "text", text: "" };
  const events: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify({ command: "simulated long command" }),
          }
        : { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 40 },
    },
    { type: "message_stop" },
  ];
  res.writeHead(200, { "content-type": "text/event-stream", "request-id": id });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
async function eventually(check: () => boolean, label: string) {
  const until = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= until) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const cachedPrelude of [false, true])
  test(`native SDK preserves a pending command and exact cache prefix${cachedPrelude ? " after a read-only cache hit" : ""}`, {
    timeout: 90_000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "doppel-cache-sdk-"));
    const requests: Payload[] = [];
    const unexpected: string[] = [];
    let initialTool: string | undefined;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const route = new URL(req.url ?? "/", "http://localhost").pathname;
      if (route === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 2080 }));
        return;
      }
      if (req.method !== "POST" || route !== "/v1/messages") {
        unexpected.push(`${req.method} ${route}`);
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { type: "not_found_error", message: "Offline fixture route only" },
          }),
        );
        return;
      }
      const payload = JSON.parse(body) as Payload;
      requests.push(payload);
      const content = JSON.stringify(payload.messages);
      const marker = content.match(/<checkpoint-complete-[^>]+>/)?.[0];
      if (marker) {
        sse(
          res,
          "offline-summary",
          `Full checkpoint with goals, evidence and pending work.\n${marker}`,
          undefined,
          true,
        );
      } else if (cachedPrelude && requests.length === 1) {
        sse(res, "offline-prelude", "Earlier work complete.", undefined, false);
      } else if (requests.length === (cachedPrelude ? 2 : 1)) {
        initialTool = (payload.tools as Array<{ name: string }>).find((tool) =>
          tool.name.endsWith("__bash"),
        )?.name;
        assert.ok(initialTool, "native request advertises the bridged tool");
        sse(res, "offline-parent", undefined, initialTool, cachedPrelude);
      } else {
        sse(res, "offline-finished", "The original command completed once.", undefined, true);
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const envKeys = [
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ];
    const saved = new Map(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    process.env.CLAUDE_CONFIG_DIR = directory;
    process.env.ANTHROPIC_API_KEY = "offline-fixture-key-not-a-real-credential";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}`;
    const store = new BridgeSessionStore();
    const runtime = createBridgeRuntime({ sessionStore: store });
    const controller = new AbortController();
    const expiry = setTimeout(
      () => controller.abort(new Error("Offline native SDK test timed out")),
      75_000,
    );
    expiry.unref();
    try {
      await runtime.designateHost("offline-pi");
      const messages: MessageParam[] = [
        ...(cachedPrelude
          ? [
              { role: "user" as const, content: "Inspect the task constraints first." },
              { role: "assistant" as const, content: "Earlier work complete." },
            ]
          : []),
        {
          role: "user",
          content:
            "Run the simulated long command and report the result. " +
            "Fixture context. ".repeat(150),
        },
      ];
      const timings: number[] = [];
      const request = {
        conversationKey: "offline-pi",
        model: MODEL,
        sdkModel: MODEL,
        messages,
        cwd: directory,
        systemPrompt: "You are an offline fixture assistant. Follow the user's request.",
        tools: [
          {
            name: "bash",
            description: "Run the simulated command",
            input_schema: {
              type: "object" as const,
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
        options: { settingSources: [] as [], skills: [] as [] },
        signal: controller.signal,
        observeCacheTiming: (timing: { ttlMs: number }) => {
          timings.push(timing.ttlMs);
        },
      };
      if (cachedPrelude) {
        for await (const _event of runtime.turn({ ...request, messages: messages.slice(0, 1) })) {
        }
        assert.deepEqual(
          timings,
          [3_600_000],
          "initial creation establishes the live query lifetime",
        );
        timings.length = 0;
      }
      const firstEvents = [];
      for await (const event of runtime.turn(request)) firstEvents.push(event);
      const main = runtime.test.hostContext;
      await eventually(() => main.pendingToolCallCount === 1, "pending native MCP command");
      const session = runtime.test.getHostSession();
      assert.ok(session);
      await eventually(
        () =>
          Boolean(
            store
              .load(session.sessionId)
              ?.some(
                (entry) => (entry.message as { id?: string } | undefined)?.id === "offline-parent",
              ),
          ),
        "eager mirrored input",
      );
      const live = main.activeQuery;
      const originalEntries = store.load(session.sessionId);
      const summary = await runtime.prepareCompaction({
        conversationKey: "offline-pi",
        model: MODEL,
        messages,
        maxOutputTokens: 64_000,
        signal: controller.signal,
      });
      assert.equal(summary.details.complete, true);
      assert.equal(summary.details.cacheReadTokens, 2000, "synthetic fixture accounting");
      assert.strictEqual(main.activeQuery, live);
      assert.equal(main.pendingToolCallCount, 1);
      assert.deepEqual(
        store.load(session.sessionId),
        originalEntries,
        "summary did not mutate the live transcript",
      );
      assert.deepEqual(timings, [3_600_000], "only the main request reports verified TTL");
      const mainIndex = cachedPrelude ? 1 : 0;
      assert.equal(requests.length, mainIndex + 2);
      assertInputPrefix(requests[mainIndex], requests[mainIndex + 1]);
      assert.equal(
        requests[mainIndex + 1].max_tokens,
        64_000,
        "summary uses the registered output allowance",
      );
      assert.ok(initialTool);
      const continuation: MessageParam[] = [
        ...messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "offline-tool-1",
              name: initialTool,
              input: { command: "simulated long command" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "offline-tool-1",
              content: "Command finished exactly once.",
            },
          ],
        },
      ];
      const finalEvents = [];
      for await (const event of runtime.turn({ ...request, messages: continuation }))
        finalEvents.push(event);
      assert.match(JSON.stringify(finalEvents), /original command completed once/);
      assert.equal(main.pendingToolCallCount, 0);
      assert.equal(requests.length, mainIndex + 3);
      assert.deepEqual(
        timings,
        [3_600_000, 3_600_000],
        "read-only continuation retains the same query lifetime",
      );
      // A fresh child/configuration must not borrow the old account\'s observed lifetime.\n    const oldQuery = main.activeQuery;\n    for await (const _event of runtime.turn({\n      ...request, systemPrompt: "A different fixture configuration.",\n      messages: [{ role: "user", content: "Answer once under the new configuration." }],\n    })) {}\n    assert.notStrictEqual(main.activeQuery, oldQuery);\n    assert.deepEqual(timings, [3_600_000, 3_600_000], "an unobserved fresh child does not inherit TTL");\n    assert.deepEqual(unexpected, []);
    } finally {
      clearTimeout(expiry);
      controller.abort();
      await runtime.clear("offline fixture finished");
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
