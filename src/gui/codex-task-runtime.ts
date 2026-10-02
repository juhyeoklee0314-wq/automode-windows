import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { prepareStdioSpawn, resolveCodexNativeExecutable, which } from "../platform/command.js";
import type { AccountProfile, AccountRateLimitStatus, TaskResumeResult } from "./types.js";

const RPC_TIMEOUT_MS = 15_000;
const TURN_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_RPC_LINE_BUFFER = 8 * 1024 * 1024;

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | unknown;
}

interface Session {
  child: ReturnType<typeof spawn>;
  buffer: string;
  pending: Map<string, (message: RpcMessage) => void>;
  notifications: RpcMessage[];
}

interface TurnRecord {
  id: string;
  status: string;
  items: Array<Record<string, unknown>>;
}

export interface ResumeDecision {
  action: "wait" | "continue" | "replay" | "abort";
  reason: string;
  replayInput?: unknown[];
  beforeTurnId?: string;
}

function accountEnv(account: AccountProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: account.codexHome };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  return env;
}

function stopSession(session: Session | undefined): void {
  if (!session) return;
  try { session.child.stdin?.end(); } catch { /* closed */ }
  if (session.child.pid && process.platform === "win32") {
    execFile("taskkill.exe", ["/PID", String(session.child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  }
  try { session.child.kill("SIGKILL"); } catch { /* closed */ }
}

function respondFailClosed(session: Session, message: RpcMessage): void {
  if (message.id === undefined || !message.method) return;
  let response: Record<string, unknown>;
  if (message.method === "item/commandExecution/requestApproval") {
    response = { id: message.id, result: { decision: "decline" } };
  } else if (message.method === "item/fileChange/requestApproval") {
    response = { id: message.id, result: { decision: "decline" } };
  } else {
    response = {
      id: message.id,
      error: { code: -32601, message: "PingGPT background resume cannot satisfy interactive requests." },
    };
  }
  try { session.child.stdin?.write(JSON.stringify(response) + "\n"); } catch { /* timeout handles shutdown */ }
}

function startSession(account: AccountProfile): Promise<Session> {
  if (account.agent !== "codex" || !account.codexHome) throw new Error("Task resume requires an isolated Codex profile.");
  const launcher = which("codex");
  if (!launcher) throw new Error("Codex CLI was not found on PATH.");
  const native = resolveCodexNativeExecutable(launcher);
  const prepared = native
    ? { command: native, args: ["app-server", "--listen", "stdio://"] }
    : prepareStdioSpawn(launcher, ["app-server", "--listen", "stdio://"]);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(prepared.command, prepared.args, {
      windowsHide: true,
      env: accountEnv(account),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: Session = {
      child,
      buffer: "",
      pending: new Map(),
      notifications: [],
    };
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stopSession(session);
      reject(error);
    };
    child.once("error", fail);
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolvePromise(session);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      session.buffer += chunk.toString("utf8");
      if (session.buffer.length > MAX_RPC_LINE_BUFFER && !session.buffer.includes("\n")) {
        stopSession(session);
        return;
      }
      let newline = session.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = session.buffer.slice(0, newline).trim();
        session.buffer = session.buffer.slice(newline + 1);
        newline = session.buffer.indexOf("\n");
        if (!line) continue;
        let message: RpcMessage;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!parsed || typeof parsed !== "object") continue;
          message = parsed as RpcMessage;
        } catch {
          continue;
        }
        if (message.method && message.id !== undefined) {
          respondFailClosed(session, message);
          continue;
        }
        if (message.id !== undefined) {
          const callback = session.pending.get(String(message.id));
          if (callback) {
            session.pending.delete(String(message.id));
            callback(message);
          }
          continue;
        }
        if (message.method === "turn/completed") session.notifications.push(message);
      }
    });
    child.stderr?.on("data", () => {
      // Runtime stderr is intentionally not retained; provider diagnostics stay in provider-owned logs.
    });
  });
}

function sendRpc(
  session: Session,
  id: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<RpcMessage> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`${method} timed out.`));
    }, timeoutMs);
    timer.unref();
    session.pending.set(id, (message) => {
      clearTimeout(timer);
      resolvePromise(message);
    });
    try {
      session.child.stdin?.write(JSON.stringify({ id, method, params }) + "\n");
    } catch (error) {
      clearTimeout(timer);
      session.pending.delete(id);
      reject(error);
    }
  });
}

function rpcResult(message: RpcMessage, method: string): unknown {
  if (message.error) {
    const detail = typeof message.error === "object" && message.error && "message" in message.error
      ? String((message.error as { message?: unknown }).message ?? method)
      : method;
    throw new Error(`${method} failed: ${detail}`);
  }
  return message.result;
}

async function initialize(session: Session): Promise<void> {
  rpcResult(await sendRpc(session, "init", "initialize", {
    clientInfo: { name: "pinggpt-task-runtime", title: "PingGPT Task Runtime", version: "0.1.0" },
    capabilities: { experimentalApi: false },
  }), "initialize");
  session.child.stdin?.write(JSON.stringify({ method: "initialized" }) + "\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function threadFromResult(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  const thread = asRecord(record?.thread);
  if (!thread) throw new Error("Codex did not return thread metadata.");
  return thread;
}

function turnFromUnknown(value: unknown): TurnRecord | null {
  const record = asRecord(value);
  const id = typeof record?.id === "string" ? record.id : null;
  const status = typeof record?.status === "string" ? record.status : null;
  if (!id || !status) return null;
  const items = Array.isArray(record?.items)
    ? record.items.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : [];
  return { id, status, items };
}

function userInputs(turn: TurnRecord): unknown[] {
  const out: unknown[] = [];
  for (const item of turn.items) {
    if (item.type !== "userMessage" || !Array.isArray(item.content)) continue;
    out.push(...item.content);
  }
  return out;
}

function hasAgentProgress(turn: TurnRecord): boolean {
  return turn.items.some((item) => !["userMessage", "hookPrompt"].includes(String(item.type ?? "")));
}

export function decideResumeRecovery(turns: TurnRecord[], historyMode = "paginated"): ResumeDecision {
  const latest = turns[0];
  if (!latest) return { action: "abort", reason: "no_history" };
  if (latest.status === "inProgress") return { action: "wait", reason: "turn_running" };
  if (latest.status === "completed") return { action: "continue", reason: "last_turn_completed" };
  if (latest.status !== "failed" && latest.status !== "interrupted") {
    return { action: "abort", reason: "unknown_turn_status" };
  }
  if (hasAgentProgress(latest)) return { action: "continue", reason: "agent_progress_exists" };
  if (historyMode !== "paginated") return { action: "abort", reason: "replay_requires_paginated_history" };
  const input = userInputs(latest);
  if (!input.length) return { action: "abort", reason: "failed_turn_input_unavailable" };
  return {
    action: "replay",
    reason: "no_agent_progress_replay_original",
    replayInput: input,
    beforeTurnId: latest.id,
  };
}

function snapshotHash(thread: Record<string, unknown>, turns: TurnRecord[]): string {
  const stable = {
    id: thread.id,
    historyMode: thread.historyMode,
    turns: turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      items: turn.items,
    })),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

async function readThread(session: Session, threadId: string): Promise<Record<string, unknown>> {
  return threadFromResult(rpcResult(await sendRpc(session, "thread-read", "thread/read", {
    threadId,
    includeTurns: false,
  }), "thread/read"));
}

async function listLatestTurns(session: Session, threadId: string): Promise<TurnRecord[]> {
  const result = rpcResult(await sendRpc(session, "turns-list", "thread/turns/list", {
    threadId,
    limit: 2,
    sortDirection: "desc",
    itemsView: "full",
  }), "thread/turns/list");
  const record = asRecord(result);
  const data = Array.isArray(record?.data) ? record.data : [];
  return data.map(turnFromUnknown).filter((turn): turn is TurnRecord => turn !== null);
}

async function resumeThread(session: Session, threadId: string): Promise<Record<string, unknown>> {
  return threadFromResult(rpcResult(await sendRpc(session, "thread-resume", "thread/resume", {
    threadId,
    excludeTurns: true,
  }), "thread/resume"));
}

async function waitForTurnCompleted(session: Session, threadId: string, turnId: string): Promise<string> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const index = session.notifications.findIndex((message) => {
      if (message.method !== "turn/completed") return false;
      const params = asRecord(message.params);
      const turn = asRecord(params?.turn);
      return params?.threadId === threadId && turn?.id === turnId;
    });
    if (index >= 0) {
      const [message] = session.notifications.splice(index, 1);
      const params = asRecord(message?.params);
      const turn = asRecord(params?.turn);
      return typeof turn?.status === "string" ? turn.status : "unknown";
    }
    if (session.child.exitCode !== null) throw new Error("Codex app-server exited before the resumed turn completed.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Resumed turn exceeded the six-hour PingGPT wait limit.");
}

async function startTurn(session: Session, threadId: string, input: unknown[]): Promise<{ id: string; status: string }> {
  const result = rpcResult(await sendRpc(session, `turn-start-${Date.now()}`, "turn/start", {
    threadId,
    input,
    turnTrigger: "pinggpt-resume",
  }), "turn/start");
  const record = asRecord(result);
  const turn = asRecord(record?.turn);
  const id = typeof turn?.id === "string" ? turn.id : null;
  if (!id) throw new Error("Codex did not return a resumed turn id.");
  const status = await waitForTurnCompleted(session, threadId, id);
  return { id, status };
}

function result(
  accountId: string,
  threadId: string,
  action: TaskResumeResult["action"],
  status: TaskResumeResult["status"],
  detail: string,
  turnId: string | null = null,
): TaskResumeResult {
  return { accountId, threadId, action, status, detail, turnId };
}

function readFirstLine(path: string, maxBytes = 512 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(8192);
    const pieces: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes - total), null);
      if (count <= 0) break;
      const slice = Buffer.from(chunk.subarray(0, count));
      const newline = slice.indexOf(0x0a);
      if (newline >= 0) {
        pieces.push(slice.subarray(0, newline));
        return Buffer.concat(pieces).toString("utf8").replace(/\r$/, "");
      }
      pieces.push(slice);
      total += count;
    }
    throw new Error("Thread session metadata line exceeded the verification limit.");
  } finally {
    closeSync(fd);
  }
}

function currentAccountIdFromRateLimits(result: unknown): string | null {
  const root = asRecord(result);
  return typeof root?.accountId === "string" && root.accountId.trim() ? root.accountId : null;
}

async function currentAuthenticatedAccountId(session: Session): Promise<string> {
  const response = rpcResult(await sendRpc(session, `identity-${Date.now()}`, "account/rateLimits/read", {
    excludeResetCreditDetails: true,
  }), "account/rateLimits/read");
  const accountId = currentAccountIdFromRateLimits(response);
  if (!accountId) throw new Error("Current ChatGPT account identity could not be verified.");
  return accountId;
}

function threadCreatorAccountId(thread: Record<string, unknown>, codexHome: string): string {
  const rawPath = typeof thread.path === "string" ? thread.path : null;
  if (!rawPath) throw new Error("Task creator identity cannot be verified because the rollout path is unavailable.");

  const home = realpathSync(codexHome);
  const rollout = realpathSync(rawPath);
  const homePrefix = resolve(home) + sep;
  if (!resolve(rollout).startsWith(homePrefix)) {
    throw new Error("Task rollout is outside the selected account store.");
  }

  const first = JSON.parse(readFirstLine(rollout)) as unknown;
  const envelope = asRecord(first);
  const payload = asRecord(envelope?.payload);
  if (envelope?.type !== "session_meta") {
    throw new Error("Task session metadata is unavailable.");
  }
  const creator = payload?.creator_account_id;
  if (typeof creator !== "string" || !creator.trim()) {
    throw new Error("Task creator account identity is unavailable.");
  }
  return creator;
}

function verifyTaskAccountOwnership(
  thread: Record<string, unknown>,
  codexHome: string,
  currentAccountId: string,
): void {
  const creatorAccountId = threadCreatorAccountId(thread, codexHome);
  if (creatorAccountId !== currentAccountId) {
    throw new Error("Task creator account does not match the currently connected ChatGPT account.");
  }
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function readAccountRateLimitStatus(account: AccountProfile): Promise<AccountRateLimitStatus> {
  let session: Session | undefined;
  try {
    session = await startSession(account);
    await initialize(session);
    const result = rpcResult(await sendRpc(session, "rate-limits", "account/rateLimits/read", {
      excludeResetCreditDetails: true,
    }), "account/rateLimits/read");
    const root = asRecord(result);
    const limits = asRecord(root?.rateLimits);
    const primary = asRecord(limits?.primary);
    const secondary = asRecord(limits?.secondary);
    const primaryUsedPercent = numeric(primary?.usedPercent);
    const primaryResetsAt = numeric(primary?.resetsAt);
    const secondaryUsedPercent = numeric(secondary?.usedPercent);
    const secondaryResetsAt = numeric(secondary?.resetsAt);
    const blockedResets = [
      primaryUsedPercent !== null && primaryUsedPercent >= 100 ? primaryResetsAt : null,
      secondaryUsedPercent !== null && secondaryUsedPercent >= 100 ? secondaryResetsAt : null,
    ].filter((value): value is number => value !== null && value * 1000 > Date.now());
    const futureResets = [primaryResetsAt, secondaryResetsAt]
      .filter((value): value is number => value !== null && value * 1000 > Date.now());
    const suggestedResetAt = blockedResets.length
      ? Math.max(...blockedResets)
      : futureResets.length
        ? Math.min(...futureResets)
        : null;
    return {
      accountId: account.id,
      ordinaryUsageAllowed: typeof root?.ordinaryUsageAllowed === "boolean" ? root.ordinaryUsageAllowed : null,
      primaryUsedPercent,
      primaryResetsAt,
      secondaryUsedPercent,
      secondaryResetsAt,
      suggestedResetAt,
    };
  } finally {
    stopSession(session);
  }
}

export async function resumeCodexTask(
  account: AccountProfile,
  threadId: string,
  expectedUpdatedAt: number | null,
  continueMessage = "continue",
): Promise<TaskResumeResult> {
  if (account.agent !== "codex" || !account.codexHome) {
    return result(account.id, threadId, "abort", "rejected", "The selected account is not an isolated Codex profile.");
  }
  if (!/^[0-9A-Fa-f-]{36}$/.test(threadId)) {
    return result(account.id, threadId, "abort", "rejected", "The task id is invalid.");
  }

  let session: Session | undefined;
  try {
    session = await startSession(account);
    await initialize(session);

    const before = await readThread(session, threadId);
    const currentAccountId = await currentAuthenticatedAccountId(session);
    verifyTaskAccountOwnership(before, account.codexHome, currentAccountId);
    const actualUpdatedAt = typeof before.updatedAt === "number" ? before.updatedAt : null;
    if (expectedUpdatedAt !== null && actualUpdatedAt !== expectedUpdatedAt) {
      return result(account.id, threadId, "abort", "history_changed", "The task changed after the Task list was loaded.");
    }

    const initialTurns = await listLatestTurns(session, threadId);
    const historyMode = typeof before.historyMode === "string" ? before.historyMode : "unknown";
    const decision = decideResumeRecovery(initialTurns, historyMode);

    if (decision.action === "wait") {
      return result(account.id, threadId, "wait", "already_running", "The task already has a running turn; PingGPT did not submit another message.");
    }
    if (decision.action === "abort") {
      return result(account.id, threadId, "abort", "rejected", `Resume was blocked: ${decision.reason}.`);
    }

    await resumeThread(session, threadId);
    const verifyThread = await readThread(session, threadId);
    const verifyTurns = await listLatestTurns(session, threadId);
    if (snapshotHash(before, initialTurns) !== snapshotHash(verifyThread, verifyTurns)) {
      return result(account.id, threadId, "abort", "history_changed", "The task changed during recovery inspection; PingGPT aborted without submitting input.");
    }

    let input: unknown[];
    if (decision.action === "replay") {
      rpcResult(await sendRpc(session, "thread-revert", "thread/revert", {
        threadId,
        beforeTurnId: decision.beforeTurnId,
      }), "thread/revert");
      input = decision.replayInput ?? [];
    } else {
      input = [{ type: "text", text: continueMessage, textElements: [] }];
    }

    const started = await startTurn(session, threadId, input);
    return result(
      account.id,
      threadId,
      decision.action,
      started.status === "completed" ? "completed" : "turn_failed",
      started.status === "completed"
        ? "Task resume completed."
        : `The resumed turn ended with status ${started.status}.`,
      started.id,
    );
  } catch (error) {
    const detail = String((error as { message?: unknown })?.message ?? error).slice(0, 500);
    return result(account.id, threadId, "abort", "error", detail);
  } finally {
    stopSession(session);
  }
}
