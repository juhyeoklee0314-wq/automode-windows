/**
 * Decide what to type into the wrapped session, and when.
 *
 * The controller sees a copy of everything the agent prints and every key you
 * press. From that it does two things: arm a `continue` for the moment the
 * usage limit resets (auto continue), and fire the scheduled pings (auto ping).
 *
 * Time comes from an injected clock so the schedule can be tested without
 * waiting five hours for a real one.
 */

import * as detect from "./agents/detect.js";
import * as dialogs from "./agents/dialogs.js";
import type { Config } from "./core/config.js";
import { type Logger, createLogger, notify } from "./core/log.js";
import { State, type StateStore } from "./core/state.js";
import { formatInZone, parseHhmm, resolveTz, wallClockAt, zonedToInstant } from "./core/timeutil.js";

const BUFFER_CHARS = 8000;
const SCAN_INTERVAL_MS = 250;
/** Some TUIs drop an Enter that arrives glued to the text; let the input land first. */
const ENTER_DELAY_MS = 250;
/** How long a message stays "already seen" after it leaves the screen. */
const SEEN_TTL_MS = 120_000;
const SEEN_PRUNE_MS = 3_600_000;
const MIN_LEAD_MS = 2000;
/** Time for the agent to dismiss its limit menu before we type into the prompt. */
const PROMPT_SETTLE_MS = 750;

export type Clock = () => Date;

interface Queued {
  at: number;
  payload: string;
}

/** Watches one wrapped agent session. */
export class Controller {
  private buffer = "";
  private escLeftover = "";
  private unscanned = false;
  private lastScan: number;
  private lastInput: number;
  private lastOutput: number;
  private seen = new Map<string, number>();
  private fireAt: number | null = null;
  private fireReason = "";
  private armedAt: number | null = null;
  private queue: Queued[] = [];

  constructor(
    public config: Config,
    private readonly log: Logger = createLogger(),
    private readonly state: StateStore = new State(),
    private readonly clock: Clock = () => new Date(),
  ) {
    const now = this.clock().getTime();
    this.lastScan = now - SCAN_INTERVAL_MS;
    this.lastInput = now;
    this.lastOutput = now;
  }

  /** The configured zone, re-read because the menu can change it mid-session. */
  private get tz(): string {
    return resolveTz(this.config.timezone || null);
  }

  // ---- stream side -------------------------------------------------

  onOutput(data: string): void {
    const now = this.clock().getTime();
    this.lastOutput = now;
    const [clean, leftover] = detect.stripAnsiStream(this.escLeftover + data);
    this.escLeftover = leftover;
    if (!clean) return;
    this.buffer = (this.buffer + detect.normalize(clean)).slice(-BUFFER_CHARS);
    this.unscanned = true;
    this.maybeScan(now);
  }

  /**
   * Scan at most every SCAN_INTERVAL, but never drop a pending one.
   *
   * Throttling matters because the TUI repaints constantly. Deferring rather
   * than skipping matters because the last chunk of a message may land inside
   * the throttle window and be the last thing ever printed.
   */
  private maybeScan(now: number): void {
    if (!this.unscanned || now - this.lastScan < SCAN_INTERVAL_MS) return;
    this.lastScan = now;
    this.unscanned = false;
    this.scan(new Date(now));
  }

  onUserInput(_data: Buffer): void {
    this.lastInput = this.clock().getTime();
  }

  // ---- clock side --------------------------------------------------

  /** Seconds until the next thing we have to do. */
  nextTimeout(): number {
    const now = this.clock().getTime();
    const waits = [1];
    if (this.unscanned) waits.push(SCAN_INTERVAL_MS / 1000);
    if (this.queue.length) waits.push((this.queue[0]!.at - now) / 1000);
    if (this.fireAt !== null) waits.push((this.fireAt - now) / 1000);
    return Math.max(Math.min(...waits), 0);
  }

  tick(inject: (payload: string) => void): void {
    const now = this.clock().getTime();
    this.maybeScan(now);
    if (this.fireAt !== null && now >= this.fireAt) this.fireContinue(now);
    this.checkPings(now);
    while (this.queue.length && this.queue[0]!.at <= now) {
      inject(this.queue.shift()!.payload);
    }
  }

  // ---- limit detection ---------------------------------------------

  private scan(now: Date): void {
    const hit = detect.scan(this.buffer, now, this.tz);
    if (!hit || !detect.plausible(hit.resetAt, now)) return;

    // The message sits on screen and is redrawn constantly. Refresh the
    // sighting every time, but only act on the first one, or on one that
    // reappears after the screen has been clear of it for a while.
    const key = hit.resetAt.toISOString();
    const previously = this.seen.get(key);
    this.seen.set(key, now.getTime());
    this.pruneSeen(now.getTime());
    if (previously !== undefined && now.getTime() - previously < SEEN_TTL_MS) return;

    this.arm(hit, now);
  }

  private pruneSeen(now: number): void {
    if (this.seen.size <= 32) return;
    for (const [key, at] of this.seen) {
      if (now - at >= SEEN_PRUNE_MS) this.seen.delete(key);
    }
  }

  private arm(hit: detect.LimitHit, now: Date): void {
    const local = formatInZone(hit.resetAt, this.tz, true);
    this.log(`limit detected (${hit.kind}): ${JSON.stringify(hit.raw)} -> resets ${local}`);
    if (!this.config.auto_continue) {
      this.log("auto continue is off, standing down");
      return;
    }

    const graceMs = Number(this.config.grace_seconds ?? 60) * 1000;
    const fireAt = Math.max(hit.resetAt.getTime() + graceMs, now.getTime() + MIN_LEAD_MS);
    this.fireAt = fireAt;
    this.fireReason = `reset ${formatInZone(hit.resetAt, this.tz)}`;
    this.armedAt = now.getTime();

    const wait = humanize(fireAt - now.getTime());
    const message = this.config.continue_message ?? "continue";
    this.log(
      `queued ${JSON.stringify(message)} for ${formatInZone(new Date(fireAt), this.tz, true)} (in ${wait})`,
    );
    if (this.config.notify) {
      notify(
        "automode",
        `Limit until ${formatInZone(hit.resetAt, this.tz)}. Continuing on my own in ${wait}.`,
      );
    }
  }

  private fireContinue(now: number): void {
    const guardMs = Number(this.config.idle_guard_seconds ?? 5) * 1000;
    if (now - this.lastInput < guardMs) {
      // You are typing right now; do not shove text into your prompt.
      this.fireAt = now + guardMs;
      return;
    }
    const message = this.config.continue_message ?? "continue";
    const delay = this.answerBlockingPrompt(now);
    this.enqueue(message, now + delay);
    this.fireAt = null;
    this.armedAt = null;
    this.log(`sent ${JSON.stringify(message)} (${this.fireReason})`);
    if (this.config.notify) notify("automode", `Limit is back. Sent ${JSON.stringify(message)}.`);
    // Drop the stale screen text so the same message cannot re-arm us.
    this.buffer = "";
  }

  /**
   * Dismiss the limit menu, if the agent is still sitting on it. Returns how
   * long to wait before typing the continue message.
   *
   * We only do this when you have not touched the keyboard since the limit was
   * detected. If you have, you were here and presumably answered it yourself,
   * and pressing a number into a live prompt would send a stray message.
   */
  private answerBlockingPrompt(now: number): number {
    if (!this.config.answer_limit_prompt) return 0;
    if (this.armedAt !== null && this.lastInput > this.armedAt) return 0;
    const answer = dialogs.find(this.buffer);
    if (!answer) return 0;
    this.enqueue(answer.key, now);
    this.log(`limit menu (${answer.name}): chose option ${answer.key}`);
    return PROMPT_SETTLE_MS;
  }

  // ---- scheduled pings ---------------------------------------------

  private checkPings(now: number): void {
    const ping = this.config.ping;
    if (!ping?.enabled || !ping.times?.length) return;
    if (this.queue.length || this.fireAt !== null) return; // something is mid-flight

    const catchupMs = Number(ping.catchup_minutes ?? 30) * 60_000;
    const idleNeeded = Number(ping.idle_seconds ?? 20) * 1000;
    const wall = wallClockAt(new Date(now), this.tz);

    for (const entry of ping.times) {
      const parsed = parseHhmm(String(entry));
      if (!parsed) continue;
      const [hour, minute] = parsed;
      // Yesterday too: the machine may have slept through a late-night slot.
      for (const dayOffset of [0, -1]) {
        const day = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + dayOffset));
        const target = zonedToInstant(
          {
            year: day.getUTCFullYear(),
            month: day.getUTCMonth() + 1,
            day: day.getUTCDate(),
            hour,
            minute,
          },
          this.tz,
        ).getTime();
        if (now < target || now - target > catchupMs) continue;
        const stamp = formatInZone(new Date(target), this.tz, true);
        const key = `${stamp.slice(3, 5)}-${stamp.slice(0, 2)} ${entry}`;
        if (this.state.pingFired(key)) continue;
        const idle = Math.min(now - this.lastOutput, now - this.lastInput);
        if (idle < idleNeeded) return; // session is busy; try again next tick
        const message = ping.message ?? "hi";
        this.enqueue(message, now);
        this.state.markPing(key);
        this.log(`auto ping ${entry}: sent ${JSON.stringify(message)} into the session`);
        return;
      }
    }
  }

  // ---- typing ------------------------------------------------------

  private enqueue(message: string, at: number): void {
    this.queue.push({ at, payload: message });
    this.queue.push({ at: at + ENTER_DELAY_MS, payload: "\r" });
    this.queue.sort((a, b) => a.at - b.at);
  }
}

export function humanize(ms: number): string {
  const seconds = Math.max(Math.floor(ms / 1000), 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}`;
  if (minutes) return `${minutes}min`;
  return `${seconds % 60}s`;
}
