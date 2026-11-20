// Pi stream adapter for the SDK's tool-free side-question control request.
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { SideQuestionRequest } from "doppelclaude/side-question";

export function createPiSideQuestionStream(ask: (request: SideQuestionRequest) => Promise<string>) {
  return (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      // The control response contains no usage. These required structural values
      // must not be presented as measured tokens or added to the main session.
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };
    queueMicrotask(async () => {
      stream.push({ type: "start", partial: output });
      try {
        options?.signal?.throwIfAborted();
        if (!options?.sessionId) {
          throw new Error("DoppelClaude side questions require the current Pi session identity.");
        }
        const last = context.messages.at(-1);
        if (
          last?.role !== "user" ||
          (Array.isArray(last.content) && last.content.some((block) => block.type !== "text"))
        ) {
          throw new Error("A side question must end with a text user message.");
        }
        const question =
          typeof last.content === "string"
            ? last.content
            : last.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
        if (!question.trim()) throw new Error("The side question is empty.");
        const answer = await ask({
          conversationKey: options.sessionId,
          model: model.id,
          question,
          signal: options.signal,
        });
        options.signal?.throwIfAborted();
        output.content.push({ type: "text", text: answer });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: answer, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: answer, partial: output });
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output });
      } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        output.stopReason = reason;
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason, error: output });
      }
      stream.end(output);
    });
    return stream;
  };
}
