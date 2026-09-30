import * as configmod from "../core/config.js";
import { createLogger } from "../core/log.js";
import { State } from "../core/state.js";
import { parseHhmm, resolveTz, wallClockAt } from "../core/timeutil.js";
import { acquireExecutionLock, leaseIsLive } from "./lease.js";
import { loadPreferences } from "./preferences.js";
import { reliablePing } from "./reliable-ping.js";
import { which } from "../platform/command.js";
import type { DiagnosticTrace } from "./diagnostics.js";
import type { AccountProfile } from "./types.js";

function dateKey(now: Date, timezone: string): string {
  const wall = wallClockAt(now, timezone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

export function accountPingEnvironment(account: AccountProfile): NodeJS.ProcessEnv | undefined {
  if (account.agent !== "codex" || !account.codexHome) return undefined;
  return { CODEX_HOME: account.codexHome };
}

export async function runScheduled(
  accountId: string,
  scheduleId: string,
  now = new Date(),
  trace?: DiagnosticTrace,
): Promise<number> {
  const log = createLogger();
  trace?.emit("PING_01_RUNNER_ENTER", "scheduled", { accountId, scheduleId });
  if (!leaseIsLive(now.getTime())) {
    trace?.emit("PING_02_LEASE_REJECTED", "scheduled");
    log("scheduled ping refused: GUI lease is absent, stale, disarmed, or owner process is not alive");
    return 75;
  }
  trace?.emit("PING_02_LEASE_ACCEPTED", "scheduled");

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
  const scheduledMinutes = parsed[0] * 60 + parsed[1];
  const elapsed = wall.hour * 60 + wall.minute - scheduledMinutes;
  if (elapsed < 0 || elapsed > Math.max(0, config.ping.catchup_minutes)) {
    log(`scheduled ping refused: outside catch-up window (${elapsed} minutes)`);
    return 75;
  }

  const identity = `${account.id}-${dateKey(now, timezone)}-${scheduleId}`;
  const state = new State();
  if (state.pingFired(identity)) {
    trace?.emit("PING_05_DEDUPE_HIT", "scheduled", { identity });
    return 0;
  }
  const release = acquireExecutionLock(identity);
  if (!release) {
    trace?.emit("PING_06_LOCK_REJECTED", "scheduled", { identity });
    log(`scheduled ping refused: concurrent execution ${identity}`);
    return 75;
  }
  trace?.emit("PING_06_LOCK_ACQUIRED", "scheduled", { identity });
  try {
    if (state.pingFired(identity)) return 0;
    const env = accountPingEnvironment(account);
    trace?.emit("PING_07_PROFILE_SELECTED", "scheduled", {
      agent: account.agent,
      codexHomeMode: account.codexHome ? "account" : process.env.CODEX_HOME ? "inherited" : "default",
    });
    const code = await reliablePing(account.agent, account.message, log, {
      env,
      onResolved: (path) => trace?.emit("PING_08_EXECUTABLE_RESOLVED", "scheduled", { agent: account.agent, path }),
    });
    if (code === 0) {
      state.markPing(identity);
      trace?.emit("PING_10_DEDUPE_COMMITTED", "scheduled", { identity, successSignal: "process_exit_0" });
    } else {
      trace?.emit("PING_10_FAILURE_NOT_COMMITTED", "scheduled", { identity, code });
    }
    return code;
  } finally {
    release();
    trace?.emit("PING_11_LOCK_RELEASED", "scheduled", { identity });
  }
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
  const elapsed = wall.hour * 60 + wall.minute - (parsed[0] * 60 + parsed[1]);
  const identity = `${account.id}-${dateKey(now, timezone)}-${scheduleId}`;
  const state = new State();
  trace?.emit("PING_DRY_04_GATES_OBSERVED", "dry_run", {
    leaseLive: leaseIsLive(now.getTime()),
    catchupEligible: elapsed >= 0 && elapsed <= Math.max(0, config.ping.catchup_minutes),
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
    });
    trace?.emit("PING_DRY_07_NO_SEND_NO_COMMIT", "dry_run", { identity });
    return resolved ? 0 : 127;
  } finally {
    release();
    trace?.emit("PING_DRY_08_LOCK_RELEASED", "dry_run", { identity });
  }
}
