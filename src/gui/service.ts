import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as detect from "../agents/detect.js";
import * as dialogs from "../agents/dialogs.js";
import { which } from "../agents/ping.js";
import * as configmod from "../core/config.js";
import { redactSecrets } from "../core/redact.js";
import { nextOccurrence, parseHhmm, resolveTz } from "../core/timeutil.js";
import { codexAuthStatus, startCodexLogin } from "./account-auth.js";
import { ensureActiveAccountStore, verifyAccountStore } from "./account-store-runtime.js";
import { newAccountStoreId, projectAccountProfileForStore } from "./account-store-model.js";
import { discoverCodexTasks } from "./codex-task-discovery.js";
import { readAccountRateLimitStatus, resumeCodexTask } from "./codex-task-runtime.js";
import { leaseIsLive, writeLease } from "./lease.js";
import {
  activeTaskResumeSchedules,
  codexProfilesRoot,
  loadPreferences,
  newAccountProfile as createAccountProfile,
  saveCanonicalPreferences,
  savePreferences,
} from "./preferences.js";
import { WindowsScheduler } from "./scheduler.js";
import { TaskResumeScheduler } from "./task-resume-scheduler.js";
import type { AccountAuthStatus, AccountProfile, AccountRateLimitStatus, AccountStoreSummary, AppSnapshot, DoctorCheck, GuiPreferences, SavePayload, TaskInventorySnapshot, TaskResumeResult } from "./types.js";
import { BUILD_IDENTITY } from "./diagnostics.js";
import type { DiagnosticTrace } from "./diagnostics.js";

function nextPing(preferences: GuiPreferences, config: configmod.Config): string | null {
  if (!preferences.schedulerEnabled) return null;
  const tz = resolveTz(config.timezone || null);
  const now = new Date();
  const candidates = preferences.accounts.flatMap((account) => {
    const schedulable = account.enabled && (account.agent !== "codex" || (
      Boolean(account.codexHome)
      && account.storeBindingState !== "pending"
      && account.storeBindingState !== "migration_review"
    ));
    return schedulable
      ? account.schedules.map((entry) => parseHhmm(entry)).filter((entry): entry is [number, number] => entry !== null)
      : [];
  });
  if (!candidates.length) return null;
  return candidates
    .map(([hour, minute]) => nextOccurrence(now, hour, minute, tz))
    .sort((a, b) => a.getTime() - b.getTime())[0]!.toISOString();
}

function missingProfileStatus(accountId: string): AccountAuthStatus {
  return { accountId, state: "profile_missing", detail: "Account profile was not found. Save changes and try again." };
}

function accountStoreSummary(preferences: GuiPreferences, profileId: string, storeId: string): AccountStoreSummary | null {
  const profile = preferences.profiles.find((entry) => entry.id === profileId);
  const store = preferences.accountStores.find((entry) => entry.id === storeId && entry.profileId === profileId);
  if (!profile || !store) return null;
  return {
    profileId,
    storeId,
    active: profile.activeStoreId === storeId,
    bindingState: store.bindingState,
    email: store.lastKnownEmail ?? null,
    planType: store.planType ?? null,
  };
}

function accountForStore(preferences: GuiPreferences, profileId: string, storeId: string): AccountProfile | null {
  const profile = preferences.profiles.find((entry) => entry.id === profileId);
  const store = preferences.accountStores.find((entry) => entry.id === storeId && entry.profileId === profileId);
  if (!profile || !store || profile.agent !== "codex") return null;
  return projectAccountProfileForStore(profile, store);
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

    // Background account verification may have advanced canonical store state after
    // the renderer snapshot was created. Rebase user-editable profile fields onto
    // the latest canonical preferences so Save changes cannot write stale store
    // bindings (for example migration_pending over migration_review) back to disk.
    const canonicalPreferences = loadPreferences(configmod.load());
    canonicalPreferences.runAtLogin = payload.preferences.runAtLogin;
    canonicalPreferences.schedulerEnabled = payload.preferences.schedulerEnabled;
    canonicalPreferences.accounts = payload.preferences.accounts;

    const resumableAccounts = new Set(
      canonicalPreferences.accounts
        .filter((account) => account.enabled && account.agent === "codex" && Boolean(account.codexHome))
        .map((account) => account.id),
    );
    canonicalPreferences.taskResumeSchedules = canonicalPreferences.taskResumeSchedules
      .filter((schedule) => resumableAccounts.has(schedule.accountId));

    savePreferences(canonicalPreferences);
    const savedPreferences = loadPreferences(configmod.load());
    this.taskResumeScheduler.sync(activeTaskResumeSchedules(savedPreferences));
    if (savedPreferences.schedulerEnabled) {
      this.scheduler.install(savedPreferences.accounts);
      writeLease(true);
    } else {
      this.scheduler.prune(savedPreferences.accounts);
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
    const verified = await ensureActiveAccountStore(accountId);
    const account = verified.state === "ready" ? verified.account : null;
    if (!account || !account.enabled) {
      return {
        accountId,
        threadId,
        action: "abort",
        status: "rejected",
        detail: verified.detail || "The selected Codex account profile is unavailable or disabled.",
        turnId: null,
      };
    }
    return await resumeCodexTask(account, threadId, expectedUpdatedAt);
  }

  async getAccountRateLimitStatus(accountId: string): Promise<AccountRateLimitStatus> {
    const verified = await ensureActiveAccountStore(accountId);
    const account = verified.state === "ready" ? verified.account : null;
    if (!account || !account.enabled) throw new Error(verified.detail || "The selected Codex account profile is unavailable or disabled.");
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
    const verified = await ensureActiveAccountStore(accountId);
    const account = verified.state === "ready" ? verified.account : null;
    if (!account || !account.enabled) throw new Error(verified.detail || "The selected Codex account profile is unavailable or disabled.");

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
      storeId: account.storeId!,
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
      this.taskResumeScheduler.sync(activeTaskResumeSchedules(preferences));
    } catch (error) {
      preferences.taskResumeSchedules = preferences.taskResumeSchedules.filter((entry) => entry.id !== schedule.id);
      savePreferences(preferences);
      try { this.taskResumeScheduler.sync(activeTaskResumeSchedules(preferences)); } catch { /* preserve original scheduler error */ }
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

  getAccountStores(profileId: string): AccountStoreSummary[] {
    const preferences = loadPreferences(configmod.load());
    const profile = preferences.profiles.find((entry) => entry.id === profileId);
    return preferences.accountStores
      .filter((store) => store.profileId === profileId
        && (store.bindingState !== "pending" || store.id === profile?.activeStoreId))
      .map((store) => accountStoreSummary(preferences, profileId, store.id))
      .filter((entry): entry is AccountStoreSummary => entry !== null)
      .sort((a, b) => Number(b.active) - Number(a.active)
        || String(a.email ?? a.storeId).localeCompare(String(b.email ?? b.storeId)));
  }

  createAccountStore(profileId: string): AccountStoreSummary {
    const preferences = loadPreferences(configmod.load());
    const profile = preferences.profiles.find((entry) => entry.id === profileId && entry.agent === "codex");
    if (!profile) throw new Error("The selected Codex profile was not found.");

    const reusablePending = preferences.accountStores.find((store) =>
      store.profileId === profileId
      && store.id !== profile.activeStoreId
      && store.bindingState === "pending"
      && !store.identityKey);
    if (reusablePending) {
      const summary = accountStoreSummary(preferences, profileId, reusablePending.id);
      if (!summary) throw new Error("Pending account store could not be projected.");
      return summary;
    }

    const activeAccount = preferences.accounts.find((entry) => entry.id === profileId);
    const storeId = newAccountStoreId(profileId);
    const automation = activeAccount
      ? {
          message: activeAccount.message,
          schedules: [...activeAccount.schedules],
          catchupMinutes: activeAccount.catchupMinutes,
          wakePc: activeAccount.wakePc,
        }
      : {
          message: profile.automation.message,
          schedules: [...profile.automation.schedules],
          catchupMinutes: profile.automation.catchupMinutes,
          wakePc: profile.automation.wakePc,
        };

    preferences.accountStores.push({
      id: storeId,
      profileId,
      codexHome: join(codexProfilesRoot(), profileId, storeId),
      identityKey: null,
      bindingState: "pending",
      automation,
    });
    saveCanonicalPreferences(preferences);

    const fresh = loadPreferences(configmod.load());
    const summary = accountStoreSummary(fresh, profileId, storeId);
    if (!summary) throw new Error("New account store could not be created.");
    return summary;
  }

  async getAccountStoreAuthStatus(profileId: string, storeId: string): Promise<AccountAuthStatus> {
    const preferences = loadPreferences(configmod.load());
    const account = accountForStore(preferences, profileId, storeId);
    if (!account) return { ...missingProfileStatus(profileId), storeId };

    const status = await codexAuthStatus(account);
    const base = { ...status, accountId: profileId, storeId };
    if (status.state !== "connected") return base;
    if (status.identityVerified !== true) {
      return {
        ...base,
        state: "account_unverified",
        detail: "ChatGPT login is active, but PingGPT could not verify the provider account identity.",
      };
    }

    const verified = await verifyAccountStore(profileId, storeId);
    if (verified.state === "ready") return base;
    if (verified.state === "account_already_stored") {
      return {
        ...base,
        state: "account_already_stored",
        existingStoreId: verified.existingStoreId ?? null,
        detail: verified.detail,
      };
    }
    if (verified.state === "account_mismatch") {
      return { ...base, state: "account_mismatch", detail: verified.detail };
    }
    if (verified.state === "migration_review") {
      return { ...base, state: "migration_review", detail: verified.detail };
    }
    return { ...base, state: "account_unverified", detail: verified.detail };
  }

  async connectAccountStore(profileId: string, storeId: string): Promise<AccountAuthStatus> {
    const preferences = loadPreferences(configmod.load());
    const account = accountForStore(preferences, profileId, storeId);
    if (!account) return { ...missingProfileStatus(profileId), storeId };
    const result = await startCodexLogin(account);
    this.trace?.emit("ACCOUNT_STORE_LOGIN_REQUESTED", "main", { profileId, storeId, state: result.state });
    return { ...result, accountId: profileId, storeId };
  }

  async activateAccountStore(profileId: string, storeId: string): Promise<AppSnapshot> {
    const verified = await verifyAccountStore(profileId, storeId);
    if (verified.state !== "ready") throw new Error(verified.detail);

    const preferences = loadPreferences(configmod.load());
    const profile = preferences.profiles.find((entry) => entry.id === profileId);
    const store = preferences.accountStores.find((entry) => entry.id === storeId && entry.profileId === profileId);
    if (!profile || !store) throw new Error("The selected account store is no longer available.");

    const previousActiveStoreId = profile.activeStoreId;
    const previousTaskResumeSchedules = preferences.taskResumeSchedules.map((schedule) => ({ ...schedule }));
    const switching = previousActiveStoreId !== storeId;
    const now = new Date();

    if (switching) {
      for (const schedule of preferences.taskResumeSchedules) {
        if (!schedule.enabled || schedule.accountId !== profileId || schedule.storeId !== storeId) continue;
        const due = new Date(schedule.runAt).getTime();
        if (Number.isFinite(due) && due < now.getTime()) {
          schedule.enabled = false;
          schedule.completedAt = now.toISOString();
          schedule.lastStatus = "rejected";
        }
      }
      profile.activeStoreId = storeId;
      saveCanonicalPreferences(preferences);
    }

    try {
      const fresh = loadPreferences(configmod.load());
      this.taskResumeScheduler.sync(activeTaskResumeSchedules(fresh));
      if (fresh.schedulerEnabled) {
        this.scheduler.install(fresh.accounts);
        writeLease(true);
      } else {
        this.scheduler.prune(fresh.accounts);
      }
    } catch (error) {
      if (switching) {
        const rollback = loadPreferences(configmod.load());
        const rollbackProfile = rollback.profiles.find((entry) => entry.id === profileId);
        if (rollbackProfile) rollbackProfile.activeStoreId = previousActiveStoreId;
        rollback.taskResumeSchedules = previousTaskResumeSchedules;
        saveCanonicalPreferences(rollback);

        const restored = loadPreferences(configmod.load());
        let rollbackError: unknown = null;
        try {
          this.taskResumeScheduler.sync(activeTaskResumeSchedules(restored));
          if (restored.schedulerEnabled) {
            this.scheduler.install(restored.accounts);
            writeLease(true);
          } else {
            this.scheduler.prune(restored.accounts);
          }
        } catch (reconcileError) {
          rollbackError = reconcileError;
        }
        this.trace?.emit("ACCOUNT_STORE_ACTIVATION_ROLLED_BACK", "main", {
          profileId,
          attemptedStoreId: storeId,
          restoredStoreId: previousActiveStoreId,
          schedulerRollbackOk: rollbackError === null,
        });
        if (rollbackError) {
          throw new Error(`Account switch failed and the previous binding was restored, but scheduler rollback also failed: ${String((rollbackError as { message?: unknown })?.message ?? rollbackError)}`);
        }
      }
      throw error;
    }

    this.trace?.emit("ACCOUNT_STORE_ACTIVATED", "main", { profileId, storeId });
    return this.snapshot();
  }

  async getAccountAuthStatus(accountId: string): Promise<AccountAuthStatus> {
    const config = configmod.load();
    const account = loadPreferences(config).accounts.find((entry) => entry.id === accountId);
    if (!account) return missingProfileStatus(accountId);

    const status = await codexAuthStatus(account);
    if (status.state !== "connected") return status;
    if (status.identityVerified !== true) {
      return {
        ...status,
        state: "account_unverified",
        detail: "ChatGPT login is active, but PingGPT could not verify the provider account identity.",
      };
    }

    const verified = await ensureActiveAccountStore(accountId);
    if (verified.state === "ready") return status;
    if (verified.state === "account_mismatch") {
      return { ...status, state: "account_mismatch", detail: verified.detail };
    }
    if (verified.state === "migration_review") {
      return { ...status, state: "migration_review", detail: verified.detail };
    }
    return { ...status, state: "account_unverified", detail: verified.detail };
  }

  async connectAccount(accountId: string): Promise<AccountAuthStatus> {
    const preferences = loadPreferences(configmod.load());
    const profile = preferences.profiles.find((entry) => entry.id === accountId);
    if (!profile?.activeStoreId) return missingProfileStatus(accountId);
    return await this.connectAccountStore(accountId, profile.activeStoreId);
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
