import * as configmod from "../core/config.js";
import { createLogger } from "../core/log.js";
import { State } from "../core/state.js";
import { parseHhmm, resolveTz, wallClockAt } from "../core/timeutil.js";
import { acquireExecutionLock, activeExecutionLockCount, leaseIsLive } from "./lease.js";
import { loadPreferences } from "./preferences.js";
import { recentlyResumedFromSuspend } from "./power-state.js";
import { reliablePing } from "./reliable-ping.js";
import { which } from "../platform/command.js";
import type { DiagnosticTrace } from "./diagnostics.js";
import type { AccountProfile, GuiPreferences } from "./types.js";

const WAKE_LEASE_WAIT_MS = 15_000;
const WAKE_CORRELATION_MINUTES = 15;
const RETURN_TO_SLEEP_GRACE_MS = 15_000;
const IDLE_TOLERANCE_SECONDS = 3;

export interface ScheduledRuntime {
  isOnBatteryPower?: () => boolean;
  getSystemIdleTime?: () => number;
  requestSleep?: () => boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function dateKey(now: Date, timezone: string): string {
  const wall = wallClockAt(now, timezone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

function elapsedMinutes(hour: number, minute: number, scheduledHour: number, scheduledMinute: number): number {
  let elapsed = hour * 60 + minute - (scheduledHour * 60 + scheduledMinute);
  if (elapsed < 0) elapsed += 24 * 60;
  return elapsed;
}

export function accountPingEnvironment(account: AccountProfile): NodeJS.ProcessEnv | undefined {
  if (account.agent !== "codex" || !account.codexHome) return undefined;
  return { CODEX_HOME: account.codexHome };
}

export function accountPingUnsetEnvironment(account: AccountProfile): string[] {
  if (account.agent !== "codex" || !account.codexHome) return [];
  return ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"];
}

export function accountCatchupMinutes(account: AccountProfile, config: configmod.Config): number {
  const candidate = Number(account.catchupMinutes);
  if (Number.isFinite(candidate)) return Math.max(0, Math.min(180, Math.round(candidate)));
  return Math.max(0, Math.min(180, Math.round(config.ping.catchup_minutes)));
}

export function elapsedMinutesForSchedule(now: Date, timezone: string, time: string): number | null {
  const parsed = parseHhmm(time);
  if (!parsed) return null;
  const wall = wallClockAt(now, timezone);
  return elapsedMinutes(wall.hour, wall.minute, parsed[0], parsed[1]);
}

function wakeBatchDue(
  preferences: GuiPreferences,
  config: configmod.Config,
  now: Date,
  timezone: string,
): boolean {
  for (const candidate of preferences.accounts) {
    if (!candidate.enabled || candidate.wakePc !== true) continue;
    const limit = Math.min(accountCatchupMinutes(candidate, config), WAKE_CORRELATION_MINUTES);
    for (const time of candidate.schedules) {
      const elapsed = elapsedMinutesForSchedule(now, timezone, time);
      if (elapsed !== null && elapsed >= 0 && elapsed <= limit) return true;
    }
  }
  return false;
}

async function waitForLiveLease(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (leaseIsLive()) return true;
    await sleep(500);
  } while (Date.now() < deadline);
  return leaseIsLive();
}

function readIdle(runtime: ScheduledRuntime): number | null {
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
  runtime: ScheduledRuntime,
  log: ReturnType<typeof createLogger>,
  trace?: DiagnosticTrace,
): Promise<void> {
  if (!shouldReturn || idleBaseline === null || !runtime.requestSleep || !runtime.getSystemIdleTime) return;

  if (activeExecutionLockCount() > 0) {
    trace?.emit("PING_POWER_SLEEP_DEFERRED_ACTIVE_RUNNER", "scheduled");
    return;
  }

  await sleep(RETURN_TO_SLEEP_GRACE_MS);

  if (activeExecutionLockCount() > 0) {
    trace?.emit("PING_POWER_SLEEP_CANCELLED_ACTIVE_RUNNER", "scheduled");
    return;
  }

  const idleNow = readIdle(runtime);
  if (idleNow === null) {
    trace?.emit("PING_POWER_SLEEP_CANCELLED_IDLE_UNKNOWN", "scheduled");
    return;
  }

  const elapsedSeconds = Math.max(0, (Date.now() - idleBaselineAt) / 1000);
  const idleGrowth = idleNow - idleBaseline;
  if (idleGrowth + IDLE_TOLERANCE_SECONDS < elapsedSeconds) {
    log("scheduled ping: user activity detected after wake; automatic return to sleep cancelled");
    trace?.emit("PING_POWER_SLEEP_CANCELLED_USER_ACTIVE", "scheduled", { idleNow, idleBaseline, elapsedSeconds });
    return;
  }

  const requested = runtime.requestSleep();
  trace?.emit(requested ? "PING_POWER_SLEEP_REQUESTED" : "PING_POWER_SLEEP_REQUEST_FAILED", "scheduled");
  if (!requested) log("scheduled ping: automatic return-to-sleep request failed");
}

export async function runScheduled(
  accountId: string,
  scheduleId: string,
  now = new Date(),
  trace?: DiagnosticTrace,
  runtime: ScheduledRuntime = {},
): Promise<number> {
  const log = createLogger();
  trace?.emit("PING_01_RUNNER_ENTER", "scheduled", { accountId, scheduleId });

  const config = configmod.load();
  const preferences = loadPreferences(config);
  if (!preferences.schedulerEnabled) return 75;

  const account = preferences.accounts.find((entry) => entry.id === accountId && entry.enabled);
  if (!account) return 64;

  const index = Number(scheduleId.split("-").at(-1));
  const time = account.schedules[index];
  const parsed = time ? parseHhmm(time) : null;
  if (!parsed) return 64;

  const timezone = resolveTz(config.timezone || null);
  const wall = wallClockAt(now, timezone);
  const elapsed = elapsedMinutes(wall.hour, wall.minute, parsed[0], parsed[1]);
  const catchupMinutes = accountCatchupMinutes(account, config);
  const dueWakeBatch = wakeBatchDue(preferences, config, now, timezone);

  if (runtime.isOnBatteryPower?.()) {
    trace?.emit("PING_POWER_BATTERY_REJECTED", "scheduled");
    log("scheduled ping refused: system is running on battery power");
    return 75;
  }

  let liveLease = leaseIsLive();
  if (!liveLease && dueWakeBatch) {
    trace?.emit("PING_02_LEASE_WAIT_AFTER_WAKE", "scheduled");
    liveLease = await waitForLiveLease(WAKE_LEASE_WAIT_MS);
  }
  if (!liveLease) {
    trace?.emit("PING_02_LEASE_REJECTED", "scheduled");
    log("scheduled ping refused: GUI lease is absent, stale, disarmed, or owner process is not alive");
    return 75;
  }
  trace?.emit("PING_02_LEASE_ACCEPTED", "scheduled");

  if (elapsed > catchupMinutes) {
    log(`scheduled ping refused: outside catch-up window (${elapsed} minutes; account limit ${catchupMinutes})`);
    return 75;
  }

  const wokeForPingBatch = dueWakeBatch && recentlyResumedFromSuspend(Date.now(), 180_000);
  const idleBaselineAt = Date.now();
  const idleBaseline = wokeForPingBatch ? readIdle(runtime) : null;
  trace?.emit("PING_POWER_CONTEXT", "scheduled", {
    wakeEnabled: account.wakePc === true,
    dueWakeBatch,
    wokeForPingBatch,
    idleBaselineKnown: idleBaseline !== null,
  });

  const scheduledReference = new Date(now.getTime() - elapsed * 60_000);
  const identity = `${account.id}-${dateKey(scheduledReference, timezone)}-${scheduleId}`;
  const state = new State();

  if (state.pingFired(identity)) {
    trace?.emit("PING_05_DEDUPE_HIT", "scheduled", { identity });
    await maybeReturnToSleep(wokeForPingBatch, idleBaseline, idleBaselineAt, runtime, log, trace);
    return 0;
  }

  const release = acquireExecutionLock(identity);
  if (!release) {
    trace?.emit("PING_06_LOCK_REJECTED", "scheduled", { identity });
    log(`scheduled ping refused: concurrent execution ${identity}`);
    return 75;
  }
  trace?.emit("PING_06_LOCK_ACQUIRED", "scheduled", { identity });

  let code = 1;
  try {
    if (state.pingFired(identity)) {
      code = 0;
    } else {
      const env = accountPingEnvironment(account);
      const unsetEnv = accountPingUnsetEnvironment(account);
      trace?.emit("PING_07_PROFILE_SELECTED", "scheduled", {
        agent: account.agent,
        codexHomeMode: account.codexHome ? "account" : process.env.CODEX_HOME ? "inherited" : "default",
        catchupMinutes,
      });
      code = await reliablePing(account.agent, account.message, log, {
        env,
        unsetEnv,
        networkTimeoutMs: wokeForPingBatch ? 60_000 : 10_000,
        onResolved: (path) => trace?.emit("PING_08_EXECUTABLE_RESOLVED", "scheduled", { agent: account.agent, path }),
      });
      if (code === 0) {
        state.markPing(identity);
        trace?.emit("PING_10_DEDUPE_COMMITTED", "scheduled", { identity, successSignal: "process_exit_0" });
      } else {
        trace?.emit("PING_10_FAILURE_NOT_COMMITTED", "scheduled", { identity, code });
      }
    }
  } finally {
    release();
    trace?.emit("PING_11_LOCK_RELEASED", "scheduled", { identity });
  }

  await maybeReturnToSleep(wokeForPingBatch, idleBaseline, idleBaselineAt, runtime, log, trace);
  return code;
}

/** Exercise the critical routing and eligibility path without sending or committing production state. */
export async function runScheduledDryRun(
  accountId: string,
  scheduleId: string,
  now = new Date(),
  trace?: DiagnosticTrace,
): Promise<number> {
  trace?.emit("PING_DRY_01_RUNNER_ENTER", "dry_run", { accountId, scheduleId });
  const config = configmod.load();
  const preferences = loadPreferences(config);
  const account = preferences.accounts.find((entry) => entry.id === accountId && entry.enabled);
  if (!account) {
    trace?.emit("PING_DRY_02_ACCOUNT_REJECTED", "dry_run", { accountId });
    return 64;
  }
  const index = Number(scheduleId.split("-").at(-1));
  const time = account.schedules[index];
  const parsed = time ? parseHhmm(time) : null;
  if (!parsed) {
    trace?.emit("PING_DRY_03_SCHEDULE_REJECTED", "dry_run", { scheduleId });
    return 64;
  }

  const timezone = resolveTz(config.timezone || null);
  const wall = wallClockAt(now, timezone);
  const elapsed = elapsedMinutes(wall.hour, wall.minute, parsed[0], parsed[1]);
  const catchupMinutes = accountCatchupMinutes(account, config);
  const scheduledReference = new Date(now.getTime() - elapsed * 60_000);
  const identity = `${account.id}-${dateKey(scheduledReference, timezone)}-${scheduleId}`;
  const state = new State();
  trace?.emit("PING_DRY_04_GATES_OBSERVED", "dry_run", {
    leaseLive: leaseIsLive(),
    catchupEligible: elapsed <= catchupMinutes,
    catchupMinutes,
    alreadyCommitted: state.pingFired(identity),
    timezone,
  });

  const release = acquireExecutionLock(identity, "phase6-dry-run");
  if (!release) {
    trace?.emit("PING_DRY_05_LOCK_REJECTED", "dry_run", { identity });
    return 75;
  }
  try {
    trace?.emit("PING_DRY_05_LOCK_ACQUIRED", "dry_run", { identity });
    const resolved = which(account.agent);
    trace?.emit(resolved ? "PING_DRY_06_EXECUTABLE_RESOLVED" : "PING_DRY_06_EXECUTABLE_MISSING", "dry_run", {
      agent: account.agent,
      path: resolved ?? "",
      codexHomeMode: account.codexHome ? "account" : process.env.CODEX_HOME ? "inherited" : "default",
      wakePc: account.wakePc === true,
    });
    trace?.emit("PING_DRY_07_NO_SEND_NO_COMMIT", "dry_run", { identity });
    return resolved ? 0 : 127;
  } finally {
    release();
    trace?.emit("PING_DRY_08_LOCK_RELEASED", "dry_run", { identity });
  }
}
