import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import * as detect from "../agents/detect.js";
import * as dialogs from "../agents/dialogs.js";
import { which } from "../agents/ping.js";
import * as configmod from "../core/config.js";
import { redactSecrets } from "../core/redact.js";
import { nextOccurrence, parseHhmm, resolveTz } from "../core/timeutil.js";
import { codexAuthStatus, startCodexLogin } from "./account-auth.js";
import { discoverCodexTasks } from "./codex-task-discovery.js";
import { readAccountRateLimitStatus, resumeCodexTask } from "./codex-task-runtime.js";
import { leaseIsLive, writeLease } from "./lease.js";
import { loadPreferences, newAccountProfile as createAccountProfile, savePreferences } from "./preferences.js";
import { WindowsScheduler } from "./scheduler.js";
import { TaskResumeScheduler } from "./task-resume-scheduler.js";
import type { AccountAuthStatus, AccountProfile, AccountRateLimitStatus, AppSnapshot, DoctorCheck, GuiPreferences, SavePayload, TaskInventorySnapshot, TaskResumeResult } from "./types.js";
import { BUILD_IDENTITY } from "./diagnostics.js";
import type { DiagnosticTrace } from "./diagnostics.js";

function nextPing(preferences: GuiPreferences, config: configmod.Config): string | null {
  if (!preferences.schedulerEnabled) return null;
  const tz = resolveTz(config.timezone || null);
  const now = new Date();
  const candidates = preferences.accounts.flatMap((account) => account.enabled
    ? account.schedules.map((entry) => parseHhmm(entry)).filter((entry): entry is [number, number] => entry !== null)
    : []);
  if (!candidates.length) return null;
  return candidates
    .map(([hour, minute]) => nextOccurrence(now, hour, minute, tz))
    .sort((a, b) => a.getTime() - b.getTime())[0]!.toISOString();
}

function missingProfileStatus(accountId: string): AccountAuthStatus {
  return { accountId, state: "profile_missing", detail: "Account profile was not found. Save changes and try again." };
}

export class GuiService {
  constructor(
    private readonly scheduler: WindowsScheduler,
    private readonly taskResumeScheduler: TaskResumeScheduler,
    private readonly version: string,
    private readonly trace?: DiagnosticTrace,
  ) {}

  snapshot(): AppSnapshot {
    this.trace?.emit("START_05_CONFIG_LOAD_BEGIN", "main");
    const config = configmod.load();
    this.trace?.emit("START_06_CONFIG_LOAD_END", "main");
    const preferences = loadPreferences(config);
    this.trace?.emit("START_07_AGENT_DISCOVERY_BEGIN", "main");
    const agents = { claude: which("claude"), codex: which("codex") };
    this.trace?.emit("START_08_AGENT_DISCOVERY_END", "main", {
      claudeFound: Boolean(agents.claude), codexFound: Boolean(agents.codex),
    });
    this.trace?.emit("START_09_SCHEDULER_STATUS_BEGIN", "main");
    const scheduler = this.scheduler.status();
    this.trace?.emit("START_10_SCHEDULER_STATUS_END", "main", { taskCount: scheduler.length });
    return {
      config,
      preferences,
      configPath: configmod.configPath(),
      logPath: configmod.logPath(),
      armed: leaseIsLive(),
      nextPing: nextPing(preferences, config),
      agents,
      scheduler,
      version: this.version,
      buildIdentity: BUILD_IDENTITY,
    };
  }

  save(payload: SavePayload): AppSnapshot {
    const primary = payload.preferences.accounts.find((account) => account.enabled) ?? payload.preferences.accounts[0];
    payload.config.ping.enabled = payload.preferences.schedulerEnabled;
    if (primary) {
      payload.config.ping.agent = primary.agent;
      payload.config.ping.message = primary.message;
      payload.config.ping.times = [...primary.schedules];
      payload.config.ping.catchup_minutes = primary.catchupMinutes ?? payload.config.ping.catchup_minutes;
    }
    configmod.save(payload.config);
    const resumableAccounts = new Set(
      payload.preferences.accounts
        .filter((account) => account.enabled && account.agent === "codex" && Boolean(account.codexHome))
        .map((account) => account.id),
    );
    payload.preferences.taskResumeSchedules = payload.preferences.taskResumeSchedules
      .filter((schedule) => resumableAccounts.has(schedule.accountId));
    savePreferences(payload.preferences);
    this.taskResumeScheduler.sync(payload.preferences.taskResumeSchedules);
    if (payload.preferences.schedulerEnabled) {
      this.scheduler.install(payload.preferences.accounts);
      writeLease(true);
    } else {
      this.scheduler.prune(payload.preferences.accounts);
      this.scheduler.setEnabled(false);
      writeLease(false);
    }
    return this.snapshot();
  }

  setScheduler(enabled: boolean): AppSnapshot {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    preferences.schedulerEnabled = enabled;
    savePreferences(preferences);
    if (enabled) {
      this.scheduler.install(preferences.accounts);
      writeLease(true);
    } else {
      this.scheduler.setEnabled(false);
      writeLease(false);
    }
    return this.snapshot();
  }

  newAccountProfile(): AccountProfile {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    return createAccountProfile(config, preferences.accounts);
  }

  async taskInventory(): Promise<TaskInventorySnapshot> {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    return await discoverCodexTasks(preferences.accounts);
  }

  async resumeTask(accountId: string, threadId: string, expectedUpdatedAt: number | null): Promise<TaskResumeResult> {
    const preferences = loadPreferences(configmod.load());
    const account = preferences.accounts.find((entry) =>
      entry.id === accountId && entry.enabled && entry.agent === "codex" && Boolean(entry.codexHome));
    if (!account) {
      return {
        accountId,
        threadId,
        action: "abort",
        status: "rejected",
        detail: "The selected Codex account profile is unavailable or disabled.",
        turnId: null,
      };
    }
    return await resumeCodexTask(account, threadId, expectedUpdatedAt);
  }

  async getAccountRateLimitStatus(accountId: string): Promise<AccountRateLimitStatus> {
    const preferences = loadPreferences(configmod.load());
    const account = preferences.accounts.find((entry) =>
      entry.id === accountId && entry.enabled && entry.agent === "codex" && Boolean(entry.codexHome));
    if (!account) throw new Error("The selected Codex account profile is unavailable or disabled.");
    return await readAccountRateLimitStatus(account);
  }

  async scheduleTaskResume(
    accountId: string,
    threadId: string,
    title: string,
    runAt: string,
    expectedUpdatedAt: number | null,
  ): Promise<AppSnapshot> {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    const account = preferences.accounts.find((entry) =>
      entry.id === accountId && entry.enabled && entry.agent === "codex" && Boolean(entry.codexHome));
    if (!account) throw new Error("The selected Codex account profile is unavailable or disabled.");

    const when = new Date(runAt);
    const now = Date.now();
    if (!Number.isFinite(when.getTime()) || when.getTime() < now + 15_000 || when.getTime() > now + 90 * 24 * 60 * 60 * 1000) {
      throw new Error("Resume time must be between 15 seconds and 90 days from now.");
    }

    const inventory = await discoverCodexTasks([account]);
    const owned = inventory.items.find((item) =>
      item.source === "account" && item.accountId === accountId && item.id === threadId);
    if (!owned) throw new Error("The task is not present in the selected account's isolated Codex store.");

    const schedule = {
      id: `resume-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      accountId,
      threadId,
      title: String(title || owned.title || "Codex task").slice(0, 240),
      runAt: when.toISOString(),
      expectedUpdatedAt,
      wakePc: account.wakePc === true,
      enabled: true,
      createdAt: new Date().toISOString(),
      completedAt: null,
      lastStatus: null,
    };
    preferences.taskResumeSchedules.push(schedule);
    savePreferences(preferences);
    try {
      this.taskResumeScheduler.sync(preferences.taskResumeSchedules);
    } catch (error) {
      preferences.taskResumeSchedules = preferences.taskResumeSchedules.filter((entry) => entry.id !== schedule.id);
      savePreferences(preferences);
      try { this.taskResumeScheduler.sync(preferences.taskResumeSchedules); } catch { /* preserve original scheduler error */ }
      throw error;
    }
    return this.snapshot();
  }

  cancelTaskResumeSchedule(scheduleId: string): AppSnapshot {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    const schedule = preferences.taskResumeSchedules.find((entry) => entry.id === scheduleId);
    if (!schedule) return this.snapshot();
    this.taskResumeScheduler.cancel(scheduleId);
    preferences.taskResumeSchedules = preferences.taskResumeSchedules.filter((entry) => entry.id !== scheduleId);
    savePreferences(preferences);
    return this.snapshot();
  }

  async getAccountAuthStatus(accountId: string): Promise<AccountAuthStatus> {
    const config = configmod.load();
    const account = loadPreferences(config).accounts.find((entry) => entry.id === accountId);
    if (!account) return missingProfileStatus(accountId);
    return await codexAuthStatus(account);
  }

  async connectAccount(accountId: string): Promise<AccountAuthStatus> {
    const config = configmod.load();
    const account = loadPreferences(config).accounts.find((entry) => entry.id === accountId);
    if (!account) return missingProfileStatus(accountId);
    const result = await startCodexLogin(account);
    this.trace?.emit("ACCOUNT_LOGIN_REQUESTED", "main", { accountId, state: result.state });
    return result;
  }

  doctor(): DoctorCheck[] {
    const config = configmod.load();
    const tz = resolveTz(config.timezone || null);
    const now = new Date();
    const limitHits = detect.SAMPLES.filter((sample) => detect.scan(detect.normalize(sample), now, tz)).length;
    const dialogHits = dialogs.SAMPLES.filter((sample) => dialogs.find(detect.normalize(sample.text))?.key === sample.key).length;
    return [
      { name: "Limit detector", ok: limitHits === detect.SAMPLES.length, detail: `${limitHits}/${detect.SAMPLES.length} samples` },
      { name: "Blocking dialogs", ok: dialogHits === dialogs.SAMPLES.length, detail: `${dialogHits}/${dialogs.SAMPLES.length} samples` },
      { name: "Claude", ok: Boolean(which("claude")), detail: which("claude") ?? "Not found on PATH" },
      { name: "Codex", ok: Boolean(which("codex")), detail: which("codex") ?? "Not found on PATH" },
      { name: "GUI lease", ok: leaseIsLive(), detail: leaseIsLive() ? "Live and armed" : "Disarmed or stale" },
    ];
  }

  readLog(): string {
    try {
      const text = readFileSync(configmod.logPath(), "utf8");
      return redactSecrets(text.slice(-200_000));
    } catch {
      return "No log entries yet.";
    }
  }
}
