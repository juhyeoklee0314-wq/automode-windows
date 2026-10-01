/**
 * Cross-platform command discovery and spawn preparation.
 *
 * Keep platform quirks here so the PTY runner and headless ping paths use the
 * same executable-resolution rules. On Windows, npm CLIs are commonly exposed
 * as .cmd + .ps1 shims rather than native executables.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, extname, join, parse } from "node:path";

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

function windowsExtensions(raw = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD"): string[] {
  return raw
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
}

export function commandCandidates(
  path: string,
  platform = process.platform,
  pathext = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
): string[] {
  if (platform !== "win32" || extname(path)) return [path];

  // Windows CreateProcess cannot directly execute npm's extensionless POSIX
  // shim. Resolve only PATHEXT-backed files such as codex.cmd/codex.exe.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ext of windowsExtensions(pathext)) {
    for (const candidate of [path + ext.toLowerCase(), path + ext.toUpperCase()]) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
  }
  return out;
}

/** Where a command lives, or null, without spawning a shell. */
export function which(command: string): string | null {
  const hasSeparator = command.includes("/") || command.includes("\\");
  if (hasSeparator) {
    for (const candidate of commandCandidates(command)) {
      if (runnable(candidate)) return candidate;
    }
    return null;
  }

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const candidate of commandCandidates(join(dir, command))) {
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

  if (process.platform !== "win32") {
    return { command, args };
  }

  const powershell = powershellForShim();
  if (/\.ps1$/i.test(command)) {
    if (!powershell) return { command, args };
    return {
      command: powershell,
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
    };
  }

  if (!/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }

  const ps1 = command.replace(/\.(?:cmd|bat)$/i, ".ps1");
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


function quoteCmdToken(value: string): string {
  return '"' + value.replace(/([%])/g, "$1$1").replace(/"/g, '""') + '"';
}

/**
 * Prepare a long-lived stdio child on Windows.
 * npm .cmd/.bat shims are routed through cmd.exe instead of the sibling
 * PowerShell shim because PowerShell does not transparently forward a
 * redirected stdin stream to the native grandchild used by Codex app-server.
 */
export function prepareStdioSpawn(command: string, args: string[]): SpawnSpec {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }

  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  const inner = [quoteCmdToken(command), ...args.map(quoteCmdToken)].join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", inner],
  };
}


function codexTarget(platform = process.platform, arch = process.arch): { packageName: string; triple: string; executable: string } | null {
  if (platform === "win32" && arch === "x64") {
    return { packageName: "codex-win32-x64", triple: "x86_64-pc-windows-msvc", executable: "codex.exe" };
  }
  if (platform === "win32" && arch === "arm64") {
    return { packageName: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc", executable: "codex.exe" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { packageName: "codex-darwin-x64", triple: "x86_64-apple-darwin", executable: "codex" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { packageName: "codex-darwin-arm64", triple: "aarch64-apple-darwin", executable: "codex" };
  }
  if ((platform === "linux" || platform === "android") && arch === "x64") {
    return { packageName: "codex-linux-x64", triple: "x86_64-unknown-linux-musl", executable: "codex" };
  }
  if ((platform === "linux" || platform === "android") && arch === "arm64") {
    return { packageName: "codex-linux-arm64", triple: "aarch64-unknown-linux-musl", executable: "codex" };
  }
  return null;
}

export function codexNativeCandidates(
  command: string,
  platform = process.platform,
  arch = process.arch,
): string[] {
  const target = codexTarget(platform, arch);
  if (!target) return [];

  if (
    (platform === "win32" && /codex\.exe$/i.test(command)) ||
    (platform !== "win32" && /(?:^|[\\/])codex$/.test(command))
  ) {
    return [command];
  }

  const roots: string[] = [];
  let current = dirname(command);
  const filesystemRoot = parse(current).root;
  for (let depth = 0; depth < 5; depth += 1) {
    roots.push(current);
    if (current === filesystemRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const candidates = [
      join(
        root,
        "node_modules",
        "@openai",
        target.packageName,
        "vendor",
        target.triple,
        "bin",
        target.executable,
      ),
      join(
        root,
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        target.packageName,
        "vendor",
        target.triple,
        "bin",
        target.executable,
      ),
      join(
        root,
        "node_modules",
        "@openai",
        "codex",
        "vendor",
        target.triple,
        "bin",
        target.executable,
      ),
    ];
    for (const candidate of candidates) {
      const key = platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Resolve the native Codex binary behind the npm launcher when available.
 * This avoids shell/shim process layers for long-lived stdio RPC sessions.
 */
export function resolveCodexNativeExecutable(command: string): string | null {
  const target = codexTarget();
  if (!target) return null;

  // Mirror the official @openai/codex launcher first: create a resolver rooted
  // at @openai/codex and resolve the platform package's package.json.
  let current = dirname(command);
  const filesystemRoot = parse(current).root;
  for (let depth = 0; depth < 5; depth += 1) {
    const codexPackageJson = join(current, "node_modules", "@openai", "codex", "package.json");
    if (existsSync(codexPackageJson)) {
      try {
        const requireFromCodex = createRequire(codexPackageJson);
        const platformPackageJson = requireFromCodex.resolve(`@openai/${target.packageName}/package.json`);
        const candidate = join(
          dirname(platformPackageJson),
          "vendor",
          target.triple,
          "bin",
          target.executable,
        );
        if (runnable(candidate)) return candidate;
      } catch {
        // Fall through to deterministic filesystem candidates below.
      }
    }

    if (current === filesystemRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const candidate of codexNativeCandidates(command)) {
    if (runnable(candidate)) return candidate;
  }
  return null;
}
