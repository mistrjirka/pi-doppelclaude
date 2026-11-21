import {
  type Api,
  type Context,
  calculateCost,
  type Model,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import type { CompactionResult, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { CachedInputUnavailableError, type CacheSummary } from "doppelclaude/cached-compaction";

export interface CacheAwareCompactionFields {
  method?: "cache-aware" | "extension";
  cacheRequest?: {
    sessionId: string;
    model: Model<Api>;
    context: Context | TranscriptContext;
    sourceEntryId: string | null;
    startedAt: number;
    ttlMs?: number;
  };
}

export type CacheAwareCompactionEvent = Omit<SessionBeforeCompactEvent, "reason"> &
  CacheAwareCompactionFields & { reason: string };

/** Only lack of a usable snapshot may select the explicitly cold fallback. */
export async function runCacheAwareCompaction(input: {
  event: CacheAwareCompactionEvent;
  model: Model<Api>;
  prepare(cached: NonNullable<CacheAwareCompactionFields["cacheRequest"]>): Promise<CacheSummary>;
  standalone(): Promise<CompactionResult>;
}): Promise<CompactionResult | undefined> {
  const { event, model } = input;
  const cached = event.cacheRequest;
  let fallbackReason = "No matching cached main input is available.";
  if (cached && cached.model.id === model.id && cached.model.provider === model.provider) {
    try {
      return cachedCompactionResult(await input.prepare(cached), event, model);
    } catch (error) {
      if (!(error instanceof CachedInputUnavailableError)) throw error;
      fallbackReason = error.message;
    }
  }
  event.signal?.throwIfAborted();
  if (event.reason === "cache-expiry") return undefined;
  const result = await input.standalone();
  return {
    ...result,
    details: {
      ...(result.details && typeof result.details === "object" ? result.details : {}),
      method: "standalone",
      requestedMethod: "cache-aware",
      fallbackReason,
    },
  };
}

export function cachedCompactionResult(
  result: CacheSummary,
  event: CacheAwareCompactionEvent,
  model: Model<Api>,
): CompactionResult {
  const files = event.preparation.fileOps;
  const prior = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
  const priorDetails =
    prior?.type === "compaction"
      ? (prior.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined)
      : undefined;
  if (Array.isArray(priorDetails?.readFiles)) {
    for (const file of priorDetails.readFiles) if (typeof file === "string") files.read.add(file);
  }
  if (Array.isArray(priorDetails?.modifiedFiles)) {
    for (const file of priorDetails.modifiedFiles)
      if (typeof file === "string") files.edited.add(file);
  }
  const modifiedFiles = [...new Set([...files.edited, ...files.written])].sort();
  const modified = new Set(modifiedFiles);
  const readFiles = [...files.read].filter((file) => !modified.has(file)).sort();
  const usage: Usage = {
    input: result.usage.input_tokens,
    output: result.usage.output_tokens,
    cacheRead: result.usage.cache_read_input_tokens,
    cacheWrite: result.usage.cache_creation_input_tokens,
    totalTokens: Object.values(result.usage).reduce((total, value) => total + value, 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  const fileText = [
    ...(readFiles.length ? [`<read-files>\n${readFiles.join("\n")}\n</read-files>`] : []),
    ...(modifiedFiles.length
      ? [`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`]
      : []),
  ].join("\n\n");
  return {
    summary: fileText ? `${result.summary}\n\n${fileText}` : result.summary,
    firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
    usage,
    details: {
      ...result.details,
      method: "cache-aware",
      sourcePiEntryId: event.cacheRequest?.sourceEntryId ?? null,
      readFiles,
      modifiedFiles,
    },
  };
}
