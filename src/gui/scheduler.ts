import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../core/config.js";
import { parseHhmm } from "../core/timeutil.js";
import type { AccountTarget, SchedulerTaskStatus } from "./types.js";

export const GUI_TASK_PREFIX = "Automode GUI Ping";
const receiptPath = (): string => join(stateDir(), "gui-schedule.json");

interface Receipt { tasks: SchedulerTaskStatus[] }
interface DesiredTask extends SchedulerTaskStatus { profileId: string; storeId: string; wakePc: boolean }
export type TaskCommand = (args: string[]) => { ok: boolean; output: string };

function powershellTaskSettings(taskName: string, wakePc: boolean): { ok: boolean; output: string } {
  const safeName = taskName.replace(/'/g, "''");
  const wakeLiteral = wakePc ? "$true" : "$false";
  const script = [
    "$ErrorActionPreference='Stop'",
    "$svc=New-Object -ComObject 'Schedule.Service'",
    "$svc.Connect()",
    "$folder=$svc.GetFolder('\\')",
    `$task=$folder.GetTask('${safeName}')`,
    "$definition=$task.Definition",
    `$definition.Settings.WakeToRun=${wakeLiteral}`,
    "$definition.Settings.StartWhenAvailable=$true",
    "$definition.Settings.DisallowStartIfOnBatteries=$true",
    "$definition.Settings.StopIfGoingOnBatteries=$true",
    "$folder.RegisterTaskDefinition($task.Name,$definition,6,$null,$null,3) | Out-Null",
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

function realTaskCommand(args: string[]): { ok: boolean; output: string } {
  if (process.env.AUTOMODE_SCHEDULER_DRY_RUN === "1") return { ok: true, output: "dry-run" };
  if (args[0] === "@ConfigurePower") {
    return powershellTaskSettings(String(args[1] ?? ""), args[2] === "true");
  }
  try {
    return { ok: true, output: String(execFileSync("schtasks.exe", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) };
  } catch (error) {
    const detail = error as { stderr?: Buffer | string; message?: string };
    return { ok: false, output: String(detail.stderr ?? detail.message ?? error).trim() };
  }
}

function readReceipt(path = receiptPath()): Receipt {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Receipt;
    return { tasks: Array.isArray(raw.tasks) ? raw.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

function readDiagnosticReceipt(path: string): Receipt {
  if (!existsSync(path)) return { tasks: [] };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Receipt>;
  if (!Array.isArray(raw.tasks)) throw new Error("Scheduler receipt does not contain a task list.");
  return { tasks: raw.tasks };
}

function writeReceipt(tasks: SchedulerTaskStatus[], path = receiptPath()): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tasks }, null, 2), "utf8");
  renameSync(tmp, path);
}

const safePart = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40);
export const taskName = (profileId: string, storeId: string, scheduleId: string): string =>
  `${GUI_TASK_PREFIX} ${safePart(profileId)} ${safePart(storeId)} ${safePart(scheduleId)}`;

function desiredTasks(accounts: AccountTarget[]): DesiredTask[] {
  const desired: DesiredTask[] = [];
  for (const account of accounts.filter((entry) => entry.enabled)) {
    account.schedules.forEach((time, index) => {
      if (!parseHhmm(time)) return;
      const scheduleId = `${time.replace(":", "")}-${index}`;
      desired.push({
        profileId: account.profileId,
        storeId: account.storeId,
        wakePc: account.wakePc === true,
        name: taskName(account.profileId, account.storeId, scheduleId),
        scheduleId,
        time,
        installed: false,
        enabled: false,
      });
    });
  }
  return desired;
}

function withoutName(tasks: SchedulerTaskStatus[], name: string): SchedulerTaskStatus[] {
  return tasks.filter((task) => task.name !== name);
}

function upsertTask(tasks: SchedulerTaskStatus[], task: SchedulerTaskStatus): SchedulerTaskStatus[] {
  return [...withoutName(tasks, task.name), task];
}

/** electron-builder Portable exposes the stable launcher here; process.execPath is its temporary extraction. */
export function schedulerExecutable(execPath: string, portableFile = process.env.PORTABLE_EXECUTABLE_FILE): string {
  return portableFile?.trim() || execPath;
}

function windowsAction(executable: string, profileId: string, storeId: string, scheduleId: string): string {
  const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  return [executable, "--scheduled-runner", profileId, storeId, scheduleId].map(quote).join(" ");
}

export class WindowsScheduler {
  constructor(
    private readonly executable: string,
    private readonly runTask: TaskCommand = realTaskCommand,
    private readonly receiptFile: string = receiptPath(),
  ) {}

  install(accounts: AccountTarget[]): SchedulerTaskStatus[] {
    const existing = readReceipt(this.receiptFile);
    const desired = desiredTasks(accounts);
    const wanted = new Set(desired.map((task) => task.name));
    let tracked = [...existing.tasks];
    const deleteFailures: string[] = [];

    for (const old of existing.tasks.filter((task) => !wanted.has(task.name))) {
      const result = this.runTask(["/Delete", "/TN", old.name, "/F"]);
      if (result.ok) {
        tracked = withoutName(tracked, old.name);
        writeReceipt(tracked, this.receiptFile);
      } else {
        deleteFailures.push(`${old.name}: ${result.output}`);
      }
    }
    if (deleteFailures.length) {
      throw new Error(`Task Scheduler could not remove obsolete PingGPT tasks: ${deleteFailures.join(" | ")}`);
    }

    const created: SchedulerTaskStatus[] = [];
    for (const task of desired) {
      const result = this.runTask([
        "/Create", "/F", "/SC", "DAILY", "/ST", task.time, "/TN", task.name,
        "/TR", windowsAction(this.executable, task.profileId, task.storeId, task.scheduleId), "/IT",
      ]);
      if (!result.ok) {
        writeReceipt(tracked, this.receiptFile);
        throw new Error(`Task Scheduler failed for ${task.time}: ${result.output}`);
      }

      const power = this.runTask(["@ConfigurePower", task.name, task.wakePc ? "true" : "false"]);
      if (!power.ok) {
        this.runTask(["/Delete", "/TN", task.name, "/F"]);
        tracked = withoutName(tracked, task.name);
        writeReceipt(tracked, this.receiptFile);
        throw new Error(`Task Scheduler power settings failed for ${task.time}: ${power.output}`);
      }

      const stored = { name: task.name, scheduleId: task.scheduleId, time: task.time, installed: true, enabled: true };
      tracked = upsertTask(tracked, stored);
      created.push(stored);
      writeReceipt(tracked, this.receiptFile);
    }

    const finalNames = new Set(created.map((task) => task.name));
    tracked = tracked.filter((task) => finalNames.has(task.name));
    writeReceipt(tracked, this.receiptFile);
    return tracked;
  }

  /** Remove tasks for accounts/schedules that were deleted without enabling new work. */
  prune(accounts: AccountTarget[]): SchedulerTaskStatus[] {
    const receipt = readReceipt(this.receiptFile);
    const wanted = new Set(desiredTasks(accounts).map((task) => task.name));
    let tracked = [...receipt.tasks];
    const failures: string[] = [];
    for (const task of receipt.tasks) {
      if (wanted.has(task.name)) continue;
      const result = this.runTask(["/Delete", "/TN", task.name, "/F"]);
      if (result.ok) {
        tracked = withoutName(tracked, task.name);
        writeReceipt(tracked, this.receiptFile);
      } else {
        failures.push(`${task.name}: ${result.output}`);
      }
    }
    if (failures.length) {
      throw new Error(`Task Scheduler could not remove obsolete PingGPT tasks: ${failures.join(" | ")}`);
    }
    return tracked;
  }

  setEnabled(enabled: boolean): SchedulerTaskStatus[] {
    const receipt = readReceipt(this.receiptFile);
    const tasks = receipt.tasks.map((task) => {
      const result = this.runTask(["/Change", "/TN", task.name, enabled ? "/Enable" : "/Disable"]);
      return { ...task, installed: result.ok, enabled: result.ok && enabled };
    });
    writeReceipt(tasks, this.receiptFile);
    return tasks;
  }

  status(): SchedulerTaskStatus[] {
    return readReceipt(this.receiptFile).tasks.map((task) => {
      const result = this.runTask(["/Query", "/TN", task.name, "/FO", "LIST"]);
      const disabled = /Disabled/i.test(result.output);
      return { ...task, installed: result.ok, enabled: result.ok && !disabled && task.enabled };
    });
  }

  diagnosticReceiptTasks(): SchedulerTaskStatus[] {
    return readDiagnosticReceipt(this.receiptFile).tasks;
  }
}
