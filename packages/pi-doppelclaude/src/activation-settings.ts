import { join } from "node:path";
import {
  type BridgeSettings,
  type LoadSettingsOptions,
  readBridgeSettings,
  resolveBridgeSettings,
} from "./settings.js";

export type BridgeActivationSettings =
  | { status: "inactive"; message: string }
  | { status: "configured"; settings: BridgeSettings };

/** Missing configuration defers activation. Supplied configuration stays strict. */
export function loadActivationSettings(
  cwd: string,
  options: LoadSettingsOptions = {},
): BridgeActivationSettings {
  const source = readBridgeSettings(cwd, options);
  if (source.fileSettings === undefined) {
    return {
      status: "inactive",
      message:
        "DoppelClaude is installed but inactive: no doppelclaude configuration in " +
        `${join(source.agentDir, "settings.json")}. Configure doppelclaude.provider, then /reload to enable it.`,
    };
  }
  return { status: "configured", settings: resolveBridgeSettings(source) };
}
