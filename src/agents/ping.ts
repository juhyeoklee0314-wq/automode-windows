/**
 * Headless pings and the launchd agent that fires them.
 *
 * The in-session ping needs a session. This is the version that works while
 * you are asleep and the terminal is closed: a one-shot prompt that opens the
 * usage window and exits.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { logPath, stateDir } from "../core/config.js";
import type { Config } from "../core/config.js";
import type { Logger } from "../core/log.js";
import { redactSecrets } from "../core/redact.js";
import { parseHhmm } from "../core/timeutil.js";
import { prepareSpawn, which } from "../platform/command.js";

export { which } from "../platform/command.js";

export const LABEL = "com.automode.ping";
export const AGENTS = ["claude", "codex"] as const;
const PING_TIMEOUT_MS = 300_000;
const PING_STDERR_BUFFER_CHARS = 16_384;
const PING_STDERR_LOG_CHARS = 4_096;
const WINDOWS_TASK_PREFIX = "Automode Ping";

export function headlessArgv(agent: string, message: string): string[] {
  if (agent === "claude") return ["claude", "-p", message];
  if (agent === "codex") return ["codex", "exec", "--skip-git-repo-check", "--ephemeral", message];
  throw new Error(`unknown agent: ${agent}`);
}

/** Send one message to the agent, non-interactively. */
export interface PingOnceOptions {
  env?: NodeJS.ProcessEnv;
  unsetEnv?: string[];
  onResolved?: (path: string) => void;
}

export function buildPingEnvironment(overrides?: NodeJS.ProcessEnv, unset: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(overrides ?? {}) };
  for (const key of unset) delete env[key];
  return env;
}

export function pingDiagnosticTail(value: string, maxChars = PING_STDERR_LOG_CHARS): string {
  const clean = redactSecrets(value)
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\r\n]+/g, " | ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  const limit = Math.max(256, Math.min(maxChars, PING_STDERR_LOG_CHARS));
  return clean.length <= limit ? clean : `…${clean.slice(-limit)}`;
}

export async function pingOnce(agent: string, message: string, log?: Logger, options: PingOnceOptions = {}): Promise<number> {
  const [command, ...args] = headlessArgv(agent, message);
  const resolved = which(command!);
  if (!resolved) {
    log?.(`ping: ${command} not found on PATH`);
    return 127;
  }
  options.onResolved?.(resolved);
  const spawn = prepareSpawn([resolved, ...args]);
  return runPingProcess(spawn.command, spawn.args, agent, log, options.env, options.unsetEnv);
}

function runPingProcess(command: string, args: string[], agent: string, log?: Logger, env?: NodeJS.ProcessEnv, unsetEnv: string[] = []): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: buildPingEnvironment(env, unsetEnv) });
    let settled = false;
    let stderrTail = "";
    child.stdout?.resume();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderrTail = (stderrTail + String(chunk)).slice(-PING_STDERR_BUFFER_CHARS);
    });
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        log?.(`ping ${agent} -> rc=0`);
      } else {
        log?.(`ping ${agent}: failed (${code})`);
        const diagnostic = pingDiagnosticTail(stderrTail);
        if (diagnostic) log?.(`ping ${agent}: stderr: ${diagnostic}`);
      }
      resolve(code);
    };
    const timer = setTimeout(() => {
      if (child.pid && process.platform === "win32") {
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(124);
    }, PING_TIMEOUT_MS);
    timer.unref();
    child.once("error", (error) => {
      log?.(`ping ${agent}: spawn failed (${String((error as NodeJS.ErrnoException).code ?? error)})`);
      finish(127);
    });
    child.once("close", (code, signal) => finish(signal ? 128 : (code ?? 1)));
  });
}


interface WindowsScheduleReceipt {
  tasks: string[];
}

const windowsReceiptPath = (): string => join(stateDir(), "windows-schedule.json");

function windowsTaskName(time: string): string {
  return `${WINDOWS_TASK_PREFIX} ${time.replace(":", "")}`;
}

function windowsTaskCommand(): string {
  const script = process.argv[1];
  if (!script) throw new Error("cannot determine automode CLI path");
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
  return `${quote(process.execPath)} ${quote(script)} ping`;
}

function schtasks(args: string[]): { ok: boolean; err: string } {
  try {
    execFileSync("schtasks.exe", args, { stdio: "pipe" });
    return { ok: true, err: "" };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr;
    return { ok: false, err: String(stderr ?? error).trim() };
  }
}

function readWindowsReceipt(): WindowsScheduleReceipt {
  try {
    const raw = JSON.parse(readFileSync(windowsReceiptPath(), "utf8")) as Partial<WindowsScheduleReceipt>;
    return { tasks: Array.isArray(raw.tasks) ? raw.tasks.map(String) : [] };
  } catch {
    return { tasks: [] };
  }
}

function removeWindowsTasks(tasks: string[]): void {
  for (const task of tasks) schtasks(["/Delete", "/TN", task, "/F"]);
}

function installWindows(config: Config): number {
  const times = (config.ping?.times ?? [])
    .map((entry) => String(entry))
    .filter((entry) => parseHhmm(entry) !== null);
  if (!times.length) {
    console.log("automode: no valid ping times configured.");
    return 1;
  }

  const old = readWindowsReceipt();
  removeWindowsTasks(old.tasks);

  const command = windowsTaskCommand();
  const created: string[] = [];
  for (const time of times) {
    const task = windowsTaskName(time);
    const result = schtasks([
      "/Create",
      "/F",
      "/SC",
      "DAILY",
      "/ST",
      time,
      "/TN",
      task,
      "/TR",
      command,
      "/IT",
    ]);
    if (!result.ok) {
      removeWindowsTasks(created);
      console.log(`automode: Task Scheduler failed for ${time}: ${result.err}`);
      return 1;
    }
    created.push(task);
  }

  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(windowsReceiptPath(), JSON.stringify({ tasks: created }, null, 2), "utf8");

  console.log("automode: scheduled with Windows Task Scheduler.");
  console.log(`  times:    ${times.join(", ")}`);
  console.log(`  action:   ${command}`);
  console.log(`  receipt:  ${windowsReceiptPath()}`);
  console.log();
  console.log("NOTE: these tasks run only while your Windows user is logged on.");
  console.log("Task Scheduler wake-from-sleep is not enabled by this command.");
  return 0;
}

function uninstallWindows(): number {
  const receipt = readWindowsReceipt();
  removeWindowsTasks(receipt.tasks);
  if (existsSync(windowsReceiptPath())) unlinkSync(windowsReceiptPath());
  if (receipt.tasks.length) console.log(`automode: removed ${receipt.tasks.length} Windows scheduled task(s)`);
  else console.log("automode: no recorded Windows scheduled tasks");
  return 0;
}

function statusWindows(): number {
  const receipt = readWindowsReceipt();
  if (!receipt.tasks.length) {
    console.log("Task Scheduler: not installed (use `automode schedule install`)");
    return 0;
  }
  console.log("Task Scheduler:");
  for (const task of receipt.tasks) {
    const result = schtasks(["/Query", "/TN", task]);
    console.log(`  ${result.ok ? "installed" : "MISSING "}  ${task}`);
  }
  console.log(`  receipt: ${windowsReceiptPath()}`);
  console.log(`  automode log: ${logPath()}`);
  return 0;
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
  if (process.platform === "win32") return installWindows(config);

  const { times = [], agent = "claude", message = "hi" } = config.ping ?? {};
  if (process.platform !== "darwin") {
    console.log("automode: built-in scheduling supports macOS and Windows; use cron/systemd on Linux.");
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
  if (process.platform === "win32") return uninstallWindows();

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
  if (process.platform === "win32") return statusWindows();

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
