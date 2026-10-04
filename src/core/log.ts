/**
 * Logging and desktop notifications.
 *
 * automode never writes to the terminal while an agent owns it, because a
 * stray line would corrupt the TUI. So everything it has to say goes to a log
 * file, plus an optional system notification.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { logPath, stateDir } from "./config.js";
import { redactSecrets } from "./redact.js";

export const MAX_LOG_BYTES = 1_000_000;
export const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const LOG_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

export type Logger = (message: string) => void;

function parseLogTimestamp(line: string): number | null {
  const match = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/.exec(line);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    0,
  );
  if (
    date.getFullYear() !== Number(y)
    || date.getMonth() !== Number(mo) - 1
    || date.getDate() !== Number(d)
    || date.getHours() !== Number(h)
    || date.getMinutes() !== Number(mi)
    || date.getSeconds() !== Number(s)
  ) return null;
  return date.getTime();
}

export function filterLogTextToWindow(
  text: string,
  nowMs = Date.now(),
  retentionMs = LOG_RETENTION_MS,
): string {
  const cutoff = nowMs - Math.max(0, retentionMs);
  return text
    .split(/\r?\n/)
    .filter((line) => {
      if (!line) return false;
      const timestamp = parseLogTimestamp(line);
      return timestamp !== null && timestamp >= cutoff && timestamp <= nowMs + 60_000;
    })
    .join("\n");
}

function pruneExpired(path: string, nowMs: number): void {
  try {
    if (!existsSync(path)) return;
    const original = readFileSync(path, "utf8");
    const filtered = filterLogTextToWindow(original, nowMs);
    const normalized = filtered ? filtered + "\n" : "";
    if (normalized !== original) writeFileSync(path, normalized, "utf8");
  } catch {
    // Retention is best effort; logging must never take down the app.
  }
}

export function readRecentLog(path: string = logPath(), nowMs = Date.now()): string {
  const parts: string[] = [];
  for (const candidate of [`${path}.1`, path]) {
    try {
      if (!existsSync(candidate)) continue;
      const filtered = filterLogTextToWindow(readFileSync(candidate, "utf8"), nowMs);
      if (filtered) parts.push(filtered);
    } catch {
      // A missing/unreadable segment should not hide the other one.
    }
  }
  return parts.join("\n");
}

export function createLogger(enabled = true, path: string = logPath()): Logger {
  let lastMaintenanceAt = 0;
  return (message: string) => {
    if (!enabled) return;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    try {
      mkdirSync(stateDir(), { recursive: true });
      if (now.getTime() - lastMaintenanceAt >= LOG_MAINTENANCE_INTERVAL_MS) {
        pruneExpired(path, now.getTime());
        pruneExpired(`${path}.1`, now.getTime());
        lastMaintenanceAt = now.getTime();
      }
      rotate(path);
      appendFileSync(path, `[${stamp}] ${redactSecrets(message)}\n`, "utf8");
    } catch {
      // Logging must never take a session down.
    }
  };
}

function rotate(path: string): void {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) {
      try {
        if (existsSync(`${path}.1`)) unlinkSync(`${path}.1`);
        renameSync(path, `${path}.1`);
      } catch {
        // Rotation is best effort; logging must not take down the app.
        return;
      }
    }
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
