/**
 * The pinned native SDK runs against a localhost fixture with fake, isolated auth.
 * These assertions inspect transport, not model reasoning or real cache hits.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MessageParam, RawMessageStreamEvent } from "@anthropic-ai/sdk/resources";
import { createBridgeRuntime } from "doppelclaude/bridge-runtime";
import { BridgeSessionStore } from "doppelclaude/session-store";

const MODEL = "claude-haiku-5-5";
const ANSWER = "Offline capture complete.";
type Payload = { messages: MessageParam[] };

function messageText(message: MessageParam): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function assertPendingTurn(payload: Payload, task: string, recall: string): void {
  const taskIndices = payload.messages.flatMap((message, index) =>
    messageText(message).includes(task) ? [index] : [],
  );
  const recallIndices = payload.messages.flatMap((message, index) =>
    messageText(message).includes(recall) ? [index] : [],
  );
  assert.equal(taskIndices.length, 1, "the active task appears exactly once");
  assert.deepEqual(recallIndices, taskIndices, "task and recall share one pending user turn");
  const pending = payload.messages[taskIndices[0]];
  assert.equal(pending.role, "user");
  assert.ok(messageText(pending).indexOf(task) < messageText(pending).indexOf(recall));
  assert.equal(
    payload.messages.some(
      (message) =>
        message.role === "assistant" && messageText(message) === "No response requested.",
    ),
    false,
    "no synthetic assistant closes an unanswered task",
  );
}

test("native SDK preserves consecutive pending users through fresh, warm, rebuild and resume", {
  timeout: 120_000,
}, async () => {
  const requests: Payload[] = [];
  const unexpected: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const route = new URL(request.url ?? "/", "http://localhost").pathname;
    if (route === "/v1/messages/count_tokens") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    if (request.method !== "POST" || route !== "/v1/messages") {
      unexpected.push(`${request.method} ${route}`);
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "not_found_error", message: "Offline only" } }));
      return;
    }
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Payload);
    const id = `offline-pending-${requests.length}`;
    const events: RawMessageStreamEvent[] = [
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          container: null,
          diagnostics: null,
          stop_details: null,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
            inference_geo: null,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: null,
            speed: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: null },
      },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
          container: null,
          stop_details: null,
        },
        usage: {
          output_tokens: 5,
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens_details: null,
          server_tool_use: null,
        },
      },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream", "request-id": id });
    for (const event of events)
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "doppel-pending-input-"));
  const fixtureUrl = `http://127.0.0.1:${address.port}`;
  const environment: Record<string, string | undefined> = {
    CLAUDE_CONFIG_DIR: directory,
    ANTHROPIC_API_KEY: "offline-fixture-key-not-a-real-credential",
    ANTHROPIC_BASE_URL: fixtureUrl,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    HTTP_PROXY: fixtureUrl,
    HTTPS_PROXY: fixtureUrl,
    ALL_PROXY: fixtureUrl,
    NO_PROXY: "127.0.0.1,localhost",
  };
  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  const setEnvironment = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  setEnvironment(environment);

  const runtime = createBridgeRuntime({ sessionStore: new BridgeSessionStore() });
  const controller = new AbortController();
  const expiry = setTimeout(
    () => controller.abort(new Error("Offline fixture timed out")),
    110_000,
  );
  async function turn(key: string, messages: MessageParam[], task: string, recall: string) {
    const start = requests.length;
    for await (const event of runtime.turn({
      conversationKey: key,
      model: MODEL,
      sdkModel: MODEL,
      messages,
      cwd: directory,
      systemPrompt: "Complete the active assignment. Historical notes provide context.",
      tools: [],
      options: { settingSources: [], skills: [] },
      signal: controller.signal,
    })) {
      assert.notEqual(event.type, "terminal_error", JSON.stringify(event));
    }
    assert.equal(requests.length, start + 1, "one fixture request per model turn");
    assertPendingTurn(requests[start], task, recall);
  }

  try {
    await runtime.designateHost("host");
    const first: MessageParam[] = [
      { role: "user", content: "Active assignment alpha" },
      { role: "user", content: "Historical recall alpha" },
    ];
    await turn("host", first, "Active assignment alpha", "Historical recall alpha");
    assert.equal(runtime.test.getHostSession()?.cursor, 2);

    const warm: MessageParam[] = [
      ...first,
      { role: "assistant", content: ANSWER },
      { role: "user", content: "Active assignment beta" },
      { role: "user", content: "Historical recall beta" },
    ];
    await turn("host", warm, "Active assignment beta", "Historical recall beta");
    assert.equal(runtime.test.getHostSession()?.cursor, 5);

    await runtime.markRebuild("offline pending input rebuild");
    const rebuilt: MessageParam[] = [
      ...warm,
      { role: "assistant", content: ANSWER },
      { role: "user", content: "Active assignment gamma" },
      { role: "user", content: "Historical recall gamma" },
    ];
    await turn("host", rebuilt, "Active assignment gamma", "Historical recall gamma");
    assert.equal(runtime.test.getHostSession()?.cursor, 8);

    await turn("guest", first, "Active assignment alpha", "Historical recall alpha");
    await turn("guest", warm, "Active assignment beta", "Historical recall beta");
    assert.equal(runtime.test.doppels.resolve("guest").session?.cursor, 5);
    assert.deepEqual(unexpected, [], "all traffic stays inside the expected offline fixture");
  } finally {
    clearTimeout(expiry);
    controller.abort();
    await runtime.clear("Offline pending input fixture finished");
    setEnvironment(previousEnvironment);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
