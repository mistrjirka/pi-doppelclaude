import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadActivationSettings } from "pi-doppelclaude/activation-settings";
import { loadBridgeSettings } from "pi-doppelclaude/settings";

function withSettingsDirs(
  fn: (dirs: { agentDir: string; cwd: string; projectDir: string }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "doppelclaude-activation-settings-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const projectDir = join(cwd, CONFIG_DIR_NAME);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  try {
    return fn({ agentDir, cwd, projectDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("loadActivationSettings", () => {
  it("defers a fresh install without creating settings or selecting defaults", () =>
    withSettingsDirs(({ agentDir, cwd }) => {
      const settingsPath = join(agentDir, "settings.json");
      const activation = loadActivationSettings(cwd, { agentDir, env: {} });
      assert.equal(activation.status, "inactive");
      if (activation.status !== "inactive") assert.fail("expected inactive activation");
      assert.ok(activation.message.includes(settingsPath));
      assert.match(activation.message, /doppelclaude\.provider/);
      assert.match(activation.message, /\/reload/);
      assert.equal(existsSync(settingsPath), false);
      // The strict loader used after activation still requires explicit configuration.
      assert.throws(() => loadBridgeSettings(cwd, { agentDir, env: {} }), /requires/);
    }));

  it("ignores project configuration when the global namespace is absent", () =>
    withSettingsDirs(({ agentDir, cwd, projectDir }) => {
      const settingsPath = join(agentDir, "settings.json");
      const original = '{"packages":["pi-doppelclaude"],"theme":"dark"}\n';
      writeFileSync(settingsPath, original);
      writeFileSync(
        join(projectDir, "settings.json"),
        JSON.stringify({ doppelclaude: { provider: { systemPromptMode: "claude-code" } } }),
      );
      assert.equal(loadActivationSettings(cwd, { agentDir, env: {} }).status, "inactive");
      assert.equal(readFileSync(settingsPath, "utf8"), original);
    }));

  it("rejects present empty and partial namespaces", () =>
    withSettingsDirs(({ agentDir, cwd }) => {
      for (const doppelclaude of [
        {},
        { debug: { enabled: false } },
        { provider: {} },
        { provider: { systemPromptMode: "pi" } },
        { provider: { systemPromptMode: "append" } },
      ]) {
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ doppelclaude }));
        assert.throws(
          () => loadActivationSettings(cwd, { agentDir, env: {} }),
          /requires doppelclaude\.provider\.systemPromptReplacements/,
        );
      }
    }));

  it("rejects invalid namespace values instead of treating them as absent", () =>
    withSettingsDirs(({ agentDir, cwd }) => {
      const invalidNamespaces: unknown[] = [
        null,
        false,
        "",
        [],
        { provider: { systemPromptMode: "wrong" } },
      ];
      for (const doppelclaude of invalidNamespaces) {
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ doppelclaude }));
        assert.throws(() => loadActivationSettings(cwd, { agentDir, env: {} }), /invalid settings/);
      }
    }));

  it("preserves configured provider and debug resolution", () =>
    withSettingsDirs(({ agentDir, cwd }) => {
      const replacements = {
        identity: "Custom identity.",
        toolNameNote: "Custom note.",
        documentation: { heading: "Documentation", instructions: ["Read when needed."] },
      };
      for (const provider of [
        { systemPromptMode: "claude-code", oauthTokenCommand: "explicit-command" },
        { systemPromptReplacements: replacements },
        { systemPromptMode: "append", systemPromptReplacements: replacements },
      ]) {
        writeFileSync(
          join(agentDir, "settings.json"),
          JSON.stringify({ doppelclaude: { provider, debug: { enabled: true } } }),
        );
        const options = {
          agentDir,
          env: { DOPPELCLAUDE_DEBUG: "0", DOPPELCLAUDE_DEBUG_PATH: "/explicit/log/path" },
        };
        assert.deepEqual(loadActivationSettings(cwd, options), {
          status: "configured",
          settings: loadBridgeSettings(cwd, options),
        });
      }
    }));

  it("does not suppress malformed global settings or configured debug errors", () =>
    withSettingsDirs(({ agentDir, cwd }) => {
      const settingsPath = join(agentDir, "settings.json");
      writeFileSync(settingsPath, "{");
      assert.throws(
        () => loadActivationSettings(cwd, { agentDir, env: {} }),
        /failed to load global Pi settings.*settings\.json/,
      );
      writeFileSync(
        settingsPath,
        JSON.stringify({ doppelclaude: { provider: { systemPromptMode: "claude-code" } } }),
      );
      assert.throws(
        () => loadActivationSettings(cwd, { agentDir, env: { DOPPELCLAUDE_DEBUG: "yes" } }),
        /DOPPELCLAUDE_DEBUG must be "1" or "0"/,
      );
    }));
});
