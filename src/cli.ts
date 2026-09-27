#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Dispatch is by hand rather than a parser library: `automode claude -p "hi"
 * --model x` has to hand every flag to claude untouched, and any parser would
 * claim them.
 */

import { execFileSync } from "node:child_process";

import * as detect from "./agents/detect.js";
import * as dialogs from "./agents/dialogs.js";
import * as pingmod from "./agents/ping.js";
import { Controller } from "./controller.js";
import * as configmod from "./core/config.js";
import { setLanguage, t } from "./core/i18n.js";
import { createLogger } from "./core/log.js";
import { State } from "./core/state.js";
import { formatInZone, nextOccurrence, parseHhmm, resolveTz } from "./core/timeutil.js";
import { installAliases, uninstallAliases } from "./install.js";
import { runStandalone } from "./terminal/standalone.js";
import { terminalSize } from "./terminal/menu.js";
import * as overlaymod from "./terminal/overlay.js";
import { MAX_DEPTH, run as ptyRun, sessionDepth } from "./terminal/runner.js";

const VERSION = "0.1.0";
const WRAPPABLE = ["claude", "codex"];

const USAGE = `automode {version}: {tagline}

  automode claude [args...]     run claude with the mods (args pass through)
  automode codex  [args...]     same for codex
  automode -- <cmd> [args...]   wrap any other command

  automode install              install the \`claude\` and \`codex\` aliases
  automode menu                 open the settings menu
  automode status               show settings and what is scheduled
  automode doctor               check the detector against known limit messages
  automode ping                 send the ping now, with no session open
  automode schedule install     schedule configured pings for this platform
  automode schedule uninstall   remove the schedule
  automode uninstall            remove the aliases

{hotkeyLine}
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  setLanguage(String(configmod.load().language ?? "en"));

  if (!argv.length || ["-h", "--help", "help"].includes(argv[0]!)) return usage();
  if (["-V", "--version", "version"].includes(argv[0]!)) {
    console.log(`automode ${VERSION}`);
    return 0;
  }

  const [command, ...rest] = argv;
  if (WRAPPABLE.includes(command!)) return wrap([command!, ...rest]);
  if (command === "--") return rest.length ? wrap(rest) : usage(1);
  if (command === "install") return installAliases();
  if (command === "uninstall") return uninstallAliases();
  if (command === "menu" || command === "config") return runStandalone();
  if (command === "status") return status();
  if (command === "doctor") return doctor();
  if (command === "ping") return ping(rest);
  if (command === "schedule") return schedule(rest);

  process.stderr.write(`${t("cli.unknown_command", { command: command! })}\n\n`);
  return usage(1);
}

function usage(code = 0): number {
  const hotkey = overlaymod.describeHotkey(String(configmod.load().hotkey ?? "ctrl+g"));
  const text = USAGE.replace("{version}", VERSION)
    .replace("{tagline}", t("cli.tagline"))
    .replace("{hotkeyLine}", t("cli.hotkey_line", { hotkey }));
  (code ? process.stderr : process.stdout).write(text);
  return code;
}

async function wrap(argv: string[]): Promise<number> {
  if (sessionDepth() >= MAX_DEPTH) {
    // Something is calling us in a loop: a shell function or a script named
    // `claude` that invokes automode again. Run the agent bare and stop.
    try {
      execFileSync(argv[0]!, argv.slice(1), { stdio: "inherit" });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  }

  const binary = pingmod.which(argv[0]!);
  if (!binary) {
    process.stderr.write(`automode: '${argv[0]}' is not on your PATH\n`);
    return 127;
  }

  const config = configmod.load();
  const log = createLogger();
  log(`session: ${argv.join(" ")}`);
  const controller = new Controller(config, log, new State());
  const overlay = overlaymod.build(config, argv[0], terminalSize());
  if (!overlay) log(`hotkey ${JSON.stringify(config.hotkey)} is unusable, menu off this session`);
  return ptyRun([binary, ...argv.slice(1)], controller, overlay);
}

const onOff = (value: unknown): string => (value ? "on" : "off");

function status(): number {
  const config = configmod.load();
  const tz = resolveTz(config.timezone || null);
  const now = new Date();
  const hotkey = overlaymod.describeHotkey(String(config.hotkey ?? "ctrl+g"));

  console.log(`automode ${VERSION}`);
  console.log(`config:   ${configmod.configPath()}`);
  console.log(`log:      ${configmod.logPath()}`);
  console.log(`timezone: ${config.timezone || tz}  (now ${formatInZone(now, tz)})`);
  console.log();
  console.log(`auto continue: ${onOff(config.auto_continue)}`);
  console.log(`  message:     ${JSON.stringify(config.continue_message)}`);
  console.log(`  wait:        ${config.grace_seconds}s past the reset`);
  console.log(`  limit menu:  ${onOff(config.answer_limit_prompt)}`);
  console.log(`  menu hotkey: ${hotkey}`);
  console.log();

  const ping = config.ping;
  console.log(`auto ping ${JSON.stringify(ping.message)}: ${onOff(ping.enabled)}`);
  const state = new State();
  for (const entry of ping.times) {
    const parsed = parseHhmm(String(entry));
    if (!parsed) {
      console.log(`  ${entry}  (invalid)`);
      continue;
    }
    const target = nextOccurrence(now, parsed[0], parsed[1], tz);
    const minutes = Math.floor((target.getTime() - now.getTime()) / 60_000);
    const stamp = formatInZone(now, tz, true);
    const key = `${stamp.slice(3, 5)}-${stamp.slice(0, 2)} ${entry}`;
    const done = state.pingFired(key) ? " (already sent today)" : "";
    console.log(
      `  ${entry}  next in ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}min${done}`,
    );
  }
  console.log();
  return pingmod.status();
}

function doctor(): number {
  const config = configmod.load();
  const tz = resolveTz(config.timezone || null);
  const now = new Date();
  let failures = 0;

  console.log(`now: ${formatInZone(now, tz, true)} (${tz})\n`);
  console.log("limit messages:");
  for (const sample of detect.SAMPLES) {
    const hit = detect.scan(detect.normalize(sample), now, tz);
    const short = sample.length <= 66 ? sample : `${sample.slice(0, 63)}...`;
    if (!hit) {
      failures += 1;
      console.log(`  NOT RECOGNISED  ${short}`);
      continue;
    }
    const mark = detect.plausible(hit.resetAt, now) ? "ok " : "???";
    console.log(`  ${mark} ${formatInZone(hit.resetAt, tz, true)}  [${hit.kind}]  ${short}`);
  }

  console.log("\nblocking menus:");
  for (const sample of dialogs.SAMPLES) {
    const answer = dialogs.find(detect.normalize(sample.text));
    if (!answer || answer.key !== sample.key) {
      failures += 1;
      console.log(`  NOT RECOGNISED  ${sample.name}`);
    } else console.log(`  ok  ${sample.name} -> picks option ${answer.key}`);
  }

  console.log("\nagents:");
  for (const name of WRAPPABLE) {
    console.log(`  ${name}: ${pingmod.which(name) ?? "not on PATH"}`);
  }

  const hotkeys = overlaymod.parseHotkeys(String(config.hotkey ?? "ctrl+g"));
  console.log(`\nhotkey: ${JSON.stringify(config.hotkey)} -> ${hotkeys.map((k) => JSON.stringify(k.toString("binary")))}`);
  if (!hotkeys.length) {
    failures += 1;
    console.log("  unusable, the menu will not open");
  }

  if (process.platform === "win32") {
    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    console.log("\nwindows runtime:");
    if (nodeMajor >= 22) {
      failures += 1;
      console.log(`  WARNING: Node ${process.versions.node} is not a known-good Windows PTY runtime.`);
      console.log("  automode-windows currently validates interactive ConPTY sessions on Node 20.");
      console.log("  Windows + Node 22 fails PTY overlay tests in CI with node-pty 1.1.0.");
    } else {
      console.log(`  ok  Node ${process.versions.node}: full PTY overlay suite passes on the current Windows baseline.`);
      console.log("  note: node-pty 1.1.0 may still print an AttachConsole warning during PTY teardown.");
    }
  }

  const depth = sessionDepth();
  if (depth) console.log(`\nnote: already inside ${depth} automode session(s)`);
  return failures ? 1 : 0;
}

async function ping(args: string[]): Promise<number> {
  const config = configmod.load();
  let agent = config.ping.agent;
  let message = config.ping.message;

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if ((flag === "--agent" || flag === "--message") && value !== undefined) {
      if (flag === "--agent") agent = value;
      else message = value;
    } else {
      process.stderr.write(`automode ping: bad argument: ${flag}\n`);
      return 2;
    }
  }

  if (!(pingmod.AGENTS as readonly string[]).includes(agent)) {
    process.stderr.write(`automode ping: unknown agent: ${agent}\n`);
    return 2;
  }

  const code = await pingmod.pingOnce(agent, message, createLogger());
  if (code === 0) console.log(`automode: sent ${JSON.stringify(message)} to ${agent}. Window is open.`);
  else console.log(`automode: ping failed (rc=${code}); see ${configmod.logPath()}`);
  return code;
}

function schedule(args: string[]): number {
  const action = args[0] ?? "status";
  if (action === "install") return pingmod.install(configmod.load());
  if (action === "uninstall" || action === "remove") return pingmod.uninstall();
  if (action === "status") return pingmod.status();
  process.stderr.write("automode schedule: use install | uninstall | status\n");
  return 2;
}

main().then((code) => {
  process.exitCode = code;
});
