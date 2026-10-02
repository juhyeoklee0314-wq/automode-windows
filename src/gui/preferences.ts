import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "../core/config.js";
import { stateDir } from "../core/config.js";
import type { AccountProfile, GuiPreferences, TaskResumeSchedule } from "./types.js";

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

export function defaults(config: Config): GuiPreferences {
  return {
    schemaVersion: 1,
    runAtLogin: false,
    schedulerEnabled: false,
    taskResumeSchedules: [],
    accounts: [{
      id: "default",
      displayName: "Default profile",
      enabled: true,
      codexHome: join(codexProfilesRoot(), "default"),
      message: config.ping.message,
      schedules: [...config.ping.times],
      agent: config.ping.agent === "codex" ? "codex" : "claude",
      catchupMinutes: clampCatchup(config.ping.catchup_minutes, 30),
      wakePc: false,
    }],
  };
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

function projectTaskResumeSchedules(raw: Partial<GuiPreferences>, accountIds: Set<string>): TaskResumeSchedule[] {
  if (!Array.isArray(raw.taskResumeSchedules)) return [];
  const seen = new Set<string>();
  const projected: TaskResumeSchedule[] = [];
  for (const entry of raw.taskResumeSchedules) {
    const id = String(entry?.id ?? "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
    const accountId = String(entry?.accountId ?? "");
    const threadId = String(entry?.threadId ?? "");
    const runAt = String(entry?.runAt ?? "");
    if (!id || seen.has(id) || !accountIds.has(accountId)) continue;
    if (!/^[0-9A-Fa-f-]{36}$/.test(threadId)) continue;
    const when = new Date(runAt);
    if (!Number.isFinite(when.getTime())) continue;
    seen.add(id);
    projected.push({
      id,
      accountId,
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

function projectPreferences(raw: Partial<GuiPreferences>, config: Config): GuiPreferences {
  const base = defaults(config);
  const source = Array.isArray(raw.accounts) && raw.accounts.length ? raw.accounts : base.accounts;
  const seen = new Set<string>();
  const accounts = source.map((account, index) => {
    const id = normalizedId(account.id, index, seen);
    // Every profile gets its own Codex home. Legacy/default profiles that
    // omitted codexHome are projected into an isolated profile instead of
    // inheriting the machine-wide Codex/ChatGPT login.
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
  return {
    schemaVersion: 1,
    runAtLogin: Boolean(raw.runAtLogin),
    schedulerEnabled: Boolean(raw.schedulerEnabled),
    accounts,
    taskResumeSchedules: projectTaskResumeSchedules(raw, new Set(accounts.map((account) => account.id))),
  };
}

export function loadPreferences(config: Config): GuiPreferences {
  try {
    const raw = JSON.parse(readFileSync(preferencesPath(), "utf8")) as Partial<GuiPreferences>;
    return projectPreferences(raw, config);
  } catch {
    return defaults(config);
  }
}

/** Preserve normal fallback semantics while allowing diagnostics to report a corrupt/unreadable file. */
export function loadDiagnosticPreferences(config: Config): GuiPreferences {
  const path = preferencesPath();
  if (!existsSync(path)) return defaults(config);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GuiPreferences>;
  return projectPreferences(raw, config);
}

export function savePreferences(preferences: GuiPreferences): string {
  const path = preferencesPath();
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(preferences, null, 2), "utf8");
  renameSync(tmp, path);
  return path;
}
