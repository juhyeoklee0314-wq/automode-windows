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

/** Fire-and-forget desktop notification (best effort). */
export function notify(title: string, message: string): void {
  const cleanDouble = (s: string) => s.replace(/"/g, "'");
  const cleanSingle = (s: string) => s.replace(/'/g, "''");

  try {
    if (process.platform === "darwin") {
      const child = spawn(
        "osascript",
        ["-e", `display notification "${cleanDouble(message)}" with title "${cleanDouble(title)}"`],
        { stdio: "ignore", detached: true },
      );
      child.unref();
      child.on("error", () => {});
      return;
    }

    if (process.platform === "win32") {
      const shell = process.env.SystemRoot
        ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : "powershell.exe";
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
        "$n=New-Object System.Windows.Forms.NotifyIcon; " +
        "$n.Icon=[System.Drawing.SystemIcons]::Information; " +
        `$n.BalloonTipTitle='${cleanSingle(title)}'; ` +
        `$n.BalloonTipText='${cleanSingle(message)}'; ` +
        "$n.Visible=$true; $n.ShowBalloonTip(4000); Start-Sleep -Milliseconds 4500; $n.Dispose();";
      const child = spawn(
        shell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
        { stdio: "ignore", detached: true, windowsHide: true },
      );
      child.unref();
      child.on("error", () => {});
    }
  } catch {
    // Notifications are decoration.
  }
}

export const logFile = (): string => join(stateDir(), "automode.log");
