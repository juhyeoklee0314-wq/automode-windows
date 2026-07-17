/** Load and save ~/.config/automode/config.toml. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

export interface PingConfig {
  enabled: boolean;
  message: string;
  times: string[];
  agent: string;
  catchup_minutes: number;
  idle_seconds: number;
}

export interface Config {
  // Auto continue
  auto_continue: boolean;
  continue_message: string;
  answer_limit_prompt: boolean;
  grace_seconds: number;
  idle_guard_seconds: number;
  // General
  language: string;
  timezone: string;
  notify: boolean;
  hotkey: string;
  // Auto ping
  ping: PingConfig;
}

export const DEFAULTS: Config = {
  auto_continue: true,
  continue_message: "continue",
  answer_limit_prompt: true,
  grace_seconds: 60,
  idle_guard_seconds: 5,
  language: "en",
  timezone: "", // empty = system timezone
  notify: true,
  // ctrl+g reaches us from any terminal. alt+g only arrives if the terminal is
  // set to send Option as Meta, which macOS does not do by default.
  hotkey: "ctrl+g, alt+g",
  ping: {
    enabled: false,
    message: "hi",
    times: ["05:00", "17:00"],
    agent: "claude",
    catchup_minutes: 30,
    idle_seconds: 20,
  },
};

const HEADER = `# automode: https://github.com/adrielmendes28/automode-node
# Written by \`automode menu\`. Hand-edit freely, but saving from the menu
# rewrites this file and drops comments.

`;

function xdg(envVar: string, fallback: string[]): string {
  const base = process.env[envVar];
  return base ? join(base, "automode") : join(homedir(), ...fallback, "automode");
}

export const configDir = (): string => xdg("XDG_CONFIG_HOME", [".config"]);
export const configPath = (): string => join(configDir(), "config.toml");
export const stateDir = (): string => xdg("XDG_STATE_HOME", [".local", "state"]);
export const logPath = (): string => join(stateDir(), "automode.log");

/** Config from disk merged over the defaults; defaults alone if unreadable. */
export function load(): Config {
  try {
    const raw = parse(readFileSync(configPath(), "utf8")) as Partial<Config>;
    return {
      ...structuredClone(DEFAULTS),
      ...raw,
      ping: { ...DEFAULTS.ping, ...(raw.ping ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

/** Write the config atomically, so a crash cannot truncate it. */
export function save(config: Config): string {
  const path = configPath();
  mkdirSync(configDir(), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, HEADER + stringify(config), "utf8");
  renameSync(tmp, path);
  return path;
}

export function exists(): boolean {
  return existsSync(configPath());
}
