import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

import { prepareSpawn, which } from "../platform/command.js";
import type { AccountAuthStatus, AccountProfile } from "./types.js";

const STATUS_TIMEOUT_MS = 12_000;
const MAX_CAPTURE = 64 * 1024;

function accountEnv(account: AccountProfile): NodeJS.ProcessEnv {
  if (!account.codexHome) return process.env;
  return { ...process.env, CODEX_HOME: account.codexHome };
}

function baseStatus(account: AccountProfile, state: AccountAuthStatus["state"], detail: string): AccountAuthStatus {
  return { accountId: account.id, state, detail };
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  }
}

async function runStatus(command: string, account: AccountProfile): Promise<number> {
  const prepared = prepareSpawn([command, "login", "status"]);
  return await new Promise<number>((resolve) => {
    const child = spawn(prepared.command, prepared.args, {
      windowsHide: true,
      env: accountEnv(account),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let captured = 0;
    const consume = (chunk: Buffer) => {
      captured += chunk.length;
      if (captured > MAX_CAPTURE) killTree(child.pid);
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(124);
    }, STATUS_TIMEOUT_MS);
    timer.unref();
    child.once("error", () => finish(127));
    child.once("close", (code, signal) => finish(signal ? 128 : (code ?? 1)));
  });
}

export async function codexAuthStatus(account: AccountProfile): Promise<AccountAuthStatus> {
  if (account.agent !== "codex") {
    return baseStatus(account, "not_codex", "Account uses Claude; Codex login is not required.");
  }
  const resolved = which("codex");
  if (!resolved) return baseStatus(account, "cli_missing", "Codex CLI was not found on PATH.");
  const code = await runStatus(resolved, account);
  return code === 0
    ? baseStatus(account, "connected", "ChatGPT login is active for this profile.")
    : baseStatus(account, "not_connected", "This profile is not connected to ChatGPT.");
}

export function startCodexLogin(account: AccountProfile): AccountAuthStatus {
  if (account.agent !== "codex") {
    return baseStatus(account, "not_codex", "Switch this profile to Codex before connecting a ChatGPT account.");
  }
  const resolved = which("codex");
  if (!resolved) return baseStatus(account, "cli_missing", "Codex CLI was not found on PATH.");
  if (account.codexHome) mkdirSync(account.codexHome, { recursive: true });
  try {
    const prepared = prepareSpawn([resolved, "login"]);
    const child = spawn(prepared.command, prepared.args, {
      detached: true,
      windowsHide: true,
      env: accountEnv(account),
      stdio: "ignore",
    });
    child.unref();
    return baseStatus(account, "login_started", "Codex login started. Complete the account selection in your browser.");
  } catch {
    return baseStatus(account, "not_connected", "Codex login could not be started.");
  }
}
