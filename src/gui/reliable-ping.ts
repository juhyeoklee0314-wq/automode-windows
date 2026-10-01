import { lookup } from "node:dns/promises";

import { pingOnce } from "../agents/ping.js";
import type { Logger } from "../core/log.js";

export interface ReliablePingOptions {
  attempts?: number;
  retryDelayMs?: number;
  networkTimeoutMs?: number;
  waitForNetwork?: () => Promise<boolean>;
  ping?: (agent: string, message: string, log?: Logger) => Promise<number>;
  env?: NodeJS.ProcessEnv;
  unsetEnv?: string[];
  onResolved?: (path: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForNetworkReady(timeoutMs: number, probeIntervalMs = 1_500): Promise<boolean> {
  const timeout = Math.max(1_000, timeoutMs);
  const deadline = Date.now() + timeout;
  do {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      await Promise.race([
        lookup("chatgpt.com"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("network probe timeout")), Math.min(3_000, remaining))),
      ]);
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(probeIntervalMs, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  return false;
}

export async function reliablePing(
  agent: string,
  message: string,
  log?: Logger,
  options: ReliablePingOptions = {},
): Promise<number> {
  const attempts = Math.max(1, Math.min(options.attempts ?? 2, 3));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 4_000);
  const ready = options.waitForNetwork ?? (() => waitForNetworkReady(options.networkTimeoutMs ?? 10_000));
  const send = options.ping ?? ((selectedAgent, selectedMessage, selectedLog) =>
    pingOnce(selectedAgent, selectedMessage, selectedLog, { env: options.env, unsetEnv: options.unsetEnv, onResolved: options.onResolved }));

  if (!(await ready())) {
    log?.("ping: network did not become ready within the bounded wait");
    return 68;
  }
  let code = 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    code = await send(agent, message, log);
    if (code === 0) return 0;
    if (attempt < attempts) {
      log?.(`ping: attempt ${attempt} failed (rc=${code}); one bounded retry follows`);
      await sleep(retryDelayMs);
    }
  }
  return code;
}
