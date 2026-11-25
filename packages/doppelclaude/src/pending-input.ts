import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";

export interface PendingInput {
  /** Completed messages, including tool results carried beside pending user input. */
  priorMessages: MessageParam[];
  /** Position in the original history, never the number of merged SDK messages. */
  priorCursor: number;
  promptContent: string | ContentBlockParam[] | null;
  pendingMessageCount: number;
  hasToolResults: boolean;
}

/**
 * A task and extension context can be separate consecutive user messages. They are one
 * pending turn: importing any of them makes Claude Code close it before the live prompt.
 * Keep the completed prefix and tool results in history, and preserve every other block
 * in one SDK prompt. A valid cursor fences input already delivered to a warm session.
 */
export function partitionPendingInput(
  messages: readonly MessageParam[],
  currentSession: { cursor: number; rebuildReason?: string } | null = null,
): PendingInput {
  let start = messages.length;
  while (start > 0 && messages[start - 1].role === "user") start--;
  if (
    currentSession &&
    !currentSession.rebuildReason &&
    currentSession.cursor > start &&
    currentSession.cursor < messages.length
  )
    start = currentSession.cursor;

  const priorMessages = messages.slice(0, start);
  let priorCursor = start;
  const inputs: Array<string | ContentBlockParam[]> = [];
  let hasToolResults = false;
  for (let index = start; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "user") throw new Error("Pending input must contain only user messages");
    if (typeof message.content === "string") {
      inputs.push(message.content);
      continue;
    }
    const results = message.content.filter((block) => block.type === "tool_result");
    if (results.length) {
      hasToolResults = true;
      priorMessages.push({ ...message, content: results });
      priorCursor = index + 1;
    }
    const blocks = message.content.filter((block) => block.type !== "tool_result");
    if (blocks.length) inputs.push(blocks);
  }

  const promptContent =
    inputs.length === 0
      ? null
      : inputs.length === 1 && typeof inputs[0] === "string"
        ? inputs[0]
        : inputs.flatMap((content) =>
            typeof content === "string" ? [{ type: "text" as const, text: content }] : content,
          );
  return {
    priorMessages,
    priorCursor,
    promptContent,
    pendingMessageCount: inputs.length,
    hasToolResults,
  };
}
