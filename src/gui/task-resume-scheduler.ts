import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../core/config.js";
import type { TaskResumeSchedule } from "./types.js";

export const TASK_RESUME_PREFIX = "PingGPT Task Resume";
const receiptPath = (): string => join(stateDir(), "task-resume-schedule.json");

interface ReceiptTask {
  id: string;
  name: string;
  runAt: string;
  installed: boolean;
  enabled: boolean;
}
interface Receipt { tasks: ReceiptTask[] }
export type ResumeTaskCommand = (operation: "register" | "delete", task: ReceiptTask, executable: string, wakePc: boolean) => { ok: boolean; output: string };

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48);
}

export function resumeTaskName(scheduleId: string): string {
  return `${TASK_RESUME_PREFIX} ${safePart(scheduleId)}`;
}

function quotePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}

function localBoundary(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid task resume schedule timestamp.");
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

function realCommand(
  operation: "register" | "delete",
  task: ReceiptTask,
  executable: string,
  wakePc: boolean,
): { ok: boolean; output: string } {
  if (process.env.AUTOMODE_SCHEDULER_DRY_RUN === "1") return { ok: true, output: "dry-run" };
  const safeName = quotePowerShell(task.name);
  const safeExe = quotePowerShell(executable);
  const safeId = quotePowerShell(task.id);
  const wake = wakePc ? "$true" : "$false";
  const script = operation === "delete"
    ? [
        "$ErrorActionPreference='Stop'",
        "$svc=New-Object -ComObject 'Schedule.Service'",
        "$svc.Connect()",
        "$folder=$svc.GetFolder('\\')",
        `try{$folder.DeleteTask('${safeName}',0)}catch{if($_.Exception.HResult -ne -2147024894){throw}}`,
      ].join("; ")
    : [
        "$ErrorActionPreference='Stop'",
        "$svc=New-Object -ComObject 'Schedule.Service'",
        "$svc.Connect()",
        "$folder=$svc.GetFolder('\\')",
        "$definition=$svc.NewTask(0)",
        "$definition.RegistrationInfo.Description='PingGPT one-shot Codex task resume'",
        "$trigger=$definition.Triggers.Create(1)",
        `$trigger.StartBoundary='${localBoundary(task.runAt)}'`,
        "$trigger.Enabled=$true",
        "$action=$definition.Actions.Create(0)",
        `$action.Path='${safeExe}'`,
        `$action.Arguments='--scheduled-task-resume "${safeId}"'`,
        "$definition.Settings.StartWhenAvailable=$true",
        `$definition.Settings.WakeToRun=${wake}`,
        "$definition.Settings.DisallowStartIfOnBatteries=$true",
        "$definition.Settings.StopIfGoingOnBatteries=$true",
        "$definition.Settings.ExecutionTimeLimit='PT6H'",
        `$folder.RegisterTaskDefinition('${safeName}',$definition,6,$null,$null,3) | Out-Null`,
      ].join("; ");
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return { ok: true, output: String(output) };
  } catch (error) {
    const detail = error as { stderr?: Buffer | string; message?: string };
    return { ok: false, output: String(detail.stderr ?? detail.message ?? error).trim() };
  }
}

function readReceipt(path = receiptPath()): Receipt {
  try {
    if (!existsSync(path)) return { tasks: [] };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Receipt>;
    return { tasks: Array.isArray(raw.tasks) ? raw.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

function writeReceipt(receipt: Receipt, path = receiptPath()): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2), "utf8");
  renameSync(tmp, path);
}

export class TaskResumeScheduler {
  constructor(
    private readonly executable: string,
    private readonly runTask: ResumeTaskCommand = realCommand,
    private readonly receiptFile: string = receiptPath(),
  ) {}

  sync(schedules: TaskResumeSchedule[]): void {
    const existing = readReceipt(this.receiptFile);
    const desired = schedules.filter((schedule) => schedule.enabled);
    const desiredIds = new Set(desired.map((schedule) => schedule.id));
    let tracked = [...existing.tasks];

    for (const old of existing.tasks.filter((task) => !desiredIds.has(task.id))) {
      const result = this.runTask("delete", old, this.executable, false);
      if (!result.ok) throw new Error(`Could not remove task resume schedule ${old.id}: ${result.output}`);
      tracked = tracked.filter((entry) => entry.id !== old.id);
      writeReceipt({ tasks: tracked }, this.receiptFile);
    }

    for (const schedule of desired) {
      const task: ReceiptTask = {
        id: schedule.id,
        name: resumeTaskName(schedule.id),
        runAt: schedule.runAt,
        installed: false,
        enabled: false,
      };
      const result = this.runTask("register", task, this.executable, schedule.wakePc);
      if (!result.ok) throw new Error(`Could not register task resume schedule ${schedule.id}: ${result.output}`);
      const stored = { ...task, installed: true, enabled: true };
      tracked = [...tracked.filter((entry) => entry.id !== schedule.id), stored];
      writeReceipt({ tasks: tracked }, this.receiptFile);
    }
  }

  cancel(scheduleId: string): void {
    const receipt = readReceipt(this.receiptFile);
    const task = receipt.tasks.find((entry) => entry.id === scheduleId);
    if (!task) return;
    const result = this.runTask("delete", task, this.executable, false);
    if (!result.ok) throw new Error(`Could not delete task resume schedule ${scheduleId}: ${result.output}`);
    writeReceipt({ tasks: receipt.tasks.filter((entry) => entry.id !== scheduleId) }, this.receiptFile);
  }
}
