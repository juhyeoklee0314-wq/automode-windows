import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { stateDir } from "../core/config.js";
import { redactSecrets } from "../core/redact.js";

export const BUILD_IDENTITY = "phase7-pinggpt-diagnostic-20260930-005";
export const DIAGNOSTIC_LOG_PATH = (): string => join(stateDir(), "phase6-diagnostic.log");
export const DIAGNOSTIC_RECEIPT_PATH = (): string => join(stateDir(), "phase6", "gui-schedule.json");

const MAX_DIAGNOSTIC_BYTES = 512_000;

function safeText(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  return redactSecrets(String(value)).replace(/[\r\n]+/g, " ").slice(0, 500);
}

function rotate(path: string): void {
  try {
    if (statSync(path).size <= MAX_DIAGNOSTIC_BYTES) return;
    const previous = `${path}.1`;
    if (existsSync(previous)) unlinkSync(previous);
    renameSync(path, previous);
  } catch {
    // Diagnostics must never alter application behavior.
  }
}

export class DiagnosticTrace {
  readonly runId: string;
  private readonly startedAt = performance.now();

  constructor(runId = process.env.AUTOMODE_DIAGNOSTIC_RUN_ID) {
    this.runId = (runId || `${Date.now()}-${process.pid}`).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  }

  emit(stage: string, source = "system", details: Record<string, unknown> = {}): void {
    const safeDetails = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, safeText(value)]));
    const record = {
      ...safeDetails,
      timestamp: new Date().toISOString(),
      elapsedMs: Math.round((performance.now() - this.startedAt) * 10) / 10,
      pid: process.pid,
      runId: this.runId,
      buildIdentity: BUILD_IDENTITY,
      source: safeText(source),
      stage: safeText(stage),
    };
    try {
      const path = DIAGNOSTIC_LOG_PATH();
      mkdirSync(join(path, ".."), { recursive: true });
      rotate(path);
      appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // Diagnostic logging is strictly best effort.
    }
  }
}
