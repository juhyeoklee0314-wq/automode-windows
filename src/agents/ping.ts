/**
 * Headless pings and the launchd agent that fires them.
 *
 * The in-session ping needs a session. This is the version that works while
 * you are asleep and the terminal is closed: a one-shot prompt that opens the
 * usage window and exits.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { logPath, stateDir } from "../core/config.js";
import type { Config } from "../core/config.js";
import type { Logger } from "../core/log.js";
import { parseHhmm } from "../core/timeutil.js";
import { prepareSpawn, which } from "../platform/command.js";

export { which } from "../platform/command.js";

const run = promisify(execFile);

export const LABEL = "com.automode.ping";
export const AGENTS = ["claude", "codex"] as const;
const PING_TIMEOUT_MS = 300_000;

export function headlessArgv(agent: string, message: string): string[] {
  if (agent === "claude") return ["claude", "-p", message];
  if (agent === "codex") return ["codex", "exec", message];
  throw new Error(`unknown agent: ${agent}`);
}

/** Send one message to the agent, non-interactively. */
export async function pingOnce(agent: string, message: string, log?: Logger): Promise<number> {
  const [command, ...args] = headlessArgv(agent, message);
  const resolved = which(command!);
  if (!resolved) {
    log?.(`ping: ${command} not found on PATH`);
    return 127;
  }
  const spawn = prepareSpawn([resolved, ...args]);
  try {
    const { stdout, stderr } = await run(spawn.command, spawn.args, { timeout: PING_TIMEOUT_MS });
    const reply = (stdout || stderr || "").trim().replace(/\n/g, " ").slice(0, 200);
    log?.(`ping ${agent} ${JSON.stringify(message)} -> rc=0 ${JSON.stringify(reply)}`);
    return 0;
  } catch (error) {
    const code = (error as { code?: number }).code ?? 1;
    log?.(`ping ${agent}: failed (${code})`);
    return typeof code === "number" ? code : 1;
  }
}

export const plistPath = (): string =>
  join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

/** A PATH that finds the agents. launchd starts with almost nothing. */
function launchdPath(): string {
  const parts: string[] = [];
  for (const name of AGENTS) {
    const found = which(name);
    if (found) {
      const parent = dirname(found);
      if (!parts.includes(parent)) parts.push(parent);
    }
  }
  // node itself has to be findable: the agents are node programs.
  const nodeDir = dirname(process.execPath);
  if (!parts.includes(nodeDir)) parts.push(nodeDir);
  for (const fallback of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
    if (!parts.includes(fallback)) parts.push(fallback);
  }
  return parts.join(":");
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

export function buildPlist(times: string[], agent: string, message: string): string {
  const intervals = times
    .map((entry) => parseHhmm(String(entry)))
    .filter((p): p is [number, number] => p !== null);
  if (!intervals.length) throw new Error("no valid times configured");

  // Prefer the installed binary; fall back to this very script, so a clone
  // that was never `npm install -g`'d still schedules something that runs.
  const binary = which("automode");
  const argv = binary
    ? [binary, "ping", "--agent", agent, "--message", message]
    : [process.execPath, process.argv[1]!, "ping", "--agent", agent, "--message", message];

  const out = join(stateDir(), "launchd.log");
  const calendar = intervals
    .map(
      ([h, m]) =>
        `    <dict><key>Hour</key><integer>${h}</integer>` +
        `<key>Minute</key><integer>${m}</integer></dict>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n")}
  </array>
  <key>StartCalendarInterval</key>
  <array>
${calendar}
  </array>
  <key>RunAtLoad</key><false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(launchdPath())}</string>
    <key>HOME</key><string>${escapeXml(homedir())}</string>
  </dict>
  <key>StandardOutPath</key><string>${escapeXml(out)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(out)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): { ok: boolean; err: string } {
  try {
    execFileSync("launchctl", args, { stdio: "pipe" });
    return { ok: true, err: "" };
  } catch (error) {
    return { ok: false, err: String((error as { stderr?: Buffer }).stderr ?? error) };
  }
}

/** Wake the Mac a couple of minutes before the first ping of the day. */
export function earliest(times: string[]): string | null {
  const parsed = times
    .map((t) => parseHhmm(String(t)))
    .filter((p): p is [number, number] => p !== null)
    .map(([h, m]) => h * 60 + m);
  if (!parsed.length) return null;
  const total = Math.max(Math.min(...parsed) - 2, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}:00`;
}

export function install(config: Config): number {
  const { times = [], agent = "claude", message = "hi" } = config.ping ?? {};
  if (process.platform !== "darwin") {
    console.log("automode: launchd scheduling is macOS only.");
    return 1;
  }
  let plist: string;
  try {
    plist = buildPlist(times, agent, message);
  } catch (error) {
    console.log(`automode: ${(error as Error).message}`);
    return 1;
  }

  const path = plistPath();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(path, plist, "utf8");

  const target = `gui/${process.getuid?.() ?? 501}`;
  launchctl(["bootout", `${target}/${LABEL}`]); // ignore if it was not loaded
  if (!launchctl(["bootstrap", target, path]).ok) {
    const legacy = launchctl(["load", "-w", path]);
    if (!legacy.ok) {
      console.log(`automode: launchctl failed: ${legacy.err}`);
      return 1;
    }
  }

  console.log(`automode: scheduled. plist at ${path}`);
  console.log(`  agent:    ${agent}`);
  console.log(`  message:  ${JSON.stringify(message)}`);
  console.log(`  times:    ${times.join(", ")}`);
  console.log(`  log:      ${join(stateDir(), "launchd.log")}`);
  console.log();
  console.log("IMPORTANT: launchd does not wake the Mac. If it is asleep at the");
  console.log("scheduled time the ping only fires once it wakes, which defeats the");
  console.log("point. Schedule the wake too (needs sudo, run it yourself):");
  console.log();
  const wake = earliest(times);
  if (wake) console.log(`  sudo pmset repeat wakeorpoweron MTWRFSU ${wake}`);
  console.log();
  return 0;
}

export function uninstall(): number {
  const path = plistPath();
  launchctl(["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
  launchctl(["unload", path]);
  if (existsSync(path)) {
    unlinkSync(path);
    console.log(`automode: removed ${path}`);
  } else console.log("automode: nothing was scheduled");
  console.log("If you scheduled a wake, undo it with: sudo pmset repeat cancel");
  return 0;
}

export function status(): number {
  const path = plistPath();
  if (!existsSync(path)) {
    console.log("launchd:  not installed (use `automode schedule install`)");
    return 0;
  }
  const loaded = launchctl(["list", LABEL]).ok ? "loaded" : "NOT loaded";
  console.log(`launchd:  ${loaded} (${path})`);
  console.log(`          log: ${join(stateDir(), "launchd.log")}`);
  console.log("          system wake: pmset repeat (see `pmset -g sched`)");
  console.log(`          automode log: ${logPath()}`);
  return 0;
}
