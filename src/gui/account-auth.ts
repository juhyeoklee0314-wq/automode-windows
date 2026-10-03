import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

import { prepareSpawn, prepareStdioSpawn, resolveCodexNativeExecutable, which } from "../platform/command.js";
import type { AccountAuthStatus, AccountProfile } from "./types.js";

const STATUS_TIMEOUT_MS = 12_000;
const IDENTITY_TIMEOUT_MS = 10_000;
const LOGIN_PROMPT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE = 64 * 1024;

const activeLoginProcesses = new Map<string, ReturnType<typeof spawn>>();
const activeLoginPrompts = new Map<string, CodexDeviceLoginPrompt>();

interface StatusResult { code: number; output: string }

export interface CodexAccountIdentity {
  email: string | null;
  planType: string | null;
}

export interface CodexProviderIdentity extends CodexAccountIdentity {
  providerAccountId: string | null;
}

export interface CodexDeviceLoginPrompt {
  loginUrl: string;
  loginCode: string;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function parseCodexDeviceLoginPrompt(output: string): CodexDeviceLoginPrompt | null {
  const clean = stripAnsi(output);
  const urlMatch = clean.match(/https:\/\/[^\s]+\/codex\/device\b/i);
  const codeMatch = clean.match(/Enter this one-time code[\s\S]{0,240}?\n\s*([A-Z0-9-]{4,32})\b/i);
  if (!urlMatch || !codeMatch) return null;
  return { loginUrl: urlMatch[0]!, loginCode: codeMatch[1]! };
}

export function deviceLoginPendingStatus(accountId: string, prompt: CodexDeviceLoginPrompt): AccountAuthStatus {
  return {
    accountId,
    state: "login_started",
    detail: "Device login is waiting for authorization.",
    loginUrl: prompt.loginUrl,
    loginCode: prompt.loginCode,
  };
}

function accountEnv(account: AccountProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (account.codexHome) {
    env.CODEX_HOME = account.codexHome;
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;
  }
  return env;
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

export function parseCodexAccountIdentity(result: unknown): CodexAccountIdentity | null {
  if (!result || typeof result !== "object") return null;
  const account = (result as Record<string, unknown>).account;
  if (!account || typeof account !== "object") return null;
  const record = account as Record<string, unknown>;
  if (record.type !== "chatgpt") return null;

  const rawEmail = typeof record.email === "string" ? record.email.trim() : "";
  const rawPlan = typeof record.planType === "string" ? record.planType.trim() : "";
  return {
    email: rawEmail || null,
    planType: rawPlan || null,
  };
}

export function classifyCodexLoginStatus(accountId: string, code: number, output: string): AccountAuthStatus {
  if (code !== 0) return { accountId, state: "not_connected", detail: "This profile is not connected to ChatGPT." };
  if (/Logged in using ChatGPT/i.test(output)) {
    return { accountId, state: "connected", detail: "ChatGPT login is active for this profile." };
  }
  return {
    accountId,
    state: "wrong_auth",
    detail: "Codex is authenticated, but not with ChatGPT. Reconnect this profile using ChatGPT.",
  };
}

async function runStatus(command: string, account: AccountProfile): Promise<StatusResult> {
  const prepared = prepareSpawn([command, "login", "status"]);
  return await new Promise<StatusResult>((resolve) => {
    const child = spawn(prepared.command, prepared.args, {
      windowsHide: true,
      env: accountEnv(account),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let captured = 0;
    let output = "";
    const consume = (chunk: Buffer) => {
      captured += chunk.length;
      if (captured <= MAX_CAPTURE) output += chunk.toString("utf8");
      else killTree(child.pid);
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
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

export async function readCodexProviderIdentity(command: string, account: AccountProfile): Promise<CodexProviderIdentity | null> {
  const native = resolveCodexNativeExecutable(command);
  const prepared = native
    ? { command: native, args: ["app-server", "--listen", "stdio://"] }
    : prepareStdioSpawn(command, ["app-server", "--listen", "stdio://"]);
  return await new Promise<CodexProviderIdentity | null>((resolve) => {
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    let stdoutBuffer = "";
    let captured = 0;
    let baseIdentity: CodexAccountIdentity | null = null;

    const finish = (identity: CodexProviderIdentity | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child?.stdin?.end(); } catch { /* already closed */ }
      killTree(child?.pid);
      resolve(identity);
    };

    const send = (payload: Record<string, unknown>) => {
      try {
        child?.stdin?.write(JSON.stringify(payload) + "\n");
      } catch {
        finish(null);
      }
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let message: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object") return;
        message = parsed as Record<string, unknown>;
      } catch {
        return;
      }

      if (message.method && message.id !== undefined) {
        send({ id: message.id, result: {} });
        return;
      }

      if (message.id === "pinggpt-init") {
        if (message.error) return finish(null);
        send({ method: "initialized" });
        send({
          id: "pinggpt-account",
          method: "account/read",
          params: { refreshToken: false },
        });
        return;
      }

      if (message.id === "pinggpt-account") {
        if (message.error) return finish(null);
        baseIdentity = parseCodexAccountIdentity(message.result);
        if (!baseIdentity) return finish(null);
        send({
          id: "pinggpt-account-limits",
          method: "account/rateLimits/read",
          params: { excludeResetCreditDetails: true },
        });
        return;
      }

      if (message.id === "pinggpt-account-limits") {
        if (!baseIdentity) return finish(null);
        const result = message.result && typeof message.result === "object"
          ? message.result as Record<string, unknown>
          : null;
        const rawAccountId = typeof result?.accountId === "string" ? result.accountId.trim() : "";
        return finish({
          ...baseIdentity,
          providerAccountId: rawAccountId || null,
        });
      }
    };

    try {
      child = spawn(prepared.command, prepared.args, {
        windowsHide: true,
        env: accountEnv(account),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return finish(null);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      captured += chunk.length;
      if (captured > MAX_CAPTURE) return finish(null);
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
        if (settled) return;
        newline = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      captured += chunk.length;
      if (captured > MAX_CAPTURE) finish(null);
    });

    child.once("error", () => finish(null));
    child.once("close", () => finish(null));
    child.once("spawn", () => {
      send({
        id: "pinggpt-init",
        method: "initialize",
        params: {
          clientInfo: {
            name: "pinggpt",
            title: "PingGPT",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: false,
          },
        },
      });
    });

    timer = setTimeout(() => finish(null), IDENTITY_TIMEOUT_MS);
    timer?.unref();
  });
}

export async function codexAuthStatus(account: AccountProfile): Promise<AccountAuthStatus> {
  if (account.agent !== "codex") {
    return baseStatus(account, "not_codex", "Account uses Claude; Codex login is not required.");
  }

  const pendingProcess = activeLoginProcesses.get(account.id);
  const pendingPrompt = activeLoginPrompts.get(account.id);
  if (pendingProcess && pendingPrompt && pendingProcess.exitCode === null) {
    return deviceLoginPendingStatus(account.id, pendingPrompt);
  }

  const resolved = which("codex");
  if (!resolved) return baseStatus(account, "cli_missing", "Codex CLI was not found on PATH.");

  const result = await runStatus(resolved, account);
  const status = classifyCodexLoginStatus(account.id, result.code, result.output);
  if (status.state !== "connected") return status;

  const identity = await readCodexProviderIdentity(resolved, account);
  if (!identity) {
    return {
      ...status,
      identityVerified: false,
      detail: "ChatGPT login is active, but Codex did not expose the account identity.",
    };
  }

  return {
    ...status,
    email: identity.email,
    planType: identity.planType,
    identityVerified: identity.providerAccountId !== null,
    detail: identity.email
      ? `Connected as ${identity.email}.`
      : "ChatGPT login is active; Codex did not provide an email address.",
  };
}

export async function startCodexLogin(account: AccountProfile): Promise<AccountAuthStatus> {
  if (account.agent !== "codex") {
    return baseStatus(account, "not_codex", "Switch this profile to Codex before connecting a ChatGPT account.");
  }
  const resolved = which("codex");
  if (!resolved) return baseStatus(account, "cli_missing", "Codex CLI was not found on PATH.");
  if (!account.codexHome) {
    return baseStatus(account, "not_connected", "This profile is not isolated yet. Save/reload PingGPT and try again.");
  }

  mkdirSync(account.codexHome, { recursive: true });

  const previous = activeLoginProcesses.get(account.id);
  if (previous?.pid) {
    killTree(previous.pid);
    activeLoginProcesses.delete(account.id);
    activeLoginPrompts.delete(account.id);
  }

  const native = resolveCodexNativeExecutable(resolved);
  const prepared = native
    ? { command: native, args: ["login", "--device-auth"] }
    : prepareSpawn([resolved, "login", "--device-auth"]);

  return await new Promise<AccountAuthStatus>((resolve) => {
    let child: ReturnType<typeof spawn> | undefined;
    let settled = false;
    let captured = "";
    let capturedBytes = 0;
    let timer: NodeJS.Timeout | null = null;

    const finish = (status: AccountAuthStatus, keepProcess = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!keepProcess) {
        killTree(child?.pid);
      }
      resolve(status);
    };

    const inspectPrompt = () => {
      const prompt = parseCodexDeviceLoginPrompt(captured);
      if (prompt) {
        activeLoginPrompts.set(account.id, prompt);
        return finish({
          accountId: account.id,
          state: "login_started",
          detail: "Device login is ready. Sign in as the intended ChatGPT account and enter the one-time code.",
          loginUrl: prompt.loginUrl,
          loginCode: prompt.loginCode,
        }, true);
      }
    };

    const consume = (chunk: Buffer) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE) {
        return finish(baseStatus(account, "not_connected", "Codex login produced too much output before device authorization was ready."));
      }
      captured += chunk.toString("utf8");
      inspectPrompt();
    };

    try {
      child = spawn(prepared.command, prepared.args, {
        windowsHide: true,
        env: accountEnv(account),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return finish(baseStatus(account, "not_connected", "Codex device login could not be started."));
    }

    activeLoginProcesses.set(account.id, child);
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);

    child.once("error", () => {
      activeLoginProcesses.delete(account.id);
      activeLoginPrompts.delete(account.id);
      finish(baseStatus(account, "not_connected", "Codex device login process could not be started."));
    });

    child.once("close", (code) => {
      activeLoginProcesses.delete(account.id);
      activeLoginPrompts.delete(account.id);
      if (settled) return;
      const clean = stripAnsi(captured).trim();
      const detail = clean
        ? clean.slice(-600)
        : `Codex device login exited before authorization was ready (exit ${code ?? "unknown"}).`;
      finish(baseStatus(account, "not_connected", detail));
    });

    timer = setTimeout(() => {
      activeLoginProcesses.delete(account.id);
      activeLoginPrompts.delete(account.id);
      finish(baseStatus(account, "not_connected", "Timed out waiting for Codex device authorization instructions."));
    }, LOGIN_PROMPT_TIMEOUT_MS);
    timer?.unref();
  });
}
