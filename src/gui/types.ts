import type { Config } from "../core/config.js";

export interface AccountProfile {
  id: string;
  displayName: string;
  enabled: boolean;
  codexHome?: string;
  message: string;
  schedules: string[];
  agent: "claude" | "codex";
  catchupMinutes?: number;
  wakePc?: boolean;
  /** R1.07 active account-store metadata. */
  storeId?: string | null;
  storeIdentityKey?: string | null;
  storeBindingState?: AccountStoreBindingState | null;
}

export interface AutomationSettings {
  message: string;
  schedules: string[];
  catchupMinutes?: number;
  wakePc?: boolean;
}

export type AccountStoreBindingState =
  | "pending"
  | "bound"
  | "migration_pending"
  | "migration_review";

export interface LocalProfile {
  id: string;
  displayName: string;
  enabled: boolean;
  agent: "claude" | "codex";
  activeStoreId: string | null;
  automation: AutomationSettings;
}

export interface AccountStore {
  id: string;
  profileId: string;
  codexHome: string;
  identityKey: string | null;
  bindingState: AccountStoreBindingState;
  lastKnownEmail?: string | null;
  planType?: string | null;
  automation: AutomationSettings;
}

export type AccountAuthState =
  | "connected"
  | "wrong_auth"
  | "not_connected"
  | "cli_missing"
  | "not_codex"
  | "login_started"
  | "profile_missing"
  | "account_unverified"
  | "account_mismatch"
  | "migration_review";

export interface AccountAuthStatus {
  accountId: string;
  state: AccountAuthState;
  detail: string;
  email?: string | null;
  planType?: string | null;
  identityVerified?: boolean;
  loginUrl?: string;
  loginCode?: string;
}

export interface TaskResumeSchedule {
  id: string;
  /** Local profile id; retained as accountId for renderer/API compatibility in R1.07. */
  accountId: string;
  /** Exact account store that owns the task. */
  storeId: string;
  threadId: string;
  title: string;
  runAt: string;
  expectedUpdatedAt: number | null;
  wakePc: boolean;
  enabled: boolean;
  createdAt: string;
  completedAt?: string | null;
  lastStatus?: TaskResumeResult["status"] | null;
}

export interface GuiPreferences {
  schemaVersion: 2;
  runAtLogin: boolean;
  schedulerEnabled: boolean;
  profiles: LocalProfile[];
  accountStores: AccountStore[];
  /** Runtime compatibility projection: one active store per local profile. Not persisted in schema v2. */
  accounts: AccountProfile[];
  taskResumeSchedules: TaskResumeSchedule[];
}

export interface SchedulerTaskStatus {
  name: string;
  scheduleId: string;
  time: string;
  installed: boolean;
  enabled: boolean;
}

export type TaskInventorySource = "account" | "legacy_global";
export type TaskOwnershipStatus = "matched" | "mismatch" | "unverified" | "legacy";
export type TaskResumeEligibility =
  | "same_profile_candidate"
  | "account_mismatch"
  | "ownership_unverified"
  | "legacy_unassigned";

export interface TaskInventoryAccountState {
  accountId: string;
  accountLabel: string;
  connectedEmail: string | null;
  planType: string | null;
  identityVerified: boolean;
}

export interface TaskInventoryItem {
  id: string;
  source: TaskInventorySource;
  accountId: string | null;
  accountLabel: string;
  title: string;
  preview: string;
  cwd: string | null;
  model: string | null;
  modelProvider: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  recencyAt: number | null;
  status: string;
  historyMode: string;
  sessionSource: string;
  originator: string | null;
  ownershipStatus: TaskOwnershipStatus;
  resumeEligibility: TaskResumeEligibility;
}

export interface TaskInventorySourceError {
  source: TaskInventorySource;
  accountId: string | null;
  accountLabel: string;
  detail: string;
}

export interface TaskInventorySnapshot {
  generatedAt: string;
  items: TaskInventoryItem[];
  errors: TaskInventorySourceError[];
  accounts: TaskInventoryAccountState[];
}

export type TaskResumeAction = "wait" | "continue" | "replay" | "abort";
export type TaskResumeStatus =
  | "completed"
  | "already_running"
  | "history_changed"
  | "turn_failed"
  | "rejected"
  | "error";

export interface TaskResumeResult {
  accountId: string;
  threadId: string;
  action: TaskResumeAction;
  status: TaskResumeStatus;
  detail: string;
  turnId: string | null;
}

export interface AccountRateLimitStatus {
  accountId: string;
  ordinaryUsageAllowed: boolean | null;
  primaryUsedPercent: number | null;
  primaryResetsAt: number | null;
  secondaryUsedPercent: number | null;
  secondaryResetsAt: number | null;
  suggestedResetAt: number | null;
}

export interface AppSnapshot {
  config: Config;
  preferences: GuiPreferences;
  configPath: string;
  logPath: string;
  armed: boolean;
  nextPing: string | null;
  agents: Record<string, string | null>;
  scheduler: SchedulerTaskStatus[];
  version: string;
  buildIdentity: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SavePayload {
  config: Config;
  preferences: GuiPreferences;
}

export interface DiagnosticExportResult {
  ok: boolean;
  path?: string;
  status: "COMPLETE" | "PARTIAL" | "FAILED";
  error?: string;
}

export interface AutomodeApi {
  getSnapshot(): Promise<AppSnapshot>;
  getTaskInventory(): Promise<TaskInventorySnapshot>;
  resumeTask(accountId: string, threadId: string, expectedUpdatedAt: number | null): Promise<TaskResumeResult>;
  scheduleTaskResume(accountId: string, threadId: string, title: string, runAt: string, expectedUpdatedAt: number | null): Promise<AppSnapshot>;
  cancelTaskResumeSchedule(scheduleId: string): Promise<AppSnapshot>;
  getAccountRateLimitStatus(accountId: string): Promise<AccountRateLimitStatus>;
  save(payload: SavePayload): Promise<AppSnapshot>;
  setScheduler(enabled: boolean): Promise<AppSnapshot>;
  setRunAtLogin(enabled: boolean): Promise<AppSnapshot>;
  newAccountProfile(): Promise<AccountProfile>;
  getAccountAuthStatus(accountId: string): Promise<AccountAuthStatus>;
  connectAccount(accountId: string): Promise<AccountAuthStatus>;
  openExternalLogin(url: string, code: string): Promise<boolean>;
  doctor(): Promise<DoctorCheck[]>;
  readLog(): Promise<string>;
  openLogFolder(): Promise<boolean>;
  exportDiagnostic(): Promise<DiagnosticExportResult>;
  rendererReady(): void;
  rendererEvent(stage: "EXIT_GUI_01_RENDERER_CLICK" | "RENDERER_ERROR" | "RENDERER_UNHANDLED_REJECTION"): void;
  quit(): void;
}
