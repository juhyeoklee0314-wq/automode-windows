import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
      items.push(...await listSource(command, target));
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
