import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "../core/config.js";
import { stateDir } from "../core/config.js";
import {
  activeStoreForProfile,
  migrateV1AccountProfiles,
  newAccountStoreId,
  projectActiveAccountProfiles,
} from "./account-store-model.js";
import type {
  AccountProfile,
  AccountStore,
  AccountStoreBindingState,
  AutomationSettings,
  GuiPreferences,
  LocalProfile,
  TaskResumeSchedule,
} from "./types.js";

export const preferencesPath = (): string => join(stateDir(), "gui-preferences.json");

export const codexProfilesRoot = (): string => {
  const local = process.env.LOCALAPPDATA?.trim();
  const base = local || join(homedir(), ".local", "share");
  return join(base, "PingGPT", "codex-profiles");
};

interface PersistedGuiPreferencesV2 {
  schemaVersion: 2;
  runAtLogin: boolean;
  schedulerEnabled: boolean;
  profiles: LocalProfile[];
  accountStores: AccountStore[];
  taskResumeSchedules: TaskResumeSchedule[];
}

function clampCatchup(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.max(0, Math.min(180, fallback));
  return Math.max(0, Math.min(180, Math.round(parsed)));
}

function normalizedId(value: unknown, index: number, seen: Set<string>): string {
  const fallback = index === 0 ? "default" : `profile-${index + 1}`;
  const base = String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || fallback;
  let candidate = base;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${base.slice(0, 34)}-${suffix}`;
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}

function automationSettings(
  raw: Partial<AutomationSettings> | undefined,
  config: Config,
): AutomationSettings {
  return {
    message: String(raw?.message ?? config.ping.message),
    schedules: Array.isArray(raw?.schedules)
      ? raw!.schedules!.map(String)
      : [...config.ping.times],
    catchupMinutes: clampCatchup(raw?.catchupMinutes, config.ping.catchup_minutes),
    wakePc: raw?.wakePc === true,
  };
}

function defaultAccount(config: Config): AccountProfile {
  return {
    id: "default",
    displayName: "Default profile",
    enabled: true,
    codexHome: join(codexProfilesRoot(), "default"),
    message: config.ping.message,
    schedules: [...config.ping.times],
    agent: config.ping.agent === "codex" ? "codex" : "claude",
    catchupMinutes: clampCatchup(config.ping.catchup_minutes, 30),
    wakePc: false,
  };
}

function runtimePreferences(
  runAtLogin: boolean,
  schedulerEnabled: boolean,
  profiles: LocalProfile[],
  accountStores: AccountStore[],
  taskResumeSchedules: TaskResumeSchedule[],
): GuiPreferences {
  return {
    schemaVersion: 2,
    runAtLogin,
    schedulerEnabled,
    profiles,
    accountStores,
    accounts: projectActiveAccountProfiles(profiles, accountStores),
    taskResumeSchedules,
  };
}

export function defaults(config: Config): GuiPreferences {
  const account = defaultAccount(config);
  const migrated = migrateV1AccountProfiles([account]);
  for (const store of migrated.accountStores) store.bindingState = "pending";
  return runtimePreferences(false, false, migrated.profiles, migrated.accountStores, []);
}

export function newAccountProfile(config: Config, existing: AccountProfile[]): AccountProfile {
  const used = new Set(existing.map((account) => account.id));
  let id = `profile-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  while (used.has(id)) id = `profile-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  return {
    id,
    displayName: `GPT Account ${existing.length + 1}`,
    enabled: false,
    codexHome: join(codexProfilesRoot(), id),
    message: config.ping.message,
    schedules: [...config.ping.times],
    agent: "codex",
    catchupMinutes: clampCatchup(config.ping.catchup_minutes, 30),
    wakePc: true,
  };
}

function projectTaskResumeSchedules(
  raw: { taskResumeSchedules?: unknown },
  profiles: LocalProfile[],
  stores: AccountStore[],
): TaskResumeSchedule[] {
  if (!Array.isArray(raw.taskResumeSchedules)) return [];
  const seen = new Set<string>();
  const projected: TaskResumeSchedule[] = [];
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const storeById = new Map(stores.map((store) => [store.id, store]));

  for (const entry of raw.taskResumeSchedules as Array<Partial<TaskResumeSchedule> & { storeId?: unknown }>) {
    const id = String(entry?.id ?? "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
    const accountId = String(entry?.accountId ?? "");
    const profile = profileById.get(accountId);
    const threadId = String(entry?.threadId ?? "");
    const runAt = String(entry?.runAt ?? "");
    if (!id || seen.has(id) || !profile) continue;

    let storeId = String(entry?.storeId ?? "");
    const explicitStore = storeById.get(storeId);
    if (!explicitStore || explicitStore.profileId !== accountId) {
      storeId = profile.activeStoreId ?? "";
    }
    const store = storeById.get(storeId);
    if (!store || store.profileId !== accountId) continue;

    if (!/^[0-9A-Fa-f-]{36}$/.test(threadId)) continue;
    const when = new Date(runAt);
    if (!Number.isFinite(when.getTime())) continue;
    seen.add(id);
    projected.push({
      id,
      accountId,
      storeId,
      threadId,
      title: String(entry?.title ?? "Codex task").slice(0, 240),
      runAt: when.toISOString(),
      expectedUpdatedAt: Number.isFinite(Number(entry?.expectedUpdatedAt)) ? Number(entry?.expectedUpdatedAt) : null,
      wakePc: entry?.wakePc === true,
      enabled: entry?.enabled === true,
      createdAt: Number.isFinite(new Date(String(entry?.createdAt ?? "")).getTime())
        ? new Date(String(entry?.createdAt)).toISOString()
        : new Date().toISOString(),
      completedAt: entry?.completedAt ? String(entry.completedAt) : null,
      lastStatus: entry?.lastStatus ?? null,
    });
  }
  return projected;
}

export function activeTaskResumeSchedules(preferences: GuiPreferences): TaskResumeSchedule[] {
  const activeStoreByProfile = new Map(
    preferences.accounts
      .filter((account) => account.enabled && account.agent === "codex" && Boolean(account.storeId))
      .map((account) => [account.id, account.storeId!]),
  );
  return preferences.taskResumeSchedules.filter((schedule) =>
    schedule.enabled && activeStoreByProfile.get(schedule.accountId) === schedule.storeId);
}

function projectLegacyAccounts(raw: { accounts?: unknown }, config: Config): AccountProfile[] {
  const base = defaultAccount(config);
  const source = Array.isArray(raw.accounts) && raw.accounts.length
    ? raw.accounts as Array<Partial<AccountProfile>>
    : [base];
  const seen = new Set<string>();
  return source.map((account, index) => {
    const id = normalizedId(account.id, index, seen);
    const codexHome = account.codexHome
      ? String(account.codexHome)
      : join(codexProfilesRoot(), id);
    return {
      id,
      displayName: String(account.displayName || (index === 0 ? "Default profile" : `Profile ${index + 1}`)),
      enabled: account.enabled !== false,
      codexHome,
      message: String(account.message ?? config.ping.message),
      schedules: Array.isArray(account.schedules) ? account.schedules.map(String) : [...config.ping.times],
      agent: account.agent === "codex" ? "codex" as const : "claude" as const,
      catchupMinutes: clampCatchup(account.catchupMinutes, config.ping.catchup_minutes),
      wakePc: account.wakePc === true,
    };
  });
}

function projectV1(raw: Record<string, unknown>, config: Config): GuiPreferences {
  const accounts = projectLegacyAccounts(raw, config);
  const migrated = migrateV1AccountProfiles(accounts);
  return runtimePreferences(
    Boolean(raw.runAtLogin),
    Boolean(raw.schedulerEnabled),
    migrated.profiles,
    migrated.accountStores,
    projectTaskResumeSchedules(raw, migrated.profiles, migrated.accountStores),
  );
}

function validBindingState(value: unknown): AccountStoreBindingState {
  return ["pending", "bound", "migration_pending", "migration_review"].includes(String(value))
    ? String(value) as AccountStoreBindingState
    : "migration_review";
}

function projectV2(raw: Record<string, unknown>, config: Config): GuiPreferences {
  const rawProfiles = Array.isArray(raw.profiles) ? raw.profiles as Array<Partial<LocalProfile>> : [];
  const seenProfiles = new Set<string>();
  const profiles = rawProfiles.map((entry, index): LocalProfile => {
    const id = normalizedId(entry.id, index, seenProfiles);
    return {
      id,
      displayName: String(entry.displayName || (index === 0 ? "Default profile" : `Profile ${index + 1}`)),
      enabled: entry.enabled !== false,
      agent: entry.agent === "codex" ? "codex" : "claude",
      activeStoreId: entry.activeStoreId ? String(entry.activeStoreId) : null,
      automation: automationSettings(entry.automation, config),
    };
  });

  if (!profiles.length) return defaults(config);

  const profileIds = new Set(profiles.map((profile) => profile.id));
  const storesSeen = new Set<string>();
  const accountStores: AccountStore[] = [];
  if (Array.isArray(raw.accountStores)) {
    for (const entry of raw.accountStores as Array<Partial<AccountStore>>) {
      const id = String(entry.id ?? "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
      const profileId = String(entry.profileId ?? "");
      const codexHome = String(entry.codexHome ?? "").trim();
      if (!id || storesSeen.has(id) || !profileIds.has(profileId) || !codexHome) continue;
      storesSeen.add(id);
      const identityKey = typeof entry.identityKey === "string" && /^[a-f0-9]{64}$/i.test(entry.identityKey)
        ? entry.identityKey.toLowerCase()
        : null;
      accountStores.push({
        id,
        profileId,
        codexHome,
        identityKey,
        bindingState: validBindingState(entry.bindingState),
        lastKnownEmail: entry.lastKnownEmail ? String(entry.lastKnownEmail).slice(0, 320) : null,
        planType: entry.planType ? String(entry.planType).slice(0, 80) : null,
        automation: automationSettings(entry.automation, config),
      });
    }
  }

  for (const profile of profiles) {
    const store = activeStoreForProfile(profile, accountStores);
    if (profile.agent !== "codex" || !store) profile.activeStoreId = null;
  }

  return runtimePreferences(
    Boolean(raw.runAtLogin),
    Boolean(raw.schedulerEnabled),
    profiles,
    accountStores,
    projectTaskResumeSchedules(raw, profiles, accountStores),
  );
}

function projectPreferences(raw: Record<string, unknown>, config: Config): GuiPreferences {
  if (Number(raw.schemaVersion) === 2 && Array.isArray(raw.profiles)) {
    return projectV2(raw, config);
  }
  return projectV1(raw, config);
}

export function loadPreferences(config: Config): GuiPreferences {
  try {
    const raw = JSON.parse(readFileSync(preferencesPath(), "utf8")) as Record<string, unknown>;
    return projectPreferences(raw, config);
  } catch {
    return defaults(config);
  }
}

/** Preserve normal fallback semantics while allowing diagnostics to report a corrupt/unreadable file. */
export function loadDiagnosticPreferences(config: Config): GuiPreferences {
  const path = preferencesPath();
  if (!existsSync(path)) return defaults(config);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return projectPreferences(raw, config);
}

function reconcileRuntimeAccounts(preferences: GuiPreferences): { profiles: LocalProfile[]; stores: AccountStore[] } {
  const oldProfiles = new Map(preferences.profiles.map((profile) => [profile.id, profile]));
  const oldStores = preferences.accountStores;
  const nextProfiles: LocalProfile[] = [];
  const retainedProfileIds = new Set<string>();

  for (const account of preferences.accounts) {
    retainedProfileIds.add(account.id);
    const old = oldProfiles.get(account.id);
    const profile: LocalProfile = {
      id: account.id,
      displayName: account.displayName,
      enabled: account.enabled,
      agent: account.agent,
      activeStoreId: old?.activeStoreId ?? null,
      automation: {
        message: account.message,
        schedules: [...account.schedules],
        catchupMinutes: account.catchupMinutes,
        wakePc: account.wakePc,
      },
    };

    if (account.agent === "codex" && account.codexHome) {
      let store = activeStoreForProfile(profile, oldStores);
      if (!store || store.codexHome !== account.codexHome) {
        store = oldStores.find((entry) =>
          entry.profileId === account.id && entry.codexHome === account.codexHome) ?? null;
      }
      if (!store) {
        store = {
          id: newAccountStoreId(account.id),
          profileId: account.id,
          codexHome: account.codexHome,
          identityKey: null,
          bindingState: "pending",
          automation: {
            message: account.message,
            schedules: [...account.schedules],
            catchupMinutes: account.catchupMinutes,
            wakePc: account.wakePc,
          },
        };
        oldStores.push(store);
      } else {
        store.automation = {
          message: account.message,
          schedules: [...account.schedules],
          catchupMinutes: account.catchupMinutes,
          wakePc: account.wakePc,
        };
      }
      profile.activeStoreId = store.id;
    } else {
      profile.activeStoreId = null;
    }
    nextProfiles.push(profile);
  }

  const stores = oldStores.filter((store) => retainedProfileIds.has(store.profileId));
  return { profiles: nextProfiles, stores };
}

function writeCanonicalPreferences(preferences: Pick<GuiPreferences,
  "runAtLogin" | "schedulerEnabled" | "profiles" | "accountStores" | "taskResumeSchedules"
>): string {
  const path = preferencesPath();
  mkdirSync(stateDir(), { recursive: true });
  const persisted: PersistedGuiPreferencesV2 = {
    schemaVersion: 2,
    runAtLogin: Boolean(preferences.runAtLogin),
    schedulerEnabled: Boolean(preferences.schedulerEnabled),
    profiles: preferences.profiles,
    accountStores: preferences.accountStores,
    taskResumeSchedules: preferences.taskResumeSchedules,
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(persisted, null, 2), "utf8");
  renameSync(tmp, path);
  return path;
}

export function saveCanonicalPreferences(preferences: GuiPreferences): string {
  return writeCanonicalPreferences(preferences);
}

export function savePreferences(preferences: GuiPreferences): string {
  const reconciled = reconcileRuntimeAccounts(preferences);
  return writeCanonicalPreferences({
    runAtLogin: preferences.runAtLogin,
    schedulerEnabled: preferences.schedulerEnabled,
    profiles: reconciled.profiles,
    accountStores: reconciled.stores,
    taskResumeSchedules: preferences.taskResumeSchedules,
  });
}
