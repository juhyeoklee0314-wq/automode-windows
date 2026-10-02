import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";

import { prepareStdioSpawn, resolveCodexNativeExecutable, which } from "../platform/command.js";
import type {
  AccountProfile,
  TaskInventoryItem,
  TaskInventorySnapshot,
  TaskInventorySource,
  TaskInventorySourceError,
} from "./types.js";

const RPC_TIMEOUT_MS = 12_000;
const SOURCE_TIMEOUT_MS = 20_000;
const MAX_CAPTURE = 512 * 1024;
const PAGE_LIMIT = 100;
const MAX_ROLLOUT_FILES = 1_000;
const MAX_ROLLOUT_PREFIX_BYTES = 2 * 1024 * 1024;

interface AppServerSession {
  child: ReturnType<typeof spawn>;
  buffer: string;
  captured: number;
  pending: Map<string, (message: RpcMessage) => void>;
}

interface RpcMessage {
  id?: string | number;
  method?: string;
  result?: unknown;
  error?: unknown;
}

interface RawThreadPage {
  data?: unknown;
  nextCursor?: unknown;
}

interface DiscoveryTarget {
  source: TaskInventorySource;
  codexHome: string;
  accountId: string | null;
  accountLabel: string;
}

function accountEnv(codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  return env;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  }
}

function stopSession(session: AppServerSession | undefined): void {
  if (!session) return;
  try { session.child.stdin?.end(); } catch { /* already closed */ }
  killTree(session.child.pid);
  try { session.child.kill("SIGKILL"); } catch { /* already gone */ }
}

function safeString(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function safeStatus(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "unknown";
  const keys = Object.keys(value as Record<string, unknown>);
  return keys[0] ?? "unknown";
}

function sourceLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "unknown";
  try {
    return JSON.stringify(value).slice(0, 120);
  } catch {
    return "unknown";
  }
}

function readPrefix(path: string, maxBytes = MAX_ROLLOUT_PREFIX_BYTES): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const count = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, count).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function activeRolloutPaths(codexHome: string): string[] {
  const root = join(codexHome, "sessions");
  if (!existsSync(root)) return [];

  const paths: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !/^rollout-.*\.jsonl$/i.test(entry.name)) continue;
      paths.push(path);
      if (paths.length > MAX_ROLLOUT_FILES) {
        throw new Error(`Account rollout scan exceeded the ${MAX_ROLLOUT_FILES}-file safety limit.`);
      }
    }
  }
  return paths;
}

function timestampSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis / 1000 : null;
}

function rolloutUserText(payload: Record<string, unknown>): string | null {
  if (payload.type === "user_message") return safeString(payload.message, 240);
  if (payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) return null;
  for (const part of payload.content) {
    const item = asRecord(part);
    if (!item) continue;
    if (item.type === "input_text" || item.type === "text") {
      const text = safeString(item.text, 240);
      if (text) return text;
    }
  }
  return null;
}

function stripUserPrefix(value: string | null): string | null {
  if (!value) return null;
  const marker = "## My request for Codex:";
  const at = value.indexOf(marker);
  return safeString(at >= 0 ? value.slice(at + marker.length) : value, 240);
}

function isUserResumableRolloutSource(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["cli", "vscode", "exec", "mcp"].includes(value.toLowerCase());
}

export function parseRolloutInventoryText(
  text: string,
  modifiedAtSeconds: number,
  target: Pick<DiscoveryTarget, "source" | "accountId" | "accountLabel">,
): TaskInventoryItem | null {
  const lines = text.split(/\r?\n/);
  let meta: Record<string, unknown> | null = null;
  let preview: string | null = null;
  let model: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown> | null = null;
    try { record = asRecord(JSON.parse(line)); } catch { continue; }
    if (!record) continue;
    const payload = asRecord(record.payload);
    if (!payload) continue;

    if (!meta && record.type === "session_meta") {
      meta = payload;
      continue;
    }
    if (!preview && (record.type === "event_msg" || record.type === "response_item")) {
      preview = stripUserPrefix(rolloutUserText(payload));
    }
    if (!model && record.type === "turn_context") {
      model = safeString(payload.model, 120);
    }
  }

  if (!meta) return null;
  const id = safeString(meta.id, 100);
  const creatorAccountId = safeString(meta.creator_account_id, 300);
  if (!id || !creatorAccountId || !/^[0-9A-Fa-f-]{36}$/.test(id)) return null;
  if (!isUserResumableRolloutSource(meta.source)) return null;

  const createdAt = timestampSeconds(meta.timestamp);
  const updatedAt = Number.isFinite(modifiedAtSeconds) && modifiedAtSeconds > 0
    ? modifiedAtSeconds
    : createdAt;
  const title = preview ?? `Codex task ${id.slice(0, 8)}`;

  return {
    id,
    source: target.source,
    accountId: target.accountId,
    accountLabel: target.accountLabel,
    title,
    preview: preview ?? "",
    cwd: safeString(meta.cwd, 500),
    model,
    modelProvider: safeString(meta.model_provider, 120),
    createdAt,
    updatedAt,
    recencyAt: updatedAt,
    status: "notLoaded",
    historyMode: safeString(meta.history_mode, 80) ?? "legacy",
    sessionSource: sourceLabel(meta.source),
    originator: safeString(meta.originator, 120),
    resumeEligibility: target.source === "account"
      ? "same_profile_candidate"
      : "legacy_unassigned",
  };
}

function listRolloutSource(target: DiscoveryTarget): TaskInventoryItem[] {
  if (target.source !== "account") return [];
  const items = new Map<string, TaskInventoryItem>();
  for (const path of activeRolloutPaths(target.codexHome)) {
    try {
      const modifiedAtSeconds = statSync(path).mtimeMs / 1000;
      const item = parseRolloutInventoryText(readPrefix(path), modifiedAtSeconds, target);
      if (item) items.set(item.id, item);
    } catch {
      // One malformed/inaccessible rollout must not hide other account tasks.
    }
  }
  return [...items.values()];
}

export function parseTaskInventoryThread(
  raw: unknown,
  target: Pick<DiscoveryTarget, "source" | "accountId" | "accountLabel">,
): TaskInventoryItem | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = safeString(record.id, 100);
  if (!id) return null;

  const name = safeString(record.name, 240);
  const preview = safeString(record.preview, 240);
  const title = name ?? preview ?? "(Untitled task)";

  return {
    id,
    source: target.source,
    accountId: target.accountId,
    accountLabel: target.accountLabel,
    title,
    preview: preview ?? "",
    cwd: safeString(record.cwd, 500),
    model: safeString(record.model, 120),
    modelProvider: safeString(record.modelProvider, 120),
    createdAt: safeNumber(record.createdAt),
    updatedAt: safeNumber(record.updatedAt),
    recencyAt: safeNumber(record.recencyAt),
    status: safeStatus(record.status),
    historyMode: safeString(record.historyMode, 80) ?? "unknown",
    sessionSource: sourceLabel(record.source),
    originator: safeString(record.originator, 120),
    resumeEligibility: target.source === "account"
      ? "same_profile_candidate"
      : "legacy_unassigned",
  };
}

export function parseTaskInventoryPage(
  result: unknown,
  target: Pick<DiscoveryTarget, "source" | "accountId" | "accountLabel">,
): { items: TaskInventoryItem[]; nextCursor: string | null } {
  if (!result || typeof result !== "object") return { items: [], nextCursor: null };
  const page = result as RawThreadPage;
  const data = Array.isArray(page.data) ? page.data : [];
  const items = data
    .map((entry) => parseTaskInventoryThread(entry, target))
    .filter((entry): entry is TaskInventoryItem => entry !== null);
  return {
    items,
    nextCursor: safeString(page.nextCursor, 1000),
  };
}

function startAppServer(command: string, codexHome: string): Promise<AppServerSession> {
  const native = resolveCodexNativeExecutable(command);
  const prepared = native
    ? { command: native, args: ["app-server", "--listen", "stdio://"] }
    : prepareStdioSpawn(command, ["app-server", "--listen", "stdio://"]);

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const child = spawn(prepared.command, prepared.args, {
      windowsHide: true,
      env: accountEnv(codexHome),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: AppServerSession = {
      child,
      buffer: "",
      captured: 0,
      pending: new Map(),
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stopSession(session);
      reject(error);
    };

    child.once("error", (error) => fail(error));
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolvePromise(session);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      session.captured += chunk.length;
      if (session.captured > MAX_CAPTURE) {
        stopSession(session);
        return;
      }
      session.buffer += chunk.toString("utf8");
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
          try {
            child.stdin?.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
          } catch { /* session shutdown will surface through timeout */ }
          continue;
        }

        if (message.id !== undefined) {
          const callback = session.pending.get(String(message.id));
          if (callback) {
            session.pending.delete(String(message.id));
            callback(message);
          }
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      session.captured += chunk.length;
      if (session.captured > MAX_CAPTURE) stopSession(session);
    });
  });
}

function rpc(
  session: AppServerSession,
  id: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<RpcMessage> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`${method} timed out`));
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

async function initialize(session: AppServerSession, sourceKey: string): Promise<void> {
  const response = await rpc(session, `task-init-${sourceKey}`, "initialize", {
    clientInfo: {
      name: "pinggpt-task-discovery",
      title: "PingGPT Task Discovery",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: false },
  });
  if (response.error) throw new Error("Codex app-server initialize failed.");
  session.child.stdin?.write(JSON.stringify({ method: "initialized" }) + "\n");
}

async function listSource(command: string, target: DiscoveryTarget): Promise<TaskInventoryItem[]> {
  if (!existsSync(join(target.codexHome, "state_5.sqlite"))) return [];
  const session = await startAppServer(command, target.codexHome);
  const deadline = Date.now() + SOURCE_TIMEOUT_MS;
  try {
    await initialize(session, target.accountId ?? "legacy");
    const byId = new Map<string, TaskInventoryItem>();
    let cursor: string | null = null;
    let page = 0;

    do {
      page += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Task discovery source timed out.");

      const response = await rpc(
        session,
        `task-list-${target.accountId ?? "legacy"}-${page}`,
        "thread/list",
        {
          cursor,
          limit: PAGE_LIMIT,
          archived: false,
          sourceKinds: target.source === "account"
            ? ["cli", "vscode", "exec", "appServer"]
            : ["cli", "vscode"],
          useStateDbOnly: true,
        },
        Math.min(RPC_TIMEOUT_MS, remaining),
      );
      if (response.error) throw new Error("Codex thread/list failed.");
      const parsed = parseTaskInventoryPage(response.result, target);
      for (const item of parsed.items) byId.set(item.id, item);
      cursor = parsed.nextCursor;
    } while (cursor);

    return [...byId.values()].sort((a, b) =>
      (b.recencyAt ?? b.updatedAt ?? b.createdAt ?? 0) -
      (a.recencyAt ?? a.updatedAt ?? a.createdAt ?? 0));
  } finally {
    stopSession(session);
  }
}

function normalizePathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? normalize(absolute).toLowerCase() : normalize(absolute);
}

function discoveryTargets(accounts: AccountProfile[]): DiscoveryTarget[] {
  const targets: DiscoveryTarget[] = [];
  const seen = new Set<string>();

  for (const account of accounts) {
    if (account.agent !== "codex" || !account.codexHome) continue;
    const key = normalizePathKey(account.codexHome);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      source: "account",
      codexHome: account.codexHome,
      accountId: account.id,
      accountLabel: account.displayName,
    });
  }

  const globalHome = join(homedir(), ".codex");
  const globalKey = normalizePathKey(globalHome);
  if (!seen.has(globalKey)) {
    targets.push({
      source: "legacy_global",
      codexHome: globalHome,
      accountId: null,
      accountLabel: "Legacy / Global",
    });
  }

  return targets;
}

export async function discoverCodexTasks(accounts: AccountProfile[]): Promise<TaskInventorySnapshot> {
  const generatedAt = new Date().toISOString();
  const command = which("codex");
  if (!command) {
    return {
      generatedAt,
      items: [],
      errors: [{
        source: "legacy_global",
        accountId: null,
        accountLabel: "Codex",
        detail: "Codex CLI was not found on PATH.",
      }],
    };
  }

  const items: TaskInventoryItem[] = [];
  const errors: TaskInventorySourceError[] = [];

  for (const target of discoveryTargets(accounts)) {
    try {
      if (target.source === "account") {
        const rolloutItems = listRolloutSource(target);
        let indexedItems: TaskInventoryItem[] = [];
        try {
          indexedItems = await listSource(command, target);
        } catch (error) {
          if (!rolloutItems.length) throw error;
        }
        const merged = new Map<string, TaskInventoryItem>();
        for (const item of rolloutItems) merged.set(item.id, item);
        // Indexed metadata is canonical when present; rollout scanning is a read-only fallback.
        for (const item of indexedItems) merged.set(item.id, item);
        items.push(...merged.values());
      } else {
        items.push(...await listSource(command, target));
      }
    } catch (error) {
      errors.push({
        source: target.source,
        accountId: target.accountId,
        accountLabel: target.accountLabel,
        detail: String((error as { message?: unknown })?.message ?? error).slice(0, 300),
      });
    }
  }

  items.sort((a, b) =>
    (b.recencyAt ?? b.updatedAt ?? b.createdAt ?? 0) -
    (a.recencyAt ?? a.updatedAt ?? a.createdAt ?? 0));

  return { generatedAt, items, errors };
}
