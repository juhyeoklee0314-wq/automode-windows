import * as configmod from "../core/config.js";
import { createLogger } from "../core/log.js";
import { acquireExecutionLock, activeExecutionLockCount } from "./lease.js";
import { recentlyResumedFromSuspend } from "./power-state.js";
import { findAccountTarget, loadPreferences, savePreferences } from "./preferences.js";
import { resumeCodexTask } from "./codex-task-runtime.js";
import type { TaskResumeResult } from "./types.js";

const MAX_CATCHUP_MS = 180 * 60 * 1000;
const EARLY_TOLERANCE_MS = 60 * 1000;
const RETURN_TO_SLEEP_GRACE_MS = 15_000;
const IDLE_TOLERANCE_SECONDS = 3;

export interface ScheduledTaskResumeRuntime {
  isOnBatteryPower?: () => boolean;
  getSystemIdleTime?: () => number;
  requestSleep?: () => boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readIdle(runtime: ScheduledTaskResumeRuntime): number | null {
  try {
    const value = runtime.getSystemIdleTime?.();
    return Number.isFinite(value) ? Math.max(0, Number(value)) : null;
  } catch {
    return null;
  }
}

async function maybeReturnToSleep(
  shouldReturn: boolean,
  idleBaseline: number | null,
  idleBaselineAt: number,
  runtime: ScheduledTaskResumeRuntime,
): Promise<void> {
  if (!shouldReturn || idleBaseline === null || !runtime.requestSleep || !runtime.getSystemIdleTime) return;
  if (activeExecutionLockCount() > 0) return;
  await sleep(RETURN_TO_SLEEP_GRACE_MS);
  if (activeExecutionLockCount() > 0) return;
  const idleNow = readIdle(runtime);
  if (idleNow === null) return;
  const elapsedSeconds = Math.max(0, (Date.now() - idleBaselineAt) / 1000);
  const idleGrowth = idleNow - idleBaseline;
  if (idleGrowth + IDLE_TOLERANCE_SECONDS < elapsedSeconds) return;
  runtime.requestSleep();
}

export interface ScheduledTaskResumeOutcome {
  code: number;
  result: TaskResumeResult | null;
}

export async function runScheduledTaskResume(
  scheduleId: string,
  now = new Date(),
  onConsumed?: (scheduleId: string) => void,
  runtime: ScheduledTaskResumeRuntime = {},
): Promise<ScheduledTaskResumeOutcome> {
  const log = createLogger();
  const config = configmod.load();
  const preferences = loadPreferences(config);
  const schedule = preferences.taskResumeSchedules.find((entry) => entry.id === scheduleId && entry.enabled);
  if (!schedule) return { code: 64, result: null };

  if (runtime.isOnBatteryPower?.()) return { code: 75, result: null };

  const dueAt = new Date(schedule.runAt).getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(dueAt)) return { code: 64, result: null };
  if (nowMs + EARLY_TOLERANCE_MS < dueAt) return { code: 75, result: null };

  const wokeForResume = schedule.wakePc === true && recentlyResumedFromSuspend(Date.now(), 180_000);
  const idleBaselineAt = Date.now();
  const idleBaseline = wokeForResume ? readIdle(runtime) : null;

  if (nowMs - dueAt > MAX_CATCHUP_MS) {
    schedule.enabled = false;
    schedule.completedAt = now.toISOString();
    schedule.lastStatus = "rejected";
    savePreferences(preferences);
    onConsumed?.(schedule.id);
    log(`scheduled task resume expired without execution: ${schedule.id}`);
    await maybeReturnToSleep(wokeForResume, idleBaseline, idleBaselineAt, runtime);
    return { code: 75, result: null };
  }

  const profile = preferences.accounts.find((entry) => entry.id === schedule.profileId && entry.enabled);
  const account = findAccountTarget(preferences, schedule.profileId, schedule.storeId);
  if (!profile || !account) {
    schedule.enabled = false;
    schedule.completedAt = now.toISOString();
    schedule.lastStatus = "rejected";
    savePreferences(preferences);
    onConsumed?.(schedule.id);
    await maybeReturnToSleep(wokeForResume, idleBaseline, idleBaselineAt, runtime);
    return { code: 64, result: null };
  }

  // Inactive account stores keep their one-shot reservation, but a stale Windows
  // trigger can never execute them. Reactivation may reinstall it if still future-dated.
  if (
    profile.activeStoreId !== schedule.storeId
    || account.agent !== "codex"
    || account.bindingState !== "ready"
  ) {
    return { code: 75, result: null };
  }

  const release = acquireExecutionLock(`task-resume-${schedule.id}`);
  if (!release) return { code: 75, result: null };

  let result: TaskResumeResult;
  try {
    result = await resumeCodexTask(account, schedule.threadId, schedule.expectedUpdatedAt);
  } finally {
    release();
  }

  await maybeReturnToSleep(wokeForResume, idleBaseline, idleBaselineAt, runtime);

  schedule.enabled = false;
  schedule.completedAt = new Date().toISOString();
  schedule.lastStatus = result.status;
  savePreferences(preferences);
  try { onConsumed?.(schedule.id); } catch { /* one-shot runner remains consumed */ }

  log(`scheduled task resume ${schedule.id}: ${result.status} / ${result.action}`);
  const ok = ["completed", "already_running"].includes(result.status);
  return { code: ok ? 0 : 1, result };
}
