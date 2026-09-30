import type { Config } from "../core/config.js";

export interface AccountProfile {
  id: string;
  displayName: string;
  enabled: boolean;
  codexHome?: string;
  message: string;
  schedules: string[];
  agent: "claude" | "codex";
}

export interface GuiPreferences {
  schemaVersion: 1;
  runAtLogin: boolean;
  schedulerEnabled: boolean;
  accounts: AccountProfile[];
}

export interface SchedulerTaskStatus {
  name: string;
  scheduleId: string;
  time: string;
  installed: boolean;
  enabled: boolean;
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
  save(payload: SavePayload): Promise<AppSnapshot>;
  setScheduler(enabled: boolean): Promise<AppSnapshot>;
  setRunAtLogin(enabled: boolean): Promise<AppSnapshot>;
  doctor(): Promise<DoctorCheck[]>;
  readLog(): Promise<string>;
  openLogFolder(): Promise<boolean>;
  exportDiagnostic(): Promise<DiagnosticExportResult>;
  rendererReady(): void;
  rendererEvent(stage: "EXIT_GUI_01_RENDERER_CLICK" | "RENDERER_ERROR" | "RENDERER_UNHANDLED_REJECTION"): void;
  quit(): void;
}
