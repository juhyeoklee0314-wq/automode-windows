/**
 * Logging and desktop notifications.
 *
 * automode never writes to the terminal while an agent owns it, because a
 * stray line would corrupt the TUI. So everything it has to say goes to a log
 * file, plus an optional system notification.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { logPath, stateDir } from "./config.js";

const MAX_LOG_BYTES = 1_000_000;

export type Logger = (message: string) => void;

export function createLogger(enabled = true, path: string = logPath()): Logger {
  return (message: string) => {
    if (!enabled) return;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    try {
      mkdirSync(stateDir(), { recursive: true });
      rotate(path);
      appendFileSync(path, `[${stamp}] ${message}\n`, "utf8");
    } catch {
      // Logging must never take a session down.
    }
  };
}

function rotate(path: string): void {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // No file yet, or no permission. Either way, nothing to rotate.
  }
}

/** Fire-and-forget desktop notification (macOS only, best effort). */
export function notify(title: string, message: string): void {
  if (process.platform !== "darwin") return;
  const clean = (s: string) => s.replace(/"/g, "'");
  try {
    const child = spawn(
      "osascript",
      ["-e", `display notification "${clean(message)}" with title "${clean(title)}"`],
      { stdio: "ignore", detached: true },
    );
    child.unref();
    child.on("error", () => {});
  } catch {
    // Notifications are decoration.
  }
}

export const logFile = (): string => join(stateDir(), "automode.log");
