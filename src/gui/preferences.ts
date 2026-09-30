import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "../core/config.js";
import { stateDir } from "../core/config.js";
import type { GuiPreferences } from "./types.js";

export const preferencesPath = (): string => join(stateDir(), "gui-preferences.json");

export function defaults(config: Config): GuiPreferences {
  return {
    schemaVersion: 1,
    runAtLogin: false,
    schedulerEnabled: false,
    accounts: [{
      id: "default",
      displayName: "Default profile",
      enabled: true,
      message: config.ping.message,
      schedules: [...config.ping.times],
      agent: config.ping.agent === "codex" ? "codex" : "claude",
    }],
  };
}

function projectPreferences(raw: Partial<GuiPreferences>, config: Config): GuiPreferences {
  const base = defaults(config);
  const accounts = Array.isArray(raw.accounts) && raw.accounts.length ? raw.accounts : base.accounts;
  return {
    schemaVersion: 1,
    runAtLogin: Boolean(raw.runAtLogin),
    schedulerEnabled: Boolean(raw.schedulerEnabled),
    accounts: accounts.map((account, index) => ({
      id: String(account.id || (index === 0 ? "default" : `profile-${index + 1}`)),
      displayName: String(account.displayName || `Profile ${index + 1}`),
      enabled: account.enabled !== false,
      codexHome: account.codexHome ? String(account.codexHome) : undefined,
      message: String(account.message ?? config.ping.message),
      schedules: Array.isArray(account.schedules) ? account.schedules.map(String) : [...config.ping.times],
      agent: account.agent === "codex" ? "codex" : "claude",
    })),
  };
}

export function loadPreferences(config: Config): GuiPreferences {
  try {
    const raw = JSON.parse(readFileSync(preferencesPath(), "utf8")) as Partial<GuiPreferences>;
    return projectPreferences(raw, config);
  } catch {
    return defaults(config);
  }
}

/** Preserve normal fallback semantics while allowing diagnostics to report a corrupt/unreadable file. */
export function loadDiagnosticPreferences(config: Config): GuiPreferences {
  const path = preferencesPath();
  if (!existsSync(path)) return defaults(config);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GuiPreferences>;
  return projectPreferences(raw, config);
}

export function savePreferences(preferences: GuiPreferences): string {
  const path = preferencesPath();
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(preferences, null, 2), "utf8");
  renameSync(tmp, path);
  return path;
}
