/**
 * Activation-level proof of the process-scoped owner: two activations in one
 * process share one runtime/stream closure, only the creating activation wires
 * runtime-mutating lifecycle handlers, and its shutdown releases the owner so
 * the next activation creates a fresh owner.
 * The live nested-ModelRuntime integration test exercises the corresponding
 * provider call path; this test isolates activation and teardown semantics.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

// Isolate the bridge settings and seed a valid claude-code prompt mode that
// needs no documentation replacements.
const agentDir = mkdtempSync(join(tmpdir(), "activation-ownership-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(
  join(agentDir, "settings.json"),
  '{"doppelclaude":{"provider":{"systemPromptMode":"claude-code"}}}\n',
);

const OWNER_KEY = Symbol.for("doppelclaude:owner");
// The owner lives on globalThis under a symbol key; view it as a symbol-keyed
// record so reads/clears are typed instead of indexing typeof globalThis.
const ownerRegistry = globalThis as Record<symbol, unknown>;
const { default: activate } = await import("pi-doppelclaude/index");

const MUTATING_EVENTS = [
  "session_start",
  "session_shutdown",
  "model_select",
  "session_compact",
  "session_tree",
];

function fakePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const providers: Provider[] = [];
  const entryRenderers: string[] = [];
  const pi = {
    registerProvider(provider: Provider) {
      providers.push(provider);
    },
    registerEntryRenderer(customType: string) {
      entryRenderers.push(customType);
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, providers, entryRenderers };
}

// Shutdown releases the model pin before exit, so it reads the branch it would restore from.
function shutdownContext(): ExtensionContext {
  return {
    model: undefined,
    sessionManager: { getBranch: (): SessionEntry[] => [] },
  } as unknown as ExtensionContext;
}

afterEach(() => {
  // Drop any owner left standing so each test starts a fresh process generation.
  ownerRegistry[OWNER_KEY] = undefined;
});

after(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("extension activation ownership", () => {
  it("keeps an unconfigured host inactive and reports how to enable it", async () => {
    const settingsPath = join(agentDir, "settings.json");
    const original = readFileSync(settingsPath, "utf8");
    const debugLogPath = join(agentDir, "inactive-debug.log");
    const previousDebug = process.env.DOPPELCLAUDE_DEBUG;
    const previousDebugPath = process.env.DOPPELCLAUDE_DEBUG_PATH;
    writeFileSync(settingsPath, '{"packages":["pi-doppelclaude"]}\n');
    process.env.DOPPELCLAUDE_DEBUG = "1";
    process.env.DOPPELCLAUDE_DEBUG_PATH = debugLogPath;
    try {
      const root = fakePi();
      activate(root.pi);
      assert.deepEqual(root.providers, []);
      assert.deepEqual(root.entryRenderers, []);
      assert.equal(ownerRegistry[OWNER_KEY], undefined);
      assert.deepEqual([...root.handlers.keys()], ["session_start"]);
      const notices: { message: string; level: string }[] = [];
      const context = {
        ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
      };
      await root.handlers.get("session_start")({ type: "session_start", reason: "new" }, context);
      await root.handlers.get("session_start")(
        { type: "session_start", reason: "resume" },
        context,
      );
      assert.equal(notices.length, 1);
      assert.equal(notices[0].level, "info");
      assert.match(notices[0].message, /installed but inactive/);
      assert.ok(notices[0].message.includes(settingsPath));
      assert.match(notices[0].message, /doppelclaude\.provider/);
      assert.match(notices[0].message, /\/reload/);
      assert.equal(existsSync(debugLogPath), false);
      assert.equal(readFileSync(settingsPath, "utf8"), '{"packages":["pi-doppelclaude"]}\n');
    } finally {
      writeFileSync(settingsPath, original);
      if (previousDebug === undefined) delete process.env.DOPPELCLAUDE_DEBUG;
      else process.env.DOPPELCLAUDE_DEBUG = previousDebug;
      if (previousDebugPath === undefined) delete process.env.DOPPELCLAUDE_DEBUG_PATH;
      else process.env.DOPPELCLAUDE_DEBUG_PATH = previousDebugPath;
    }
  });

  it("registers the provider without any discovery work", () => {
    const root = fakePi();
    activate(root.pi);
    assert.equal(root.providers.length, 1);
  });

  it("shares one runtime/stream across activations and gates lifecycle to its owner", async () => {
    const root = fakePi();
    activate(root.pi);
    const borrower = fakePi();
    activate(borrower.pi);

    // Both register the complete native Provider object by reference.
    assert.equal(root.providers.length, 1);
    assert.equal(borrower.providers.length, 1);
    assert.strictEqual(borrower.providers[0], root.providers[0]);
    assert.strictEqual(borrower.providers[0].streamSimple, root.providers[0].streamSimple);

    // The creating activation wires runtime lifecycle + compaction; the borrower wires only compaction.
    for (const event of MUTATING_EVENTS)
      assert.ok(root.handlers.has(event), `root missing ${event}`);
    assert.ok(root.handlers.has("session_before_compact"));
    assert.ok(
      borrower.handlers.has("session_before_compact"),
      "borrower must still run compaction",
    );
    for (const event of MUTATING_EVENTS)
      assert.ok(!borrower.handlers.has(event), `borrower must not wire ${event}`);
  });

  it("owner shutdown releases the runtime so the next activation owns a fresh generation", async () => {
    const first = fakePi();
    activate(first.pi);
    const firstProvider = first.providers[0];

    // A borrower cannot release the owner (it has no shutdown handler at all).
    const borrower = fakePi();
    activate(borrower.pi);
    assert.equal(borrower.handlers.has("session_shutdown"), false);

    // Root shutdown clears the shared runtime and releases the owner.
    await first.handlers.get("session_shutdown")({ type: "session_shutdown" }, shutdownContext());
    assert.equal(ownerRegistry[OWNER_KEY], undefined);

    // Next activation builds a fresh runtime with a distinct stream closure.
    const next = fakePi();
    activate(next.pi);
    assert.notStrictEqual(next.providers[0], firstProvider);
    assert.notStrictEqual(next.providers[0].streamSimple, firstProvider.streamSimple);
  });
});
