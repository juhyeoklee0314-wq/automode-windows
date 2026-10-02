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
import {
  activeAccountStore,
  activeAccountTargets,
  findAccountTarget,
  loadPreferences,
  newAccountProfile as createAccountProfile,
  newAccountStore as createAccountStore,
  runnableAccountTargets,
  runnableTaskResumeSchedules,
  savePreferences,
} from "./preferences.js";
import { WindowsScheduler } from "./scheduler.js";
import { TaskResumeScheduler } from "./task-resume-scheduler.js";
import type {
  AccountActivationResult,
  AccountAuthStatus,
  AccountProfile,
  AccountRateLimitStatus,
  AccountStore,
  AppSnapshot,
  DoctorCheck,
  GuiPreferences,
  SavePayload,
  TaskInventorySnapshot,
  TaskResumeResult,
} from "./types.js";
import { BUILD_IDENTITY } from "./diagnostics.js";
import type { DiagnosticTrace } from "./diagnostics.js";

function nextPing(preferences: GuiPreferences, config: configmod.Config): string | null {
  if (!preferences.schedulerEnabled) return null;
  const tz = resolveTz(config.timezone || null);
  const now = new Date();
  const candidates = runnableAccountTargets(preferences).flatMap((account) =>
    account.schedules.map((entry) => parseHhmm(entry)).filter((entry): entry is [number, number] => entry !== null));
  if (!candidates.length) return null;
  return candidates
    .map(([hour, minute]) => nextOccurrence(now, hour, minute, tz))
    .sort((a, b) => a.getTime() - b.getTime())[0]!.toISOString();
}

function missingProfileStatus(accountId: string): AccountAuthStatus {
  return { accountId, storeId: null, state: "profile_missing", detail: "Account profile was not found. Save changes and try again." };
}

function missingStoreStatus(accountId: string, storeId?: string | null): AccountAuthStatus {
  return {
    accountId,
    storeId: storeId ?? null,
    state: "store_missing",
    detail: "Account store was not found. Refresh PingGPT and try again.",
  };
}

export function expireMissedTaskResumeSchedulesForStore(
  preferences: GuiPreferences,
  profileId: string,
  storeId: string,
  now = new Date(),
): number {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return 0;
  const completedAt = now.toISOString();
  let expired = 0;
  for (const schedule of preferences.taskResumeSchedules) {
    if (!schedule.enabled || schedule.profileId !== profileId || schedule.storeId !== storeId) continue;
    const runAt = new Date(schedule.runAt).getTime();
    if (!Number.isFinite(runAt) || runAt > nowMs) continue;
    schedule.enabled = false;
    schedule.completedAt = completedAt;
    schedule.lastStatus = "rejected";
    expired += 1;
  }
  return expired;
}

export class GuiService {
  constructor(
    private readonly scheduler: WindowsScheduler,
    private readonly taskResumeScheduler: TaskResumeScheduler,
    private readonly version: string,
    private readonly trace?: DiagnosticTrace,
  ) {}

  private reconcile(preferences: GuiPreferences): void {
    this.taskResumeScheduler.sync(runnableTaskResumeSchedules(preferences));
    if (preferences.schedulerEnabled) {
      this.scheduler.install(runnableAccountTargets(preferences));
      writeLease(true);
    } else {
      this.scheduler.prune(runnableAccountTargets(preferences));
    }
  }

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
    payload.preferences.schemaVersion = 2;
    payload.config.ping.enabled = payload.preferences.schedulerEnabled;

    const primary = runnableAccountTargets(payload.preferences)[0]
      ?? activeAccountTargets(payload.preferences).find((target) => target.enabled)
      ?? activeAccountTargets(payload.preferences)[0];

    if (primary) {
      payload.config.ping.agent = primary.agent;
      payload.config.ping.message = primary.message;
      payload.config.ping.times = [...primary.schedules];
      payload.config.ping.catchup_minutes = primary.catchupMinutes ?? payload.config.ping.catchup_minutes;
    }

    configmod.save(payload.config);
    savePreferences(payload.preferences);
    this.reconcile(payload.preferences);
    if (!payload.preferences.schedulerEnabled) {
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
      this.scheduler.install(runnableAccountTargets(preferences));
      this.taskResumeScheduler.sync(runnableTaskResumeSchedules(preferences));
      writeLease(true);
    } else {
      this.scheduler.setEnabled(false);
      this.taskResumeScheduler.sync([]);
      writeLease(false);
    }
    return this.snapshot();
  }

  newAccountProfile(): AccountProfile {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    return createAccountProfile(config, preferences.accounts);
  }

  newAccountStore(profileId: string): AccountStore {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    const profile = preferences.accounts.find((entry) => entry.id === profileId);
    if (!profile) throw new Error("Account profile was not found.");
    const store = createAccountStore(config, profile);
    profile.stores.push(store);
    savePreferences(preferences);
    return store;
  }

  async taskInventory(): Promise<TaskInventorySnapshot> {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    return await discoverCodexTasks(activeAccountTargets(preferences));
  }

  async resumeTask(
    profileId: string,
    storeId: string,
    threadId: string,
    expectedUpdatedAt: number | null,
  ): Promise<TaskResumeResult> {
    const preferences = loadPreferences(configmod.load());
    const profile = preferences.accounts.find((entry) => entry.id === profileId && entry.enabled);
    const account = findAccountTarget(preferences, profileId, storeId);
    if (
      !profile
      || !account
      || profile.activeStoreId !== storeId
      || account.agent !== "codex"
      || account.bindingState !== "ready"
    ) {
      return {
        accountId: profileId,
        storeId,
        threadId,
        action: "abort",
        status: "rejected",
        detail: "The selected Codex account store is unavailable, inactive, or not verified.",
        turnId: null,
      };
    }
    return await resumeCodexTask(account, threadId, expectedUpdatedAt);
  }

  async getAccountRateLimitStatus(profileId: string, storeId: string): Promise<AccountRateLimitStatus> {
    const preferences = loadPreferences(configmod.load());
    const profile = preferences.accounts.find((entry) => entry.id === profileId && entry.enabled);
    const account = findAccountTarget(preferences, profileId, storeId);
    if (
      !profile
      || !account
      || profile.activeStoreId !== storeId
      || account.agent !== "codex"
      || account.bindingState !== "ready"
    ) {
      throw new Error("The selected Codex account store is unavailable, inactive, or not verified.");
    }
    return await readAccountRateLimitStatus(account);
  }

  async scheduleTaskResume(
    profileId: string,
    storeId: string,
    threadId: string,
    title: string,
    runAt: string,
    expectedUpdatedAt: number | null,
  ): Promise<AppSnapshot> {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    const profile = preferences.accounts.find((entry) => entry.id === profileId && entry.enabled);
    const account = findAccountTarget(preferences, profileId, storeId);
    if (
      !profile
      || !account
      || profile.activeStoreId !== storeId
      || account.agent !== "codex"
      || account.bindingState !== "ready"
    ) {
      throw new Error("The selected Codex account store is unavailable, inactive, or not verified.");
    }

    const when = new Date(runAt);
    const now = Date.now();
    if (!Number.isFinite(when.getTime()) || when.getTime() < now + 15_000 || when.getTime() > now + 90 * 24 * 60 * 60 * 1000) {
      throw new Error("Resume time must be between 15 seconds and 90 days from now.");
    }

    const inventory = await discoverCodexTasks([account]);
    const owned = inventory.items.find((item) =>
      item.source === "account"
      && item.accountId === profileId
      && item.storeId === storeId
      && item.id === threadId);
    if (!owned) throw new Error("The task is not present in the selected account store.");

    const schedule = {
      id: `resume-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      profileId,
      storeId,
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
      this.taskResumeScheduler.sync(runnableTaskResumeSchedules(preferences));
    } catch (error) {
      preferences.taskResumeSchedules = preferences.taskResumeSchedules.filter((entry) => entry.id !== schedule.id);
      savePreferences(preferences);
      try { this.taskResumeScheduler.sync(runnableTaskResumeSchedules(preferences)); } catch { /* preserve original scheduler error */ }
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
    this.taskResumeScheduler.sync(runnableTaskResumeSchedules(preferences));
    return this.snapshot();
  }

  async getAccountAuthStatus(profileId: string, storeId?: string | null): Promise<AccountAuthStatus> {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    const profile = preferences.accounts.find((entry) => entry.id === profileId);
    if (!profile) return missingProfileStatus(profileId);
    const account = findAccountTarget(preferences, profileId, storeId);
    if (!account) return missingStoreStatus(profileId, storeId);
    const status = await codexAuthStatus(account);
    return { ...status, bindingState: account.bindingState };
  }

  async connectAccount(profileId: string, storeId?: string | null): Promise<AccountAuthStatus> {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    const profile = preferences.accounts.find((entry) => entry.id === profileId);
    if (!profile) return missingProfileStatus(profileId);
    const account = findAccountTarget(preferences, profileId, storeId);
    if (!account) return missingStoreStatus(profileId, storeId);
    const result = await startCodexLogin(account);
    this.trace?.emit("ACCOUNT_LOGIN_REQUESTED", "main", {
      profileId,
      storeId: account.storeId,
      state: result.state,
    });
    return result;
  }

  async activateAccountStore(profileId: string, storeId: string): Promise<AccountActivationResult> {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    const profile = preferences.accounts.find((entry) => entry.id === profileId);
    if (!profile) {
      const status = missingProfileStatus(profileId);
      return { ok: false, activeStoreId: null, status, snapshot: this.snapshot() };
    }

    const store = profile.stores.find((entry) => entry.id === storeId);
    const account = findAccountTarget(preferences, profileId, storeId);
    if (!store || !account) {
      const status = missingStoreStatus(profileId, storeId);
      return { ok: false, activeStoreId: profile.activeStoreId, status, snapshot: this.snapshot() };
    }

    if (profile.agent !== "codex") {
      store.bindingState = "ready";
      profile.activeStoreId = store.id;
      savePreferences(preferences);
      try { this.reconcile(preferences); } catch { /* runtime routing remains fail-closed */ }
      const status: AccountAuthStatus = {
        accountId: profileId,
        storeId,
        state: "not_codex",
        detail: "This profile does not require ChatGPT authentication.",
        bindingState: "ready",
      };
      return { ok: true, activeStoreId: store.id, status, snapshot: this.snapshot() };
    }

    const auth = await codexAuthStatus(account);
    if (auth.state !== "connected" || auth.identityVerified !== true || !auth.identityKey) {
      return { ok: false, activeStoreId: profile.activeStoreId, status: auth, snapshot: this.snapshot() };
    }

    if (store.identityKey && store.identityKey !== auth.identityKey) {
      store.bindingState = "account_mismatch";
      savePreferences(preferences);
      const status: AccountAuthStatus = {
        ...auth,
        state: "account_mismatch",
        bindingState: "account_mismatch",
        detail: "The login in this account store does not match the account previously bound to it.",
      };
      return { ok: false, activeStoreId: profile.activeStoreId, status, snapshot: this.snapshot() };
    }

    const inventory = await discoverCodexTasks([account]);
    const state = inventory.accounts.find((entry) =>
      entry.accountId === profileId && entry.storeId === storeId);
    if (!state?.identityVerified || !state.identityKey || state.identityKey !== auth.identityKey) {
      store.bindingState = "unverified";
      savePreferences(preferences);
      const status: AccountAuthStatus = {
        ...auth,
        state: "account_unverified",
        bindingState: "unverified",
        detail: "PingGPT could not independently verify the provider account identity for this store.",
      };
      return { ok: false, activeStoreId: profile.activeStoreId, status, snapshot: this.snapshot() };
    }

    const hasMismatch = inventory.items.some((item) =>
      item.source === "account"
      && item.accountId === profileId
      && item.storeId === storeId
      && item.ownershipStatus === "mismatch");
    if (hasMismatch) {
      const bindingState = store.bindingState === "needs_verification" ? "migration_review" : "account_mismatch";
      store.bindingState = bindingState;
      savePreferences(preferences);
      const status: AccountAuthStatus = {
        ...auth,
        state: bindingState === "migration_review" ? "migration_review" : "account_mismatch",
        bindingState,
        detail: bindingState === "migration_review"
          ? "Existing R1.06 data contains tasks owned by another account. Automatic migration is blocked."
          : "This store contains a task owned by another ChatGPT account. Execution is blocked.",
      };
      return { ok: false, activeStoreId: profile.activeStoreId, status, snapshot: this.snapshot() };
    }

    const duplicate = profile.stores.find((entry) =>
      entry.id !== store.id && entry.identityKey === auth.identityKey);
    if (duplicate) {
      const status: AccountAuthStatus = {
        ...auth,
        storeId: duplicate.id,
        state: "not_connected",
        bindingState: duplicate.bindingState,
        detail: "This ChatGPT account already has a stored account context. Reconnect that stored account instead of creating a duplicate.",
      };
      return { ok: false, activeStoreId: profile.activeStoreId, status, snapshot: this.snapshot() };
    }

    const previousActiveStoreId = profile.activeStoreId;
    store.identityKey = auth.identityKey;
    store.lastKnownEmail = auth.email ?? store.lastKnownEmail;
    store.planType = auth.planType ?? store.planType;
    store.bindingState = "ready";
    if (previousActiveStoreId !== store.id) {
      expireMissedTaskResumeSchedulesForStore(preferences, profileId, store.id);
    }
    profile.activeStoreId = store.id;
    savePreferences(preferences);

    let reconcileWarning = "";
    try {
      this.reconcile(preferences);
    } catch (error) {
      reconcileWarning = ` Scheduler reconciliation needs retry: ${String((error as { message?: unknown })?.message ?? error)}`;
      this.trace?.emit("ACCOUNT_STORE_RECONCILE_FAILED", "main", { profileId, storeId });
    }

    const status: AccountAuthStatus = {
      ...auth,
      storeId: store.id,
      state: "connected",
      bindingState: "ready",
      detail: `Account store verified and activated.${reconcileWarning}`,
    };
    return { ok: true, activeStoreId: store.id, status, snapshot: this.snapshot() };
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
