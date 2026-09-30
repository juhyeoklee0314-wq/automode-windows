import { execFile } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { basename, join } from "node:path";

import { redactSecrets } from "../core/redact.js";
import type { AccountProfile, DiagnosticExportResult, SchedulerTaskStatus } from "./types.js";

const RECENT_WINDOW_MS = 30 * 60 * 1000;
const MAX_SECTION_CHARS = 80_000;
const MAX_COMMAND_OUTPUT_BYTES = 256_000;
const MAX_SCHEDULER_TASKS = 20;

export interface DiagnosticExportContext {
  desktopPath: string;
  appVersion: string;
  buildIdentity: string;
  diagnosticBuildIdentity: string;
  packaged: boolean;
  runId: string;
  primaryInstance: boolean;
  schedulerTarget: string;
  accounts: AccountProfile[];
  accountPreferencesError?: string;
  schedulerTasks: SchedulerTaskStatus[];
  schedulerStatusError?: string;
  diagnosticLogPath: string;
  now?: Date;
}

export interface DiagnosticExportDependencies {
  readText(path: string): string;
  pathExists(path: string): boolean;
  writeExclusive(path: string, text: string): void;
  processTree(pid: number): string | Promise<string>;
  crashEvents(since: Date): string | Promise<string>;
  schedulerDetails(tasks: SchedulerTaskStatus[]): string | SectionPayload | Promise<string | SectionPayload>;
}

export interface DiagnosticLogSelection {
  mode: "RUN_ID" | "PID" | "BOUNDED_TIME_FALLBACK" | "NO_MATCH" | "UNAVAILABLE";
  lines: string[];
  status: "OK" | "DEGRADED" | "UNAVAILABLE";
  error?: string;
}

interface SectionPayload { status: "OK" | "DEGRADED"; body: string }

const safeError = (error: unknown): string => redactSecrets(String((error as { message?: unknown })?.message ?? error))
  .replace(/[\r\n]+/g, " ").slice(0, 500);

function safeArgv(argv: string[]): string[] {
  const safe: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (/^--(background|diagnostic-startup|diagnostic-auto-exit)$/.test(arg)) safe.push(arg);
    else if (/^--type=[A-Za-z0-9_.-]+$/.test(arg)) safe.push(arg);
    else if (/^--utility-sub-type=[A-Za-z0-9_.-]+$/.test(arg)) safe.push(arg);
    else if (arg === "--scheduled-runner" || arg === "--scheduled-runner-dry-run") {
      safe.push(arg);
      for (const value of argv.slice(index + 1, index + 3)) safe.push(value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80));
      index += 2;
    }
  }
  return safe;
}

export function diagnosticFilename(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `PingGPT_Diagnostic_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.txt`;
}

export function uniqueDiagnosticPath(
  desktopPath: string,
  date: Date,
  pathExists: (path: string) => boolean = (path) => existsSync(path),
): string {
  const filename = diagnosticFilename(date);
  const extension = ".txt";
  const stem = filename.slice(0, -extension.length);
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = join(desktopPath, suffix === 1 ? filename : `${stem}-${suffix}${extension}`);
    if (!pathExists(candidate)) return candidate;
  }
  throw new Error("No available diagnostic filename.");
}

function parseDiagnosticLines(text: string): Array<{ raw: string; value: Record<string, unknown> }> {
  return text.split(/\r?\n/).filter(Boolean).flatMap((raw) => {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      return [{ raw, value }];
    } catch {
      return [];
    }
  });
}

export function filterDiagnosticLog(text: string, runId: string, pid: number, now: Date): DiagnosticLogSelection {
  const entries = parseDiagnosticLines(text);
  const byRun = entries.filter((entry) => entry.value.runId === runId);
  if (byRun.length) return { mode: "RUN_ID", lines: byRun.slice(-300).map((entry) => entry.raw), status: "OK" };
  const cutoff = now.getTime() - RECENT_WINDOW_MS;
  const isRecent = (entry: { value: Record<string, unknown> }): boolean => {
    const timestamp = Date.parse(String(entry.value.timestamp ?? ""));
    return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now.getTime() + 60_000;
  };
  const byPid = entries.filter((entry) => Number(entry.value.pid) === pid && isRecent(entry));
  if (byPid.length) return { mode: "PID", lines: byPid.slice(-300).map((entry) => entry.raw), status: "OK" };
  const recent = entries.filter(isRecent);
  if (recent.length) {
    return { mode: "BOUNDED_TIME_FALLBACK", lines: recent.slice(-200).map((entry) => entry.raw), status: "DEGRADED" };
  }
  return { mode: "NO_MATCH", lines: [], status: "UNAVAILABLE", error: "No matching records in the bounded collection window." };
}

function realWriteExclusive(path: string, text: string): void {
  const handle = openSync(path, "wx");
  try { writeFileSync(handle, text, "utf8"); } finally { closeSync(handle); }
}

function systemBinary(...parts: string[]): string {
  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot) throw new Error("SystemRoot is unavailable; refusing PATH-based diagnostic helper lookup.");
  return join(systemRoot, "System32", ...parts);
}

function boundedExecFile(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || error).trim();
        reject(new Error(detail || `Diagnostic helper failed: ${basename(file)}`));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

async function realProcessTree(pid: number): Promise<string> {
  if (process.platform !== "win32") throw new Error("Process enumeration is available only on Windows.");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$root=${pid}`,
    "$helperPid=$PID",
    "$all=@(Get-CimInstance Win32_Process)",
    "$selected=@($all | Where-Object { $_.ProcessId -eq $root })",
    "$frontier=@($root)",
    "while($frontier.Count -gt 0){$children=@($all | Where-Object { $frontier -contains $_.ParentProcessId -and $_.ProcessId -ne $helperPid });$selected+=@($children);$frontier=@($children | ForEach-Object ProcessId)}",
    "$selected | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,CommandLine | ConvertTo-Json -Compress",
  ].join("; ");
  const output = await boundedExecFile(
    systemBinary("WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    12_000,
  );
  const rows = output ? JSON.parse(output) as Record<string, unknown> | Record<string, unknown>[] : [];
  return (Array.isArray(rows) ? rows : [rows]).map((row) => {
    const command = String(row.CommandLine ?? "");
    const flags = safeArgv(command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []);
    return JSON.stringify({
      pid: row.ProcessId, parentPid: row.ParentProcessId, name: row.Name,
      executablePath: row.ExecutablePath, creationDate: row.CreationDate,
      safeArguments: flags,
    });
  }).join("\n");
}

async function realCrashEvents(since: Date): Promise<string> {
  if (process.platform !== "win32") throw new Error("Windows crash events are available only on Windows.");
  const iso = since.toISOString();
  const script = [
    "$ErrorActionPreference='Stop'",
    `$since=[DateTime]::Parse('${iso}').ToLocalTime()`,
    "$events=@()",
    "try{$events=@(Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=$since;Id=1000,1001} -MaxEvents 200 -ErrorAction Stop)}catch{if($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*'){throw}}",
    "$matching=@($events | Where-Object { $_.Message -match 'PingGPT|Automode' })",
    "$limited=@($matching | Select-Object -First 20 | ForEach-Object {$message=[string]$_.Message;if($message.Length -gt 2000){$message=$message.Substring(0,2000)};[ordered]@{timeCreated=$_.TimeCreated.ToString('o');providerName=[string]$_.ProviderName;id=[int]$_.Id;message=$message}})",
    "[ordered]@{queryStatus='OK';queriedEventCount=$events.Count;matchingEventCount=$matching.Count;truncated=($matching.Count -gt $limited.Count);events=$limited} | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  return boundedExecFile(
    systemBinary("WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    15_000,
  );
}

async function realSchedulerDetails(tasks: SchedulerTaskStatus[]): Promise<string | SectionPayload> {
  if (process.platform !== "win32") throw new Error("Task Scheduler diagnostics are available only on Windows.");
  if (!tasks.length) return "NO_GUI_OWNED_TASKS";
  const selected = tasks.slice(0, MAX_SCHEDULER_TASKS);
  const results = await Promise.all(selected.map(async (task) => {
    if (!task.name.startsWith("Automode GUI Ping ")) return { text: `SKIPPED_NON_GUI_TASK=${task.name}`, failed: false };
    try {
      const output = await boundedExecFile(
        systemBinary("schtasks.exe"),
        ["/Query", "/TN", task.name, "/FO", "LIST", "/V"],
        10_000,
      );
      return { text: `[TASK ${task.name}]\nconfiguredTime=${task.time}\nreceiptEnabled=${task.enabled}\n${output}`, failed: false };
    } catch (error) {
      return { text: `[TASK ${task.name}]\nSTATUS=UNAVAILABLE\nERROR=${safeError(error)}`, failed: true };
    }
  }));
  if (tasks.length > selected.length) {
    results.push({ text: `TRUNCATED_TASK_COUNT=${tasks.length - selected.length}`, failed: true });
  }
  const body = results.map((result) => result.text).join("\n\n");
  return results.some((result) => result.failed) ? { status: "DEGRADED", body } : body;
}

const defaultDependencies: DiagnosticExportDependencies = {
  readText: (path) => readFileSync(path, "utf8"),
  pathExists: existsSync,
  writeExclusive: realWriteExclusive,
  processTree: realProcessTree,
  crashEvents: realCrashEvents,
  schedulerDetails: realSchedulerDetails,
};

interface RenderedSection { text: string; failed: boolean }

async function section(name: string, producer: () => string | SectionPayload | Promise<string | SectionPayload>): Promise<RenderedSection> {
  try {
    const produced = await producer();
    const payload = typeof produced === "string" ? { status: "OK" as const, body: produced } : produced;
    return {
      text: `[${name}]\nSTATUS=${payload.status}\n${payload.body.slice(0, MAX_SECTION_CHARS)}`,
      failed: payload.status !== "OK",
    };
  } catch (error) {
    return { text: `[${name}]\nSTATUS=UNAVAILABLE\nERROR=${safeError(error)}`, failed: true };
  }
}

export async function exportDiagnosticSnapshot(
  context: DiagnosticExportContext,
  overrides: Partial<DiagnosticExportDependencies> = {},
): Promise<DiagnosticExportResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const now = context.now ?? new Date();
  const rendered = await Promise.all([
  section("EXPORT_METADATA", () => [
    `exportTimestamp=${now.toISOString()}`,
    `localTimezone=${Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"}`,
    `appVersion=${context.appVersion}`,
    `buildIdentity=${context.buildIdentity}`,
    `diagnosticBuildIdentity=${context.diagnosticBuildIdentity}`,
    `packaged=${context.packaged}`,
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    `processPid=${process.pid}`,
    `electronVersion=${process.versions.electron ?? "unavailable"}`,
    `nodeVersion=${process.versions.node}`,
    `chromeVersion=${process.versions.chrome ?? "unavailable"}`,
  ].join("\n")),
  section("ACTIVE_PROCESS_IDENTITY", () => [
    `mainPid=${process.pid}`,
    `execPath=${process.execPath}`,
    `executableName=${basename(process.execPath)}`,
    `safeArgv=${JSON.stringify(safeArgv(process.argv.slice(1)))}`,
    `packaged=${context.packaged}`,
    `portable=${Boolean(process.env.PORTABLE_EXECUTABLE_FILE)}`,
    `runId=${context.runId}`,
    `buildIdentity=${context.buildIdentity}`,
  ].join("\n")),
  section("SINGLE_INSTANCE_STATE", () => `primary=${context.primaryInstance}\nsource=existing_main_runtime_state`),
  section("PROCESS_TREE", () => dependencies.processTree(process.pid)),
  section("DIAGNOSTIC_LOG", () => {
    let selection: DiagnosticLogSelection;
    try { selection = filterDiagnosticLog(dependencies.readText(context.diagnosticLogPath), context.runId, process.pid, now); }
    catch (error) { throw new Error(`Diagnostic log unavailable: ${safeError(error)}`); }
    if (selection.status === "UNAVAILABLE") throw new Error(selection.error || "No matching diagnostic records.");
    return {
      status: selection.status,
      body: `path=${context.diagnosticLogPath}\nDIAGNOSTIC_FILTER_MODE=${selection.mode}\n${selection.lines.join("\n")}`,
    };
  }),
  section("WINDOWS_CRASH_EVENTS", () => dependencies.crashEvents(new Date(now.getTime() - RECENT_WINDOW_MS))),
  section("SCHEDULER_DIAGNOSTIC", () => {
    if (context.schedulerStatusError) throw new Error(`Scheduler status unavailable: ${context.schedulerStatusError}`);
    return dependencies.schedulerDetails(context.schedulerTasks);
  }),
  section("CODEX_ACCOUNT_EXECUTION_CONTEXT", () => {
    if (context.accountPreferencesError) throw new Error(`Account preferences unavailable: ${context.accountPreferencesError}`);
    return [
    `schedulerTarget=${context.schedulerTarget}`,
    ...context.accounts.map((account) => JSON.stringify({
      id: account.id,
      displayName: account.displayName,
      enabled: account.enabled,
      codexHome: account.codexHome || "DEFAULT_OR_INHERITED",
      messageConfigured: Boolean(account.message),
      scheduleCount: account.schedules.length,
      agent: account.agent,
    })),
    ].join("\n");
  }),
  ]);
  const failures = rendered.filter((entry) => entry.failed).map((entry) => entry.text.match(/^\[([^\]]+)\]/)?.[1] ?? "UNKNOWN");
  const parts = rendered.map((entry) => entry.text);
  const status = failures.length ? "PARTIAL" : "COMPLETE";
  const body = redactSecrets([
    "PingGPT Diagnostic Snapshot",
    `EXPORT_STATUS=${status}`,
    `FAILED_SECTIONS=${failures.join(",") || "NONE"}`,
    "COLLECTION_WINDOW_MINUTES=30",
    "",
    ...parts,
    "",
  ].join("\n\n"));
  try {
    const path = uniqueDiagnosticPath(context.desktopPath, now, dependencies.pathExists);
    dependencies.writeExclusive(path, body);
    return { ok: true, path, status };
  } catch (error) {
    return { ok: false, status: "FAILED", error: safeError(error) };
  }
}
