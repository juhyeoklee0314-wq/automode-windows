/**
 * Timezone discovery and wall-clock arithmetic.
 *
 * Python hands you `zoneinfo` and naive datetimes, which makes "the next time
 * the clock in Sao Paulo reads 18:20" a one-liner. Node has neither: a Date is
 * an instant, and `Intl` will only ever tell you what a given instant looks
 * like in a zone. It has no inverse.
 *
 * So we build the inverse: guess the instant, ask Intl what offset applies
 * there, correct, and ask again in case the correction crossed a DST boundary.
 * Everything else in this file rests on that.
 */

const SLACK_MS = 2 * 60 * 1000;

/** Monday is 0, matching the weekday names the agents print. */
export const WEEKDAYS: Record<string, number> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

/** The system timezone, as an IANA name. */
export function localTzName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Whether a zone name is one Intl actually knows. */
export function isKnownTz(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** A usable zone: the one asked for, else the system one, else UTC. */
export function resolveTz(name?: string | null): string {
  if (name && isKnownTz(name)) return name;
  const local = localTzName();
  return isKnownTz(local) ? local : "UTC";
}

// hourCycle h23 on purpose: `hour12: false` reports midnight as hour 24 in
// some engines, which silently shifts a date by a day.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let found = formatters.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, found);
  }
  return found;
}

/** What the clock in `tz` reads at this instant. */
export function wallClockAt(instant: Date, tz: string): WallClock & { weekday: number } {
  const parts = formatter(tz).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const short = (get("weekday") || "Sun").slice(0, 3).toLowerCase();
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS[short] ?? names.indexOf(short),
  };
}

/** How far `tz` is from UTC at this instant, in milliseconds. */
function offsetMsAt(instant: Date, tz: string): number {
  const w = wallClockAt(instant, tz);
  const parts = formatter(tz).formatToParts(instant);
  const seconds = Number(parts.find((p) => p.type === "second")?.value ?? "0");
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, seconds);
  // Intl gives whole seconds; the instant's own ms would otherwise leak in.
  return asIfUtc - (instant.getTime() - instant.getUTCMilliseconds());
}

/**
 * The instant at which the clock in `tz` reads this wall time.
 *
 * This is the inverse Intl does not give you. Guess, measure the offset there,
 * correct, and measure again: the first correction can land on the other side
 * of a DST change, and then the first offset was the wrong one.
 */
export function zonedToInstant(wall: WallClock, tz: string): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const first = offsetMsAt(new Date(guess), tz);
  const corrected = guess - first;
  const second = offsetMsAt(new Date(corrected), tz);
  return new Date(second === first ? corrected : guess - second);
}

/** Shift a wall-clock date by whole days, on the calendar, ignoring zones. */
function addDays(wall: WallClock, days: number): WallClock {
  const shifted = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day + days, wall.hour, wall.minute),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  };
}

/**
 * The next instant at which the clock in `tz` reads hour:minute.
 *
 * A reading that just went by counts as now rather than a whole day away: the
 * agent prints the message a beat before the clock rolls over.
 */
export function nextOccurrence(
  now: Date,
  hour: number,
  minute: number,
  tz: string,
  weekday?: number,
): Date {
  const today = wallClockAt(now, tz);
  const base: WallClock = {
    year: today.year,
    month: today.month,
    day: today.day,
    hour,
    minute,
  };
  const floor = now.getTime() - SLACK_MS;

  if (weekday === undefined) {
    const candidate = zonedToInstant(base, tz);
    if (candidate.getTime() >= floor) return candidate;
    return zonedToInstant(addDays(base, 1), tz);
  }

  for (let days = 0; days < 8; days += 1) {
    const shifted = addDays(base, days);
    const candidate = zonedToInstant(shifted, tz);
    if (wallClockAt(candidate, tz).weekday !== weekday) continue;
    if (candidate.getTime() >= floor) return candidate;
  }
  return zonedToInstant(base, tz);
}

/** Convert a 12-hour clock reading to 24-hour. */
export function to24h(hour: number, ampm?: string | null): number {
  if (!ampm) return hour % 24;
  if (ampm.toLowerCase().startsWith("p")) return (hour % 12) + 12;
  return hour % 12;
}

/** Parse a "HH:MM" config entry. */
export function parseHhmm(text: string): [number, number] | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return [hour, minute];
}

/** Format an instant as the clock in `tz` reads it. */
export function formatInZone(instant: Date, tz: string, withDate = false): string {
  const w = wallClockAt(instant, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(w.hour)}:${pad(w.minute)}`;
  return withDate ? `${pad(w.day)}/${pad(w.month)} ${time}` : time;
}
