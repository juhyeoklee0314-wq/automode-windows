/**
 * Find usage-limit messages in a live TUI byte stream.
 *
 * The agents redraw their whole screen constantly and wrap the message inside
 * box borders, so the text never arrives as one clean line. Everything here
 * exists to turn that mess back into a flat string a regex can read.
 */

import {
  WEEKDAYS,
  nextOccurrence,
  resolveTz,
  to24h,
  zonedToInstant,
} from "../core/timeutil.js";

// CSI (colors, cursor moves), OSC (window title), DCS and friends, and the
// two-byte escapes. The last range deliberately skips 0x5b, which is CSI and
// is handled by the first branch.
const ANSI_SOURCE =
  "\\x1b\\[[0-9;?]*[ -/]*[@-~]" +
  "|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)" +
  "|\\x1b[PX^_][^\\x1b]*\\x1b\\\\" +
  "|\\x1b[\\x40-\\x5a\\x5c-\\x5f]";
const ANSI_AT = new RegExp(ANSI_SOURCE, "y");

/**
 * An escape sequence split across two reads is held for the next chunk. Past
 * this length it is not a real sequence, just a stray ESC byte.
 */
const MAX_ESC_HOLD = 32;

const BOX = /[─-╿]/g; // box drawing: the TUI frame
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const WHITESPACE = /\s+/g;

// Match in two steps: a trigger phrase first, then a time reading close to it.
// One big regex would happily fire on any "resets 6pm" elsewhere on screen.
const TRIGGER =
  /(?:hit|reached)\s+(?:your\s+)?(?:[\w-]+\s+){0,3}limit|limit\s+(?:has\s+been\s+)?reached|usage\s+limit|out\s+of\s+(?:usage|credits)/gi;
const WINDOW_CHARS = 400;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// codex: "... or try again at Jul 23rd, 2026 1:16 AM."
const ABSOLUTE =
  /try\s+again\s+at\s+(?<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?<year>\d{4})\s+(?<hour>\d{1,2}):(?<min>\d{2})\s*(?<ampm>[ap])\.?m\.?/i;

// claude: "resets 6:20pm (America/Sao_Paulo)", "will reset at 4pm", "resets Tue 9am"
const CLOCK =
  /resets?\s*(?:at|on)?\s+(?:(?<dow>mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(?<hour>\d{1,2})(?::(?<min>\d{2}))?\s*(?<ampm>am|pm)(?:\s*\((?<tz>[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*)\))?/i;

const RELATIVE =
  /(?:try\s+again|resets?)\s+in\s+(?:(?<hours>\d+)\s*(?:hours?|hrs?|h)\b)?\s*(?:(?:and\s+)?(?<mins>\d+)\s*(?:minutes?|mins?|m)\b)?/i;

/** A reset further out than this is a misread, not a rate limit. */
const MAX_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_PAST_MS = 60 * 60 * 1000;

export interface LimitHit {
  resetAt: Date;
  kind: "absolute" | "clock" | "relative";
  raw: string;
}

/**
 * Remove escape sequences, returning [clean, leftover].
 *
 * `leftover` is a sequence that looks cut off at the end of the chunk; feed it
 * back in front of the next read.
 */
export function stripAnsiStream(text: string): [string, string] {
  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "\x1b") {
      out.push(text[index]!);
      index += 1;
      continue;
    }
    ANSI_AT.lastIndex = index;
    if (ANSI_AT.exec(text)) {
      index = ANSI_AT.lastIndex;
      continue;
    }
    if (text.length - index < MAX_ESC_HOLD) return [out.join(""), text.slice(index)];
    index += 1; // unterminated and too long to be real: drop the ESC
  }
  return [out.join(""), ""];
}

/** Flatten borders, control bytes and line wrapping into single spaces. */
export function normalize(text: string): string {
  return text.replace(BOX, " ").replace(CONTROL, " ").replace(WHITESPACE, " ");
}

/** Find the most recent limit message in a normalized buffer. */
export function scan(text: string, now: Date, defaultTz: string): LimitHit | null {
  let hit: LimitHit | null = null;
  TRIGGER.lastIndex = 0;
  for (const trigger of text.matchAll(TRIGGER)) {
    const start = trigger.index ?? 0;
    const found = parseWindow(text.slice(start, start + WINDOW_CHARS), now, defaultTz);
    if (found) hit = found; // the last one on screen wins
  }
  return hit;
}

function parseWindow(window: string, now: Date, tz: string): LimitHit | null {
  const absolute = ABSOLUTE.exec(window);
  if (absolute?.groups) {
    const g = absolute.groups;
    const month = MONTHS[g.mon!.toLowerCase().slice(0, 3)];
    if (!month) return null;
    const when = zonedToInstant(
      {
        year: Number(g.year),
        month,
        day: Number(g.day),
        hour: to24h(Number(g.hour), g.ampm),
        minute: Number(g.min),
      },
      tz,
    );
    return { resetAt: when, kind: "absolute", raw: absolute[0] };
  }

  const clock = CLOCK.exec(window);
  if (clock?.groups) {
    const g = clock.groups;
    const hour = to24h(Number(g.hour), g.ampm);
    const minute = Number(g.min ?? 0);
    if (hour > 23 || minute > 59) return null;
    const zone = g.tz ? resolveTz(g.tz) : tz;
    const weekday = g.dow ? WEEKDAYS[g.dow.toLowerCase().slice(0, 3)] : undefined;
    return {
      resetAt: nextOccurrence(now, hour, minute, zone, weekday),
      kind: "clock",
      raw: clock[0],
    };
  }

  const relative = RELATIVE.exec(window);
  if (relative?.groups && (relative.groups.hours || relative.groups.mins)) {
    const ms =
      Number(relative.groups.hours ?? 0) * 3_600_000 +
      Number(relative.groups.mins ?? 0) * 60_000;
    return { resetAt: new Date(now.getTime() + ms), kind: "relative", raw: relative[0] };
  }

  return null;
}

/** Reject readings that cannot be a real rate-limit reset. */
export function plausible(resetAt: Date, now: Date): boolean {
  const delta = resetAt.getTime() - now.getTime();
  return delta >= -MAX_PAST_MS && delta <= MAX_HORIZON_MS;
}

export const SAMPLES = [
  "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), " +
    "visit https://chatgpt.com/codex/settings/usage to purchase more credits or try " +
    "again at Jul 23rd, 2026 1:16 AM.",
  "You've hit your session limit · resets 6:20pm (America/Sao_Paulo)",
  "Claude usage limit reached. Your limit will reset at 4pm (America/Sao_Paulo).",
  "You've hit your weekly limit · resets Tue 9am",
  "5-hour limit reached ∙ resets 3:45pm",
  "You've hit your usage limit. Try again in 4 hours 32 minutes.",
];
