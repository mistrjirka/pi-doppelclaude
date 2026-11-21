import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sdkChildEnv } from "doppelclaude/sdk-child-env";

const UMBRELLA = "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC";

describe("SDK child usage and privacy policy", () => {
  it("allows requested quota reads while retaining telemetry, error and update opt-outs", () => {
    const saved = process.env[UMBRELLA];
    try {
      delete process.env[UMBRELLA];
      const child = sdkChildEnv();
      assert.equal(child[UMBRELLA], undefined);
      assert.equal(child.DISABLE_TELEMETRY, "1");
      assert.equal(child.DISABLE_ERROR_REPORTING, "1");
      assert.equal(child.DISABLE_AUTOUPDATER, "1");
      assert.equal(child.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, "1");
      assert.equal(child.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
      assert.equal(child.DISABLE_AUTO_COMPACT, "1");
      assert.equal(process.env[UMBRELLA], undefined, "the parent environment is unchanged");
    } finally {
      if (saved === undefined) delete process.env[UMBRELLA];
      else process.env[UMBRELLA] = saved;
    }
  });

  it("preserves every explicit caller umbrella value rather than overriding a traffic opt-out", () => {
    const saved = process.env[UMBRELLA];
    try {
      // The pinned CLI tests nonempty strings. Even '0' and 'false' are explicit opt-outs.
      for (const value of ["1", "0", "false", ""]) {
        process.env[UMBRELLA] = value;
        const child = sdkChildEnv();
        assert.equal(child[UMBRELLA], value);
        assert.equal(process.env[UMBRELLA], value);
        assert.equal(child.DISABLE_TELEMETRY, "1");
        assert.equal(child.DISABLE_ERROR_REPORTING, "1");
        assert.equal(child.DISABLE_AUTOUPDATER, "1");
        assert.equal(child.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, "1");
      }
    } finally {
      if (saved === undefined) delete process.env[UMBRELLA];
      else process.env[UMBRELLA] = saved;
    }
  });
});
