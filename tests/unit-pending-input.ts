import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { planSessionSync } from "doppelclaude/doppel";
import { partitionPendingInput } from "doppelclaude/pending-input";

const sessionId = "11111111-1111-4111-8111-111111111111";
const task: MessageParam = { role: "user", content: "Complete the active task" };
const recall: MessageParam = { role: "user", content: "Historical project notes" };
const answer: MessageParam = { role: "assistant", content: "Done" };

describe("pending native input", () => {
  it("holds every unanswered user message out of imported history", () => {
    const messages = [task, recall, { role: "user" as const, content: "Additional context" }];
    const input = partitionPendingInput(messages);
    assert.deepEqual(input.priorMessages, []);
    assert.equal(input.priorCursor, 0);
    assert.equal(input.pendingMessageCount, 3);
    assert.deepEqual(input.promptContent, [
      { type: "text", text: task.content },
      { type: "text", text: recall.content },
      { type: "text", text: "Additional context" },
    ]);
    assert.equal(planSessionSync(messages, null, input).path, "clean-start");
  });

  it("preserves completed turns and the original cursor when the next input is grouped", () => {
    const messages = [task, recall, answer, task, recall];
    const session = { sessionId, cursor: 2 };
    const input = partitionPendingInput(messages, session);
    assert.deepEqual(input.priorMessages, messages.slice(0, 3));
    assert.equal(input.priorCursor, 3);
    const plan = planSessionSync(messages, session, input);
    assert.equal(plan.path, "reuse");
    assert.equal(plan.reason.kind, "trailing-assistant");
    assert.equal(plan.priorCursor, 3);
  });

  it("does not resend input before a valid delivered cursor", () => {
    const input = partitionPendingInput([task, recall], { cursor: 1 });
    assert.deepEqual(input.priorMessages, [task]);
    assert.equal(input.promptContent, recall.content);
    assert.equal(input.priorCursor, 1);
  });

  it("does not trust a cursor after a rewrite or a shortened history", () => {
    for (const session of [
      { sessionId, cursor: 1, rebuildReason: "session_compact:manual" },
      { sessionId, cursor: 42 },
    ]) {
      const input = partitionPendingInput([task, recall], session);
      assert.deepEqual(input.priorMessages, []);
      assert.equal(input.pendingMessageCount, 2);
    }
  });

  it("retains structured blocks and their metadata without changing caller history", () => {
    const blocks = [
      {
        type: "text" as const,
        text: "Read the attachment",
        cache_control: { type: "ephemeral" as const },
      },
      {
        type: "image" as const,
        source: { type: "url" as const, url: "https://example.com/image.png" },
      },
      {
        type: "document" as const,
        source: { type: "text" as const, media_type: "text/plain" as const, data: "Evidence" },
        title: "Source",
        citations: { enabled: true },
      },
    ];
    const messages: MessageParam[] = [task, { role: "user", content: blocks }, recall];
    const before = structuredClone(messages);
    assert.deepEqual(partitionPendingInput(messages).promptContent, [
      { type: "text", text: task.content },
      ...blocks,
      { type: "text", text: recall.content },
    ]);
    assert.deepEqual(messages, before);
  });

  it("separates mixed and split results without counting the projected array as native history", () => {
    const firstResult = { type: "tool_result" as const, tool_use_id: "first", content: "one" };
    const secondResult = { type: "tool_result" as const, tool_use_id: "second", content: "two" };
    const messages: MessageParam[] = [
      task,
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "first", name: "read", input: {} },
          { type: "tool_use", id: "second", name: "read", input: {} },
        ],
      },
      { role: "user", content: [firstResult, { type: "text", text: "Steer one" }] },
      { role: "user", content: "Steer two" },
      { role: "user", content: [secondResult] },
      recall,
    ];
    const input = partitionPendingInput(messages);
    assert.deepEqual(input.priorMessages, [
      ...messages.slice(0, 2),
      { role: "user", content: [firstResult] },
      { role: "user", content: [secondResult] },
    ]);
    assert.equal(input.priorCursor, 5);
    assert.equal(input.hasToolResults, true);
    assert.deepEqual(input.promptContent, [
      { type: "text", text: "Steer one" },
      { type: "text", text: "Steer two" },
      { type: "text", text: recall.content },
    ]);
    const plan = planSessionSync(messages, { sessionId, cursor: 2 }, input);
    assert.equal(plan.priorCursor, 5);
    assert.deepEqual(plan.reason, { kind: "missed-messages", missed: 3 });
  });

  it("uses no active prompt for results alone or a completed assistant turn", () => {
    const result: MessageParam = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "read", content: "Result" }],
    };
    const input = partitionPendingInput([task, answer, result]);
    assert.deepEqual(input.priorMessages, [task, answer, result]);
    assert.equal(input.promptContent, null);
    assert.equal(input.priorCursor, 3);
    const completed = partitionPendingInput([task, answer]);
    assert.deepEqual(completed.priorMessages, [task, answer]);
    assert.equal(completed.promptContent, null);
  });
});
