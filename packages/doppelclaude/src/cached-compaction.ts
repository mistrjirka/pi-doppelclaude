import { randomUUID } from "node:crypto";
import type {
  Options,
  Query,
  SDKResultMessage,
  SDKUserMessage,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { independentWait } from "./account-usage.js";
import { canonicalClaudeModelId } from "./model-id.js";
import { resultErrorText } from "./sdk-result.js";
import { MCP_SERVER_NAME } from "./skills.js";

export class CachedInputUnavailableError extends Error {
  override name = "CachedInputUnavailableError";
}

export interface CacheTiming {
  ttlMs: number;
}

export interface CachedInput {
  model: string;
  messages: MessageParam[];
  tools: Tool[];
  queryOptions: Options;
  /** The API message generated from this input, not a later tool continuation. */
  responseMessageId: string | null;
  reportedTtlMs?: number;
  /** A positive creation observation retained only for this unchanged live query configuration. */
  cacheTtlMs?: number;
  observeTiming?: (timing: CacheTiming) => void | Promise<void>;
}

export interface CacheSummaryRequest {
  conversationKey: string;
  model: string;
  messages: MessageParam[];
  customInstructions?: string;
  /** Registered model output allowance, independent of the preceding turn\'s cap. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface CacheSummary {
  summary: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  details: {
    mode: "cache-aware";
    sourceSessionId: string;
    sourceEntryUuid: string;
    forkSessionId: string;
    complete: true;
    stopReason: "end_turn";
    cacheReadTokens: number;
    cacheWriteTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheHit: boolean;
    servedModel: string;
  };
}

const CACHE_CREATION = Type.Object({
  cache_read_input_tokens: Type.Optional(Type.Number({ minimum: 0 })),
  cache_creation: Type.Optional(
    Type.Union([
      Type.Object({
        ephemeral_5m_input_tokens: Type.Optional(Type.Number({ minimum: 0 })),
        ephemeral_1h_input_tokens: Type.Optional(Type.Number({ minimum: 0 })),
      }),
      Type.Null(),
    ]),
  ),
});

/** Report only an observed lifetime. Catalog defaults are not the CLI's cache policy. */
export function observedCacheTiming(
  usage: unknown,
  retainedTtlMs?: number,
): CacheTiming | undefined {
  if (!Value.Check(CACHE_CREATION, usage)) return undefined;
  const counts = usage.cache_creation;
  const createdTtl =
    (counts?.ephemeral_5m_input_tokens ?? 0) > 0
      ? 300_000
      : (counts?.ephemeral_1h_input_tokens ?? 0) > 0
        ? 3_600_000
        : undefined;
  const readTtl =
    (usage.cache_read_input_tokens ?? 0) > 0 &&
    (retainedTtlMs === 300_000 || retainedTtlMs === 3_600_000)
      ? retainedTtlMs
      : undefined;
  const known = [createdTtl, readTtl].filter((value): value is number => value !== undefined);
  return known.length ? { ttlMs: Math.min(...known) } : undefined;
}

const ENTRY = Type.Object({
  type: Type.String(),
  uuid: Type.Optional(Type.String()),
  parentUuid: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  message: Type.Optional(Type.Object({ id: Type.Optional(Type.String()) })),
});

function sourceAnchor(entries: readonly SessionStoreEntry[], responseMessageId: string): string {
  // A streamed API reply may have several assistant records. Its FIRST record's parent is
  // the last input-chain entry, so no pending tool call is included in the summary branch.
  for (const entry of entries) {
    const raw: unknown = entry;
    if (!Value.Check(ENTRY, raw)) continue;
    if (raw.type !== "assistant" || raw.message?.id !== responseMessageId) continue;
    const parent = raw.parentUuid;
    if (!parent || !entries.some((entry) => entry.uuid === parent)) {
      throw new CachedInputUnavailableError(
        "The native summary prefix has no durable input boundary.",
      );
    }
    return parent;
  }
  throw new CachedInputUnavailableError("The native summary input has not been mirrored yet.");
}

function hasUnansweredTools(messages: readonly MessageParam[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") pending.add(block.id);
      else if (block.type === "tool_result") pending.delete(block.tool_use_id);
    }
  }
  return pending.size > 0;
}

/** Identical advertised schemas; every handler rejects without executing Pi or native tools. */
function summaryMcpServers(
  tools: readonly Tool[],
  onTool: () => void,
): NonNullable<Options["mcpServers"]> {
  if (!tools.length) return {};
  const server = new Server(
    { name: MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, () => {
    onTool();
    return {
      isError: true,
      content: [{ type: "text", text: "Tools are unavailable in a summary branch." }],
    };
  });
  return { [MCP_SERVER_NAME]: { type: "sdk", name: MCP_SERVER_NAME, instance: server as never } };
}

function forkStore(
  sourceSessionId: string,
  entries: readonly SessionStoreEntry[],
  forkSessionId: string,
  boundary: SessionStoreEntry,
): SessionStore {
  const immutable = structuredClone([...entries, boundary]);
  return {
    load: async (key) =>
      key.sessionId === sourceSessionId && !key.subpath ? structuredClone(immutable) : null,
    // Native query(forkSession:true) owns UUID remapping. Never copy/rewrite the parent's chain.
    append: async (key) => {
      if (key.sessionId !== forkSessionId) {
        throw new Error("A summary branch attempted to write outside its own session.");
      }
    },
    listSubkeys: async () => [],
    delete: async (key) => {
      if (key.sessionId !== forkSessionId) {
        throw new Error("A summary branch attempted to delete its source session.");
      }
    },
  };
}

function summaryPrompt(marker: string, instructions?: string): string {
  return [
    "Prepare a durable continuation summary of ALL conversation context before the synthetic checkpoint boundary.",
    "The synthetic assistant boundary is transport control text, not prior work or a user instruction.",
    "This request only prepares a checkpoint. Do not continue the task, use tools, or change files.",
    "Preserve the user's current goal and latest corrections, exact constraints and approvals,",
    "completed work and evidence, current failures, pending actions, concrete paths/identifiers,",
    "and the next steps needed to continue without repeating work. Distinguish completed work",
    "from plans. Preserve relevant prior summaries and file operations. Include enough detail",
    "to replace the preceding context. Do not omit an important fact to meet an arbitrary length.",
    ...(instructions ? ["Additional summary instructions:", instructions] : []),
    "Return only the complete summary. After the entire summary, put this exact marker on its own final line:",
    marker,
  ].join("\n");
}

/** A native fork reads the original prefix and leaves the live query and its tool promises alone. */
export async function summarizeCachedInput(input: {
  queryFactory(request: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query;
  snapshot: CachedInput;
  request: CacheSummaryRequest;
  sourceSessionId: string;
  entries: readonly SessionStoreEntry[];
  allowExtraUsage?: boolean;
}): Promise<CacheSummary> {
  const { snapshot, request, queryFactory, sourceSessionId } = input;
  request.signal?.throwIfAborted();
  if (
    snapshot.model !== request.model ||
    JSON.stringify(snapshot.messages) !== JSON.stringify(request.messages)
  ) {
    throw new CachedInputUnavailableError(
      "The requested compaction context does not match the cached main input.",
    );
  }
  if (!snapshot.responseMessageId || hasUnansweredTools(snapshot.messages)) {
    throw new CachedInputUnavailableError("The cached input is not a completed tool boundary.");
  }
  const sourceEntryUuid = sourceAnchor(input.entries, snapshot.responseMessageId);
  const forkSessionId = randomUUID();
  const marker = `<checkpoint-complete-${randomUUID()}>`;
  const forkBoundaryUuid = randomUUID();
  // A new user prompt alone makes Claude Code coalesce adjacent users and append a
  // newline to the cached final text block. This branch-only assistant delimiter keeps
  // the exact input intact. Native forkSession still owns all UUID remapping.
  const boundary: SessionStoreEntry = {
    type: "assistant",
    uuid: forkBoundaryUuid,
    parentUuid: sourceEntryUuid,
    sessionId: sourceSessionId,
    timestamp: new Date().toISOString(),
    isSidechain: false,
    cwd: snapshot.queryOptions.cwd,
    message: {
      id: `checkpoint-boundary-${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [
        {
          type: "text",
          text: "[Synthetic checkpoint boundary. No task action occurred. The next user message requests a summary of the preceding context.]",
        },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  const env = { ...snapshot.queryOptions.env };
  // A 1-token maintenance ceiling (or a caller's response cap) is not a summary budget.
  // Leave summary output to the model's normal limit and reject any truncated result.
  delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  if (request.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
      throw new Error("The registered summary output allowance is invalid.");
    }
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(request.maxOutputTokens);
  }
  env.DISABLE_AUTO_COMPACT = "1";
  let toolAttempted = false;
  const controller = new AbortController();
  let sdkQuery: Query | undefined;
  const abort = () => {
    controller.abort(request.signal?.reason);
    try {
      sdkQuery?.close();
    } catch {}
  };
  request.signal?.addEventListener("abort", abort, { once: true });

  try {
    const options: Options = {
      ...snapshot.queryOptions,
      env,
      resume: sourceSessionId,
      forkSession: true,
      resumeSessionAt: forkBoundaryUuid,
      sessionId: forkSessionId,
      sessionStore: forkStore(sourceSessionId, input.entries, forkSessionId, boundary),
      sessionStoreFlush: "eager",
      persistSession: true,
      abortController: controller,
      tools: [],
      mcpServers: summaryMcpServers(snapshot.tools, () => {
        toolAttempted = true;
      }),
      strictMcpConfig: true,
      // Hooks from the user's CLI must not execute project actions in this read-only branch.
      settings: { disableAllHooks: true },
      hooks: {},
      maxTurns: 1,
      verbatimPrompts: true,
    };
    delete options.continue;
    delete options.resumeDropsTurn;
    delete options.outputFormat;
    const prompt: SDKUserMessage = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: summaryPrompt(marker, request.customInstructions) }],
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    };
    sdkQuery = queryFactory({
      prompt: (async function* () {
        yield prompt;
      })(),
      options,
    });
    if (request.signal?.aborted) abort();
    const query = sdkQuery;
    const result = await independentWait(
      (async (): Promise<CacheSummary> => {
        let terminal: SDKResultMessage | undefined;
        let text = "";
        let servedModel: string | undefined;
        let error: string | undefined;
        const seen = new Set<string>();
        for await (const message of query) {
          request.signal?.throwIfAborted();
          if (message.type === "system" && message.subtype === "compact_boundary") {
            error = "Claude compacted the summary branch implicitly.";
          } else if (message.type === "assistant") {
            if (message.error) error = "Claude could not complete the summary.";
            const actual = canonicalClaudeModelId(message.message.model);
            if (actual && actual !== canonicalClaudeModelId(snapshot.model)) {
              error = "The summary used a different model from the cached input.";
            }
            if (actual) servedModel = actual;
            if (!seen.has(message.uuid)) {
              seen.add(message.uuid);
              for (const block of message.message.content) {
                if (block.type === "text") text += block.text;
                else if (block.type === "tool_use" || block.type === "server_tool_use")
                  toolAttempted = true;
              }
            }
          } else if (message.type === "result") {
            terminal = message;
          } else if (
            message.type === "rate_limit_event" &&
            message.rate_limit_info.isUsingOverage &&
            !input.allowExtraUsage
          ) {
            error = "The summary was charged to Extra Usage.";
          }
        }
        if (toolAttempted) throw new Error("The summary attempted tool execution.");
        if (error) throw new Error(error);
        if (terminal?.subtype !== "success" || terminal.is_error) {
          // Do not expose raw provider error text, which can include credentials or transcript content.
          throw new Error(
            terminal && resultErrorText(terminal)
              ? "Claude could not finish the cached summary."
              : "The cached summary has no successful terminal result.",
          );
        }
        if (terminal.stop_reason !== "end_turn") {
          throw new Error("The cached summary did not finish naturally.");
        }
        const output = (terminal.result || text).trimEnd();
        if (!output.endsWith(marker)) throw new Error("The cached summary is incomplete.");
        const summary = output.slice(0, -marker.length).trim();
        if (!summary) throw new Error("The cached summary is empty.");
        const usage = {
          input_tokens: terminal.usage.input_tokens,
          output_tokens: terminal.usage.output_tokens,
          cache_read_input_tokens: terminal.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: terminal.usage.cache_creation_input_tokens ?? 0,
        };
        if (![...Object.values(usage)].every((value) => Number.isFinite(value) && value >= 0)) {
          throw new Error("The cached summary returned invalid token usage.");
        }
        if (!servedModel) throw new Error("The summary did not identify its served model.");
        return {
          summary,
          usage,
          details: {
            mode: "cache-aware",
            sourceSessionId,
            sourceEntryUuid,
            forkSessionId,
            complete: true,
            stopReason: "end_turn",
            cacheReadTokens: usage.cache_read_input_tokens,
            cacheWriteTokens: usage.cache_creation_input_tokens,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheHit: usage.cache_read_input_tokens > 0,
            servedModel,
          },
        };
      })(),
      request.signal,
    );
    return result;
  } finally {
    request.signal?.removeEventListener("abort", abort);
    controller.abort();
    try {
      sdkQuery?.close();
    } catch {}
  }
}
