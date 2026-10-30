import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { createSession } from "cc-session-io";
import { applySessionSync, Doppel, planReplaySync } from "doppelclaude/doppel";
import { BridgeSessionStore } from "doppelclaude/session-store";

const cwd = "/tmp/cache-preserving-continuation";
const id = "toolu_test123";
const name = "mcp__custom-tools__agent_wait";
const call = {
  type: "tool_use" as const,
  id,
  name,
  input: { agent_id: "@blair", timeout_seconds: 300 },
};
const result = {
  type: "tool_result" as const,
  tool_use_id: id,
  content: [{ type: "text" as const, text: "Wait expired; worker still running" }],
};

function fixture() {
  const live = createSession({ projectPath: cwd });
  live.addUserMessage("watch worker");
  live.addAttachment({ type: "environment", snapshot: { workingDirectory: cwd } });
  live.addAssistantMessage([call]);
  const store = new BridgeSessionStore();
  store.replace(live.sessionId, live.records);
  const doppel = new Doppel("test-host", "host");
  doppel.session = {
    sessionId: live.sessionId,
    cursor: 2,
    rebuildReason: "force-close:dead query retry: Query closed before response received",
  };
  const history: MessageParam[] = [
    { role: "user", content: "watch worker" },
    { role: "assistant", content: [call] },
    { role: "user", content: [result] },
  ];
  return { live, store, doppel, history };
}

describe("cache-preserving tool continuation recovery", () => {
  it("appends only missing results and retains the exact SDK mirrored prefix", () => {
    const { live, store, doppel, history } = fixture();
    const before = store.load(live.sessionId);
    const plan = planReplaySync(history, doppel.session);
    assert.equal(plan.path, "rebuild");
    const recovered = applySessionSync({ doppel, plan, cwd, sessionStore: store });
    const after = store.load(live.sessionId);
    assert.equal(recovered.path, "rebuild");
    assert.deepEqual(after?.slice(0, before?.length), before);
    assert.equal(after?.length, (before?.length ?? 0) + 1);
    assert.equal(after?.at(-1)?.type, "user");
    const content = (after?.at(-1)?.message as { content?: unknown } | undefined)?.content;
    assert.deepEqual(content, [result]);
    assert.equal(recovered.rebuild?.divergence?.at, null);
    assert.deepEqual(doppel.session, { sessionId: live.sessionId, cursor: history.length });
  });

  it("falls back to safe full rebuild if the tool call differs", () => {
    const { live, store, doppel, history } = fixture();
    const mismatched: MessageParam[] = [
      history[0],
      { role: "assistant", content: [{ ...call, name: "mcp__custom-tools__different" }] },
      history[2],
    ];
    const rebuilt = applySessionSync({
      doppel,
      plan: planReplaySync(mismatched, doppel.session),
      cwd,
      sessionStore: store,
    });
    assert.equal(rebuilt.path, "rebuild");
    assert.notDeepEqual(store.load(live.sessionId)?.slice(0, live.records.length), live.records);
  });

  it("never fast-paths an intentional compaction or tree rewrite", () => {
    const { live, store, doppel, history } = fixture();
    doppel.session = {
      sessionId: live.sessionId,
      cursor: 2,
      rebuildReason: "session_compact:manual",
    };
    const rebuilt = applySessionSync({
      doppel,
      plan: planReplaySync(history, doppel.session),
      cwd,
      sessionStore: store,
    });
    assert.equal(rebuilt.path, "rebuild");
    assert.notDeepEqual(store.load(live.sessionId)?.slice(0, live.records.length), live.records);
  });
});
