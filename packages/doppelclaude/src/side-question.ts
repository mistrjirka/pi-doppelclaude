// Capability-checked access to the SDK's independent side-question control request.
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface SideQuestionRequest {
  conversationKey: string;
  model: string;
  question: string;
  signal?: AbortSignal;
}

// SDK 0.3.310 implements this method but omits it from the public Query type.
// Keep the unchecked SDK boundary here and validate its response before returning it.
type SideQuestionQuery = Query & {
  askSideQuestion?: (question: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
};

const RESPONSE = Type.Object({
  response: Type.String(),
  synthetic: Type.Optional(Type.Boolean()),
});

/** Ask without sending a normal turn, interrupting the query, or changing its transcript. */
export async function askQuerySideQuestion(
  query: Query,
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const ask = (query as SideQuestionQuery).askSideQuestion;
  if (typeof ask !== "function") {
    throw new Error(
      "This Claude Agent SDK has no side-question capability. Update pi-doppelclaude and retry.",
    );
  }

  let removeAbort: (() => void) | undefined;
  try {
    // The SDK receives its own signal. The local race also settles clients of older,
    // non-cooperative implementations without ever calling Query.interrupt() or close().
    const response = await new Promise<unknown>((resolve, reject) => {
      if (signal) {
        const onAbort = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      Promise.resolve(ask.call(query, question, { signal })).then(resolve, reject);
    });
    signal?.throwIfAborted();
    if (response === null) {
      throw new Error(
        "Claude Code could not answer the side question. Retry after the main request starts.",
      );
    }
    if (!Value.Check(RESPONSE, response)) {
      throw new Error("Claude Code returned an unsupported side-question response.");
    }
    if (response.synthetic) throw new Error(response.response);
    return response.response;
  } finally {
    removeAbort?.();
  }
}
