import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "../core/config.js";
import { stateDir } from "../core/config.js";
import type {
  AccountProfile,
  AccountStore,
  AccountTarget,
  GuiPreferences,
  TaskResumeSchedule,
} from "./types.js";

export const preferencesPath = (): string => join(stateDir(), "gui-preferences.json");

export const codexProfilesRoot = (): string => {
  const local = process.env.LOCALAPPDATA?.trim();
  const base = local || join(homedir(), ".local", "share");
  return join(base, "PingGPT", "codex-profiles");
};

function clampCatchup(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.max(0, Math.min(180, fallback));
  return Math.max(0, Math.min(180, Math.round(parsed)));
}

function safeId(value: unknown, fallback: string, max = 48): string {
  return String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, max) || fallback;
}

function normalizedProfileId(value: unknown, index: number, seen: Set<string>): string {
  const fallback = index === 0 ? "default" : `profile-${index + 1}`;
  const base = safeId(value, fallback, 40);
  let candidate = base;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${base.slice(0, 34)}-${suffix}`;
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}

function freshStoreId(): string {
  return `store-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function defaultStore(config: Config, profileId: string, agent: AccountProfile["agent"], importedPath?: string): AccountStore {
  const id = freshStoreId();
  return {
    id,
    codexHome: importedPath || join(codexProfilesRoot(), profileId, id),
    identityKey: null,
    lastKnownEmail: null,
    planType: null,
    bindingState: agent === "codex" ? (importedPath ? "needs_verification" : "pending") : "ready",
    message: config.ping.message,
    schedules: [...config.ping.times],
    catchupMinutes: clampCatchup(config.ping.catchup_minutes, 30),
    wakePc: false,
  };
}

export function defaults(config: Config): GuiPreferences {
  const profileId = "default";
  const store = defaultStore(config, profileId, config.ping.agent === "codex" ? "codex" : "claude");
  return {
    schemaVersion: 2,
    runAtLogin: false,
    schedulerEnabled: false,
    taskResumeSchedules: [],
    accounts: [{
      id: profileId,
      displayName: "Default profile",
      enabled: true,
      agent: config.ping.agent === "codex" ? "codex" : "claude",
      activeStoreId: store.id,
      stores: [store],
    }],
  };
}

export function activeAccountStore(profile: AccountProfile): AccountStore | null {
  if (!profile.activeStoreId) return null;
  return profile.stores.find((store) => store.id === profile.activeStoreId) ?? null;
}

export function accountTarget(profile: AccountProfile, store: AccountStore): AccountTarget {
  return {
    id: profile.id,
    profileId: profile.id,
    storeId: store.id,
    displayName: profile.displayName,
    enabled: profile.enabled,
    codexHome: store.codexHome,
    identityKey: store.identityKey,
    bindingState: store.bindingState,
    message: store.message,
    schedules: [...store.schedules],
    agent: profile.agent,
    catchupMinutes: store.catchupMinutes,
    wakePc: store.wakePc,
  };
}

export function findAccountTarget(
  preferences: GuiPreferences,
  profileId: string,
  storeId?: string | null,
): AccountTarget | null {
  const profile = preferences.accounts.find((entry) => entry.id === profileId);
  if (!profile) return null;
  const selectedId = storeId || profile.activeStoreId;
  const store = selectedId ? profile.stores.find((entry) => entry.id === selectedId) : null;
  return store ? accountTarget(profile, store) : null;
}

export function activeAccountTargets(preferences: GuiPreferences): AccountTarget[] {
  return preferences.accounts.flatMap((profile) => {
    const store = activeAccountStore(profile);
    return store ? [accountTarget(profile, store)] : [];
  });
}

export function runnableAccountTargets(preferences: GuiPreferences): AccountTarget[] {
  return activeAccountTargets(preferences).filter((target) =>
    target.enabled && (target.agent !== "codex" || target.bindingState === "ready"));
}

export function runnableTaskResumeSchedules(preferences: GuiPreferences, now = new Date()): TaskResumeSchedule[] {
  const nowMs = now.getTime();
  return preferences.taskResumeSchedules.filter((schedule) => {
    if (!schedule.enabled) return false;
    const target = findAccountTarget(preferences, schedule.profileId, schedule.storeId);
    if (!target || !target.enabled) return false;
    const profile = preferences.accounts.find((entry) => entry.id === schedule.profileId);
    if (!profile || profile.activeStoreId !== schedule.storeId) return false;
    if (target.agent === "codex" && target.bindingState !== "ready") return false;
    const runAt = new Date(schedule.runAt).getTime();
    return Number.isFinite(runAt) && runAt > nowMs;
  });
}

export function newAccountProfile(config: Config, existing: AccountProfile[]): AccountProfile {
  const used = new Set(existing.map((account) => account.id));
  let id = `profile-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  while (used.has(id)) id = `profile-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const store = defaultStore(config, id, "codex");
  store.wakePc = true;
  return {
    id,
    displayName: `GPT Account ${existing.length + 1}`,
    enabled: false,
    agent: "codex",
    activeStoreId: store.id,
    stores: [store],
  };
}

export function newAccountStore(config: Config, profile: AccountProfile): AccountStore {
  const active = activeAccountStore(profile);
  const store = defaultStore(config, profile.id, profile.agent);
  if (active) {
    store.message = active.message;
    store.schedules = [...active.schedules];
    store.catchupMinutes = active.catchupMinutes;
    store.wakePc = active.wakePc;
  }
  store.bindingState = profile.agent === "codex" ? "pending" : "ready";
  return store;
}

type LegacyAccount = {
  id?: unknown;
  displayName?: unknown;
  enabled?: unknown;
  codexHome?: unknown;
  message?: unknown;
  schedules?: unknown;
  agent?: unknown;
  catchupMinutes?: unknown;
  wakePc?: unknown;
};

type RawStore = Partial<AccountStore>;
type RawProfile = Partial<AccountProfile> & { stores?: RawStore[] };

function projectStore(
  raw: RawStore,
  config: Config,
  profileId: string,
  agent: AccountProfile["agent"],
  fallbackId: string,
): AccountStore {
  const id = safeId(raw.id, fallbackId);
  const codexHome = raw.codexHome
    ? String(raw.codexHome)
    : join(codexProfilesRoot(), profileId, id);
  const allowed = new Set(["ready", "pending", "needs_verification", "migration_review", "account_mismatch", "unverified"]);
  const state = allowed.has(String(raw.bindingState))
    ? String(raw.bindingState) as AccountStore["bindingState"]
    : (agent === "codex" ? "needs_verification" : "ready");
  return {
    id,
    codexHome,
    identityKey: typeof raw.identityKey === "string" && raw.identityKey ? raw.identityKey : null,
    lastKnownEmail: typeof raw.lastKnownEmail === "string" && raw.lastKnownEmail ? raw.lastKnownEmail : null,
    planType: typeof raw.planType === "string" && raw.planType ? raw.planType : null,
    bindingState: state,
    message: String(raw.message ?? config.ping.message),
    schedules: Array.isArray(raw.schedules) ? raw.schedules.map(String) : [...config.ping.times],
    catchupMinutes: clampCatchup(raw.catchupMinutes, config.ping.catchup_minutes),
    wakePc: raw.wakePc === true,
  };
}

function migrateLegacyProfile(raw: LegacyAccount, config: Config, id: string, index: number): AccountProfile {
  const agent = raw.agent === "codex" ? "codex" as const : "claude" as const;
  const storeId = safeId(`store-imported-${id}`, `store-imported-${index + 1}`);
  const codexHome = raw.codexHome ? String(raw.codexHome) : join(codexProfilesRoot(), id);
  const store: AccountStore = {
    id: storeId,
    codexHome,
    identityKey: null,
    lastKnownEmail: null,
    planType: null,
    bindingState: agent === "codex" ? "needs_verification" : "ready",
    message: String(raw.message ?? config.ping.message),
    schedules: Array.isArray(raw.schedules) ? raw.schedules.map(String) : [...config.ping.times],
    catchupMinutes: clampCatchup(raw.catchupMinutes, config.ping.catchup_minutes),
    wakePc: raw.wakePc === true,
  };
  return {
    id,
    displayName: String(raw.displayName || (index === 0 ? "Default profile" : `Profile ${index + 1}`)),
    enabled: raw.enabled !== false,
    agent,
    activeStoreId: store.id,
    stores: [store],
  };
}

function projectTaskResumeSchedules(
  raw: { taskResumeSchedules?: unknown },
  profiles: AccountProfile[],
): TaskResumeSchedule[] {
  if (!Array.isArray(raw.taskResumeSchedules)) return [];
  const seen = new Set<string>();
  const projected: TaskResumeSchedule[] = [];
  for (const unknownEntry of raw.taskResumeSchedules) {
    if (!unknownEntry || typeof unknownEntry !== "object") continue;
    const entry = unknownEntry as Record<string, unknown>;
    const id = safeId(entry.id, "", 64);
    const legacyProfileId = String(entry.accountId ?? "");
    const profileId = String(entry.profileId ?? legacyProfileId);
    const profile = profiles.find((candidate) => candidate.id === profileId);
    const storeId = String(entry.storeId ?? profile?.activeStoreId ?? "");
    const threadId = String(entry.threadId ?? "");
    const runAt = String(entry.runAt ?? "");
    if (!id || seen.has(id) || !profile || !profile.stores.some((store) => store.id === storeId)) continue;
    if (!/^[0-9A-Fa-f-]{36}$/.test(threadId)) continue;
    const when = new Date(runAt);
    if (!Number.isFinite(when.getTime())) continue;
    seen.add(id);
    projected.push({
      id,
      profileId,
      storeId,
      threadId,
      title: String(entry.title ?? "Codex task").slice(0, 240),
      runAt: when.toISOString(),
      expectedUpdatedAt: Number.isFinite(Number(entry.expectedUpdatedAt)) ? Number(entry.expectedUpdatedAt) : null,
      wakePc: entry.wakePc === true,
      enabled: entry.enabled === true,
      createdAt: Number.isFinite(new Date(String(entry.createdAt ?? "")).getTime())
        ? new Date(String(entry.createdAt)).toISOString()
        : new Date().toISOString(),
      completedAt: entry.completedAt ? String(entry.completedAt) : null,
      lastStatus: (entry.lastStatus ?? null) as TaskResumeSchedule["lastStatus"],
    });
  }
  return projected;
}

function projectPreferences(raw: Record<string, unknown>, config: Config): GuiPreferences {
  const base = defaults(config);
  const rawAccounts = Array.isArray(raw.accounts) && raw.accounts.length ? raw.accounts : base.accounts;
  const seen = new Set<string>();
  const schemaVersion = Number(raw.schemaVersion);

  const accounts: AccountProfile[] = rawAccounts.map((unknownAccount, index) => {
    const record = (unknownAccount && typeof unknownAccount === "object" ? unknownAccount : {}) as Record<string, unknown>;
    const id = normalizedProfileId(record.id, index, seen);

    if (schemaVersion >= 2 && Array.isArray(record.stores)) {
      const agent = record.agent === "codex" ? "codex" as const : "claude" as const;
      const stores = (record.stores as RawStore[]).map((store, storeIndex) =>
        projectStore(store, config, id, agent, `store-${storeIndex + 1}`));
      const ensuredStores = stores.length ? stores : [defaultStore(config, id, agent)];
      const requestedActive = typeof record.activeStoreId === "string" ? record.activeStoreId : null;
      const activeStoreId = requestedActive && ensuredStores.some((store) => store.id === requestedActive)
        ? requestedActive
        : ensuredStores[0]!.id;
      return {
        id,
        displayName: String(record.displayName || (index === 0 ? "Default profile" : `Profile ${index + 1}`)),
        enabled: record.enabled !== false,
        agent,
        activeStoreId,
        stores: ensuredStores,
      };
    }

    return migrateLegacyProfile(record as LegacyAccount, config, id, index);
  });

  return {
    schemaVersion: 2,
    runAtLogin: Boolean(raw.runAtLogin),
    schedulerEnabled: Boolean(raw.schedulerEnabled),
    accounts,
    taskResumeSchedules: projectTaskResumeSchedules(raw, accounts),
  };
}

export function loadPreferences(config: Config): GuiPreferences {
  try {
    const raw = JSON.parse(readFileSync(preferencesPath(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return defaults(config);
    return projectPreferences(raw as Record<string, unknown>, config);
  } catch {
    return defaults(config);
  }
}

/** Preserve normal fallback semantics while allowing diagnostics to report a corrupt/unreadable file. */
export function loadDiagnosticPreferences(config: Config): GuiPreferences {
  const path = preferencesPath();
  if (!existsSync(path)) return defaults(config);
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("GUI preferences root is not an object.");
  return projectPreferences(raw as Record<string, unknown>, config);
}

export function savePreferences(preferences: GuiPreferences): string {
  const path = preferencesPath();
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...preferences, schemaVersion: 2 }, null, 2), "utf8");
  renameSync(tmp, path);
  return path;
}
