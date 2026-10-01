import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../core/config.js";

export const LEASE_TTL_MS = 45_000;
export const STALE_LOCK_GRACE_MS = 60_000;
export const leasePath = (): string => join(stateDir(), "gui-runtime.json");
export const executionLockPath = (identity: string, namespace = "production"): string =>
  join(
    stateDir(),
    "locks",
    namespace.replace(/[^A-Za-z0-9_.-]/g, "_"),
    `${identity.replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`,
  );

interface LeaseFile {
  armed: boolean;
  ownerPid: number;
  updatedAt: number;
  expiresAt: number;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeLease(armed: boolean, now = Date.now(), pid = process.pid): void {
  mkdirSync(stateDir(), { recursive: true });
  const path = leasePath();
  const tmp = `${path}.tmp`;
  const data: LeaseFile = { armed, ownerPid: pid, updatedAt: now, expiresAt: now + LEASE_TTL_MS };
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

export function clearLease(): void {
  try {
    writeLease(false);
  } catch {
    try { unlinkSync(leasePath()); } catch { /* best effort */ }
  }
}

export function leaseIsLive(now = Date.now()): boolean {
  try {
    const lease = JSON.parse(readFileSync(leasePath(), "utf8")) as LeaseFile;
    return lease.armed === true && lease.expiresAt >= now && now - lease.updatedAt <= LEASE_TTL_MS && pidAlive(lease.ownerPid);
  } catch {
    return false;
  }
}

export function activeExecutionLockCount(namespace = "production"): number {
  const directory = join(stateDir(), "locks", namespace.replace(/[^A-Za-z0-9_.-]/g, "_"));
  try {
    let count = 0;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".lock")) continue;
      try {
        const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as { ownerPid?: unknown };
        if (pidAlive(Number(record.ownerPid))) count += 1;
      } catch {
        // Ignore unreadable or already-removed lock files.
      }
    }
    return count;
  } catch {
    return 0;
  }
}

export function acquireExecutionLock(identity: string, namespace = "production"): (() => void) | null {
  const path = executionLockPath(identity, namespace);
  mkdirSync(join(path, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, JSON.stringify({ identity, ownerPid: process.pid, createdAt: Date.now() }), "utf8");
      return () => {
        try { closeSync(fd); } catch { /* already closed */ }
        try { unlinkSync(path); } catch { /* already removed */ }
      };
    } catch {
      if (!existsSync(path) || attempt > 0) return null;
      try {
        const record = JSON.parse(readFileSync(path, "utf8")) as {
          identity?: unknown; ownerPid?: unknown; createdAt?: unknown;
        };
        const ownerPid = Number(record.ownerPid);
        const createdAt = Number(record.createdAt);
        const age = Date.now() - createdAt;
        if (record.identity !== identity || !Number.isFinite(createdAt) || age < STALE_LOCK_GRACE_MS) return null;
        if (pidAlive(ownerPid)) return null;
        unlinkSync(path);
      } catch {
        return null;
      }
    }
  }
  return null;
}
