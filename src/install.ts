/**
 * `automode install`: point `claude` and `codex` at the mods.
 *
 * Simpler than the Python original needs to be: npm already puts the binary on
 * your PATH, so all that is left is the shell aliases.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import * as configmod from "./core/config.js";
import { describeHotkey } from "./terminal/overlay.js";
import { which } from "./platform/command.js";

const MARKER = "# automode";
const BLOCK = `
${MARKER}: auto continue + auto ping for claude code / codex
alias claude='automode claude'
alias codex='automode codex'
`;


const WINDOWS_START = "# >>> automode windows >>>";
const WINDOWS_END = "# <<< automode windows <<<";
const WINDOWS_BLOCK = `
${WINDOWS_START}
function claude { automode claude @args }
function codex { automode codex @args }
${WINDOWS_END}
`;

function powershell(): string | null {
  return which("pwsh") ?? which("powershell") ?? which("powershell.exe");
}

function powershellProfile(): string | null {
  const shell = powershell();
  if (!shell) return null;
  try {
    const out = execFileSync(
      shell,
      ["-NoLogo", "-NoProfile", "-Command", "$PROFILE.CurrentUserAllHosts"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function installWindowsAliases(): number {
  const profile = powershellProfile();
  if (!profile) {
    console.log("  could not locate a PowerShell profile.");
    console.log("  PowerShell 5.1+ or PowerShell 7 is required for automatic alias installation.");
    return 1;
  }

  let existing = "";
  try {
    existing = readFileSync(profile, "utf8");
  } catch {
    // No profile yet.
  }

  if (existing.includes(WINDOWS_START)) {
    console.log(`  PowerShell functions already installed in ${profile}`);
  } else {
    try {
      mkdirSync(dirname(profile), { recursive: true });
      appendFileSync(profile, WINDOWS_BLOCK, "utf8");
    } catch (error) {
      console.log(`  could not write ${profile}: ${error}`);
      return 1;
    }
    console.log(`  PowerShell functions added to ${profile}`);
  }

  console.log("\n  NOTE: open PowerShell windows do not have these functions yet.");
  console.log("  Open a new PowerShell window, or reload the profile with:");
  console.log("    . $PROFILE");
  console.log("\nThen:");
  const hotkey = describeHotkey(String(configmod.load().hotkey ?? "ctrl+g"));
  console.log("  claude           the agent, with the mods");
  console.log("  codex            the agent, with the mods");
  console.log(`  ${hotkey.padEnd(16)} the menu, from inside a session`);
  console.log("  automode menu    the same settings menu, from outside");
  return 0;
}

function uninstallWindowsAliases(): number {
  const profile = powershellProfile();
  if (!profile) {
    console.log("  could not locate a PowerShell profile.");
    return 1;
  }

  try {
    const text = readFileSync(profile, "utf8");
    const start = text.indexOf(WINDOWS_START);
    const end = text.indexOf(WINDOWS_END, start);
    if (start < 0 || end < 0) {
      console.log(`  no automode block found in ${profile}`);
      return 0;
    }
    const after = end + WINDOWS_END.length;
    const cleaned = (text.slice(0, start) + text.slice(after)).replace(/^\s*\r?\n/, "");
    writeFileSync(profile, cleaned, "utf8");
    console.log(`  PowerShell functions removed from ${profile}`);
    return 0;
  } catch {
    console.log(`  could not read ${profile}`);
    return 1;
  }
}

/** The rc file for the user's shell, or null if we do not know it. */
export function shellRc(shell = process.env.SHELL ?? ""): string | null {
  const home = homedir();
  if (shell.includes("zsh")) return join(home, ".zshrc");
  if (shell.includes("bash")) return join(home, ".bashrc");
  if (shell.includes("fish")) return join(home, ".config", "fish", "config.fish");
  return null;
}

export function installAliases(): number {
  console.log("automode install\n");

  const binary = which("automode");
  if (binary) console.log(`  automode found at ${binary}`);
  else {
    console.log("  WARNING: `automode` is not on your PATH.");
    console.log("  Install it globally first:  npm install -g automode");
  }

  if (process.platform === "win32") return installWindowsAliases();

  const rc = shellRc();
  if (!rc) {
    console.log("\n  Unknown shell. Add these lines yourself:");
    console.log(BLOCK);
    return 1;
  }

  let existing = "";
  try {
    existing = readFileSync(rc, "utf8");
  } catch {
    // No rc yet; we are about to make one.
  }

  if (existing.includes("alias claude='automode claude'")) {
    console.log(`  aliases already in ${rc}`);
  } else {
    try {
      appendFileSync(rc, BLOCK, "utf8");
    } catch (error) {
      console.log(`  could not write ${rc}: ${error}`);
      return 1;
    }
    console.log(`  aliases added to ${rc}`);
  }

  // Aliases live in the shell, not in the file: a terminal that is already open
  // kept whatever it read at startup and will not pick these up.
  console.log("\n  NOTE: your open terminals do not have these yet.");
  console.log(`  Run \`source ${rc}\` in each, or just open a new one.\n`);
  console.log("Then:");
  const hotkey = describeHotkey(String(configmod.load().hotkey ?? "ctrl+g"));
  for (const [key, what] of [
    ["claude", "the agent, with the mods"],
    ["\\claude", "the agent, bare (the backslash skips the alias)"],
    [hotkey, "the menu, from inside a session"],
  ]) {
    console.log(`  ${key!.padEnd(16)} ${what}`);
  }
  return 0;
}

export function uninstallAliases(): number {
  console.log("automode uninstall\n");
  if (process.platform === "win32") {
    const code = uninstallWindowsAliases();
    console.log("\nThe config stays put.");
    console.log("Scheduled pings are separate: automode schedule uninstall");
    return code;
  }

  const rc = shellRc();
  if (rc) {
    try {
      const lines = readFileSync(rc, "utf8").split("\n");
      const kept = lines.filter(
        (line) =>
          !line.startsWith(MARKER) &&
          line.trim() !== "alias claude='automode claude'" &&
          line.trim() !== "alias codex='automode codex'",
      );
      if (kept.length !== lines.length) {
        writeFileSync(rc, kept.join("\n"), "utf8");
        console.log(`  aliases removed from ${rc}`);
      } else console.log(`  no aliases found in ${rc}`);
    } catch {
      console.log(`  could not read ${rc}`);
    }
  }
  console.log("\nThe config stays put. Delete it with:");
  console.log("  rm -rf ~/.config/automode ~/.local/state/automode");
  console.log("Scheduled pings are separate: automode schedule uninstall");
  return 0;
}
