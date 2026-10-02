import * as configmod from "../core/config.js";
import { createLogger } from "../core/log.js";
import { acquireExecutionLock } from "./lease.js";
import { loadPreferences, savePreferences } from "./preferences.js";
import { resumeCodexTask } from "./codex-task-runtime.js";
import type { TaskResumeResult } from "./types.js";

const MAX_CATCHUP_MS = 180 * 60 * 1000;
const EARLY_TOLERANCE_MS = 60 * 1000;

export interface ScheduledTaskResumeOutcome {
  code: number;
  result: TaskResumeResult | null;
}

export async function runScheduledTaskResume(
  scheduleId: string,
  now = new Date(),
  onConsumed?: (scheduleId: string) => void,
): Promise<ScheduledTaskResumeOutcome> {
  const log = createLogger();
  const config = configmod.load();
  const preferences = loadPreferences(config);
  const schedule = preferences.taskResumeSchedules.find((entry) => entry.id === scheduleId && entry.enabled);
  if (!schedule) return { code: 64, result: null };

  const dueAt = new Date(schedule.runAt).getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(dueAt)) return { code: 64, result: null };
  if (nowMs + EARLY_TOLERANCE_MS < dueAt) return { code: 75, result: null };
  if (nowMs - dueAt > MAX_CATCHUP_MS) {
    schedule.enabled = false;
    schedule.completedAt = now.toISOString();
    schedule.lastStatus = "rejected";
    savePreferences(preferences);
    onConsumed?.(schedule.id);
    log(`scheduled task resume expired without execution: ${schedule.id}`);
    return { code: 75, result: null };
  }

  const account = preferences.accounts.find((entry) =>
    entry.id === schedule.accountId && entry.enabled && entry.agent === "codex");
  if (!account) {
    schedule.enabled = false;
    schedule.completedAt = now.toISOString();
    schedule.lastStatus = "rejected";
    savePreferences(preferences);
    onConsumed?.(schedule.id);
    return { code: 64, result: null };
  }

  const release = acquireExecutionLock(`task-resume-${schedule.id}`);
  if (!release) return { code: 75, result: null };

  let result: TaskResumeResult;
  try {
    result = await resumeCodexTask(account, schedule.threadId, schedule.expectedUpdatedAt);
  } finally {
    release();
  }

  schedule.enabled = false;
  schedule.completedAt = new Date().toISOString();
  schedule.lastStatus = result.status;
  savePreferences(preferences);
  try { onConsumed?.(schedule.id); } catch { /* one-shot runner remains consumed */ }

  log(`scheduled task resume ${schedule.id}: ${result.status} / ${result.action}`);
  const ok = ["completed", "already_running"].includes(result.status);
  return { code: ok ? 0 : 1, result };
}
