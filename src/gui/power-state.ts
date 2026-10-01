import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../core/config.js";

export interface PowerState {
  lastSuspendAt?: number;
  lastResumeAt?: number;
  ownerPid?: number;
}

export const powerStatePath = (): string => join(stateDir(), "gui-power-state.json");

export function readPowerState(): PowerState {
  try {
    const raw = JSON.parse(readFileSync(powerStatePath(), "utf8")) as PowerState;
    return {
      lastSuspendAt: Number.isFinite(Number(raw.lastSuspendAt)) ? Number(raw.lastSuspendAt) : undefined,
      lastResumeAt: Number.isFinite(Number(raw.lastResumeAt)) ? Number(raw.lastResumeAt) : undefined,
      ownerPid: Number.isFinite(Number(raw.ownerPid)) ? Number(raw.ownerPid) : undefined,
    };
  } catch {
    return {};
  }
}

function writePowerState(state: PowerState): void {
  mkdirSync(stateDir(), { recursive: true });
  const path = powerStatePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

export function recordSuspend(now = Date.now(), pid = process.pid): PowerState {
  const state: PowerState = { ...readPowerState(), lastSuspendAt: now, ownerPid: pid };
  writePowerState(state);
  return state;
}

export function recordResume(now = Date.now(), pid = process.pid): PowerState {
  const state: PowerState = { ...readPowerState(), lastResumeAt: now, ownerPid: pid };
  writePowerState(state);
  return state;
}

export function recentlyResumedFromSuspend(now = Date.now(), maxAgeMs = 120_000): boolean {
  const state = readPowerState();
  const suspendAt = Number(state.lastSuspendAt);
  const resumeAt = Number(state.lastResumeAt);
  if (!Number.isFinite(suspendAt) || !Number.isFinite(resumeAt)) return false;
  if (resumeAt < suspendAt) return false;
  const age = now - resumeAt;
  return age >= 0 && age <= maxAgeMs;
}
