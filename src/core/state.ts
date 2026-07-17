/** Remember which scheduled pings already fired, across restarts. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "./config.js";

/** A ping record older than this cannot suppress anything; drop it. */
const RECORD_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export interface StateStore {
  pingFired(key: string): boolean;
  markPing(key: string): void;
}

export class State implements StateStore {
  private pings: Record<string, number>;

  constructor(private readonly path: string = join(stateDir(), "state.json")) {
    this.pings = this.read();
  }

  private read(): Record<string, number> {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      return typeof data?.pings === "object" && data.pings ? data.pings : {};
    } catch {
      return {};
    }
  }

  private write(): void {
    const cutoff = Date.now() - RECORD_TTL_MS;
    this.pings = Object.fromEntries(
      Object.entries(this.pings).filter(([, at]) => at >= cutoff),
    );
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ pings: this.pings }, null, 2), "utf8");
      renameSync(tmp, this.path);
    } catch {
      // State is a convenience, never worth taking a session down over.
    }
  }

  pingFired(key: string): boolean {
    return key in this.pings;
  }

  markPing(key: string): void {
    this.pings[key] = Date.now();
    this.write();
  }
}
