import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  formatInZone,
  localTzName,
  nextOccurrence,
  parseHhmm,
  resolveTz,
  to24h,
  wallClockAt,
  zonedToInstant,
} from "../src/core/timeutil.js";

const SP = "America/Sao_Paulo";
const NY = "America/New_York";

/** An instant, written the way a person in that zone would read the clock. */
function at(tz: string, y: number, mo: number, d: number, h: number, mi = 0): Date {
  return zonedToInstant({ year: y, month: mo, day: d, hour: h, minute: mi }, tz);
}

describe("reading the clock in a zone", () => {
  test("round-trips a wall clock through an instant and back", () => {
    const instant = at(SP, 2026, 7, 16, 18, 20);
    const wall = wallClockAt(instant, SP);
    assert.equal(wall.hour, 18);
    assert.equal(wall.minute, 20);
    assert.equal(wall.day, 16);
  });

  test("the same instant reads differently in two zones", () => {
    const instant = at(SP, 2026, 7, 16, 18, 0);
    assert.equal(wallClockAt(instant, SP).hour, 18);
    assert.equal(wallClockAt(instant, "UTC").hour, 21); // Sao Paulo is UTC-3
  });

  test("midnight is hour 0, not hour 24", () => {
    // `hour12: false` reports midnight as 24 in some engines, which shifts the
    // date by a day. This is why the formatter uses hourCycle h23.
    const wall = wallClockAt(at(SP, 2026, 7, 16, 0, 30), SP);
    assert.equal(wall.hour, 0);
    assert.equal(wall.day, 16);
  });

  test("knows the weekday, counting from Monday", () => {
    // 2026-07-16 is a Thursday.
    assert.equal(wallClockAt(at(SP, 2026, 7, 16, 12), SP).weekday, 3);
  });
});

describe("next occurrence", () => {
  test("later today", () => {
    const now = at(SP, 2026, 7, 16, 9, 0);
    assert.equal(
      nextOccurrence(now, 18, 20, SP).getTime(),
      at(SP, 2026, 7, 16, 18, 20).getTime(),
    );
  });

  test("already passed rolls to tomorrow", () => {
    const now = at(SP, 2026, 7, 16, 19, 0);
    assert.equal(
      nextOccurrence(now, 18, 20, SP).getTime(),
      at(SP, 2026, 7, 17, 18, 20).getTime(),
    );
  });

  test("a reading that just went by counts as now", () => {
    const now = at(SP, 2026, 7, 16, 18, 21);
    assert.equal(
      nextOccurrence(now, 18, 20, SP).getTime(),
      at(SP, 2026, 7, 16, 18, 20).getTime(),
    );
  });

  test("weekday target", () => {
    // Thursday, asking for Tuesday: the 21st.
    const now = at(SP, 2026, 7, 16, 14, 0);
    assert.equal(
      nextOccurrence(now, 9, 0, SP, 1).getTime(),
      at(SP, 2026, 7, 21, 9, 0).getTime(),
    );
  });

  test("weekday today but later today", () => {
    const now = at(SP, 2026, 7, 16, 8, 0);
    assert.equal(
      nextOccurrence(now, 9, 0, SP, 3).getTime(),
      at(SP, 2026, 7, 16, 9, 0).getTime(),
    );
  });

  test("midnight tonight", () => {
    const now = at(SP, 2026, 7, 16, 23, 50);
    assert.equal(
      nextOccurrence(now, 0, 20, SP).getTime(),
      at(SP, 2026, 7, 17, 0, 20).getTime(),
    );
  });
});

describe("daylight saving", () => {
  test("9am the next morning is 9am on the clock, not 24h later", () => {
    // US DST starts 2026-03-08. The clock jumps 02:00 to 03:00, so the night is
    // 23 real hours long, and 9am is still 9am.
    const now = at(NY, 2026, 3, 7, 12, 0);
    const target = nextOccurrence(now, 9, 0, NY);
    assert.equal(wallClockAt(target, NY).hour, 9);
    assert.equal(wallClockAt(target, NY).day, 8);
    const hours = (target.getTime() - at(NY, 2026, 3, 7, 9, 0).getTime()) / 3_600_000;
    assert.equal(hours, 23, "the DST night is 23 hours, not 24");
  });

  test("and the same in autumn, when the night is 25 hours", () => {
    // US DST ends 2026-11-01.
    const now = at(NY, 2026, 10, 31, 12, 0);
    const target = nextOccurrence(now, 9, 0, NY);
    assert.equal(wallClockAt(target, NY).hour, 9);
    const hours = (target.getTime() - at(NY, 2026, 10, 31, 9, 0).getTime()) / 3_600_000;
    assert.equal(hours, 25);
  });

  test("a wall time that never happened lands on a real instant", () => {
    // 02:30 on 2026-03-08 does not exist in New York: the clock skips it.
    const instant = zonedToInstant(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      NY,
    );
    assert.ok(!Number.isNaN(instant.getTime()));
    assert.equal(wallClockAt(instant, NY).day, 8);
  });
});

describe("odds and ends", () => {
  test("am/pm, and the two that trip people up", () => {
    assert.equal(to24h(1, "am"), 1);
    assert.equal(to24h(1, "pm"), 13);
    assert.equal(to24h(12, "am"), 0);
    assert.equal(to24h(12, "pm"), 12);
  });

  test("parses HH:MM", () => {
    assert.deepEqual(parseHhmm("05:00"), [5, 0]);
    assert.deepEqual(parseHhmm(" 17:30 "), [17, 30]);
  });

  test("refuses what is not a time", () => {
    for (const bad of ["", "5", "25:00", "12:60", "abc", "12:aa", "1:2:3"]) {
      assert.equal(parseHhmm(bad), null, bad);
    }
  });

  test("falls back to a usable zone", () => {
    assert.equal(resolveTz(SP), SP);
    assert.ok(resolveTz("Not/AZone").length > 0);
    assert.ok(resolveTz(null).length > 0);
    assert.ok(localTzName().length > 0);
  });

  test("formats as the zone reads it", () => {
    assert.equal(formatInZone(at(SP, 2026, 7, 16, 18, 20), SP), "18:20");
    assert.equal(formatInZone(at(SP, 2026, 7, 16, 18, 20), SP, true), "16/07 18:20");
  });
});
