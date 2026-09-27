/**
 * Cross-platform command discovery and spawn preparation.
 *
 * Keep platform quirks here so the PTY runner and headless ping paths use the
 * same executable-resolution rules. On Windows, npm CLIs are commonly exposed
 * as .cmd + .ps1 shims rather than native executables.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

export interface SpawnSpec {
  command: string;
  args: string[];
}

function runnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExtensions(): string[] {
  const raw = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
}

function candidates(path: string): string[] {
  if (process.platform !== "win32" || extname(path)) return [path];
  return [path, ...windowsExtensions().map((ext) => path + ext.toLowerCase()), ...windowsExtensions().map((ext) => path + ext.toUpperCase())];
}

/** Where a command lives, or null, without spawning a shell. */
export function which(command: string): string | null {
  const hasSeparator = command.includes("/") || command.includes("\\");
  if (hasSeparator) {
    for (const candidate of candidates(command)) {
      if (runnable(candidate)) return candidate;
    }
    return null;
  }

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates(join(dir, command))) {
      if (runnable(candidate)) return candidate;
    }
  }
  return null;
}

function powershellForShim(): string | null {
  return which("pwsh") ?? which("powershell") ?? which("powershell.exe");
}

function cmdQuote(value: string): string {
  // This path is only a fallback for .cmd/.bat shims that have no sibling
  // PowerShell shim. Quote aggressively and neutralize cmd.exe metacharacters.
  const escaped = value
    .replace(/%/g, "%%")
    .replace(/"/g, '""')
    .replace(/[&|<>^]/g, (c) => `^${c}`);
  return `"${escaped}"`;
}

/**
 * Turn argv into something the platform can spawn directly.
 *
 * POSIX: unchanged.
 * Windows native .exe/.com: unchanged.
 * Windows .cmd/.bat: prefer the sibling npm .ps1 shim and pass all user
 * arguments as separate argv entries. Fall back to cmd.exe only when needed.
 */
export function prepareSpawn(argv: string[]): SpawnSpec {
  const [command, ...args] = argv;
  if (!command) throw new Error("empty command");

  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }

  const ps1 = command.replace(/\.(?:cmd|bat)$/i, ".ps1");
  const powershell = powershellForShim();
  if (powershell && existsSync(ps1)) {
    return {
      command: powershell,
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args],
    };
  }

  const shell = process.env.ComSpec || which("cmd.exe") || "cmd.exe";
  const line = [command, ...args].map(cmdQuote).join(" ");
  return { command: shell, args: ["/d", "/s", "/c", line] };
}
