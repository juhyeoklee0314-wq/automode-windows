import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { Controller } from "../src/controller.js";
import { DEFAULTS, type Config } from "../src/core/config.js";
import type { StateStore } from "../src/core/state.js";
import { zonedToInstant } from "../src/core/timeutil.js";

const SP = "America/Sao_Paulo";

function at(y: number, mo: number, d: number, h: number, mi = 0): Date {
  return zonedToInstant({ year: y, month: mo, day: d, hour: h, minute: mi }, SP);
}

class FakeState implements StateStore {
  fired = new Set<string>();
  pingFired(key: string) {
    return this.fired.has(key);
  }
  markPing(key: string) {
    this.fired.add(key);
  }
}

/** A controller plus the wiring the pty runner would normally provide. */
class Harness {
  now: Date;
  state = new FakeState();
  logs: string[] = [];
  typed = "";
  controller: Controller;

  constructor(start: Date, overrides: Partial<Config> = {}, ping: Partial<Config["ping"]> = {}) {
    this.now = start;
    const config: Config = {
      ...structuredClone(DEFAULTS),
      timezone: SP,
      notify: false,
      ...overrides,
      ping: { ...DEFAULTS.ping, ...ping },
    };
    this.controller = new Controller(
      config,
      (m) => this.logs.push(m),
      this.state,
      () => this.now,
    );
  }

  output(text: string) {
    this.controller.onOutput(text);
  }
  keypress() {
    this.controller.onUserInput(Buffer.from("x"));
  }
  tick() {
    this.controller.tick((payload) => {
      this.typed += payload;
    });
  }
  advance(ms: number) {
    this.now = new Date(this.now.getTime() + ms);
  }
  runFor(seconds: number, step = 1) {
    for (let i = 0; i < Math.floor(seconds / step); i += 1) {
      this.advance(step * 1000);
      this.tick();
    }
  }
}

const LIMIT = "You've hit your session limit · resets 6:20pm (America/Sao_Paulo)";

const CLAUDE_MENU =
  "You've hit your session limit · resets 6:20pm (America/Sao_Paulo) " +
  "What do you want to do? ❯ 1. Upgrade your plan " +
  "2. Upgrade to Team plan 3. Stop and wait for limit to reset";

const CODEX_MENU =
  "■ You've hit your usage limit. Upgrade to Pro or try again at Jul 16th, 2026 8:00 PM. " +
  "Approaching rate limits Switch to gpt-5.4-mini for lower credit usage? " +
  "1. Switch to gpt-5.4-mini › 2. Keep current model " +
  "3. Keep current model (never show again)";

describe("auto continue", () => {
  test("types continue one grace after the reset", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60 });
    h.output(LIMIT);
    assert.equal(h.typed, "");
    h.runFor(21 * 60 + 5);
    assert.equal(h.typed, "continue\r");
  });

  test("nothing happens before the reset", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60 });
    h.output(LIMIT);
    h.runFor(19 * 60);
    assert.equal(h.typed, "");
  });

  test("redraws do not queue a second continue", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60 });
    for (let i = 0; i < 50; i += 1) {
      h.advance(1000);
      h.output(LIMIT);
    }
    h.runFor(25 * 60);
    assert.equal(h.typed, "continue\r");
  });

  test("auto continue off types nothing", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { auto_continue: false });
    h.output(LIMIT);
    h.runFor(30 * 60);
    assert.equal(h.typed, "");
    assert.ok(h.logs.some((l) => l.includes("auto continue is off")));
  });

  test("waits while you are typing", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60, idle_guard_seconds: 10 });
    h.output(LIMIT);
    h.advance(21 * 60 * 1000);
    h.keypress();
    h.tick();
    assert.equal(h.typed, "");
    h.runFor(30);
    assert.equal(h.typed, "continue\r");
  });

  test("a custom message", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60, continue_message: "segue" });
    h.output(LIMIT);
    h.runFor(25 * 60);
    assert.equal(h.typed, "segue\r");
  });

  test("a new limit later arms again", () => {
    const h = new Harness(at(2026, 7, 16, 12, 0), { grace_seconds: 60 });
    h.output("You've hit your session limit · resets 1:00pm");
    h.runFor(70 * 60);
    assert.equal(h.typed, "continue\r");
    h.output("You've hit your session limit · resets 6:00pm");
    h.runFor(5 * 60 * 60);
    assert.equal(h.typed, "continue\rcontinue\r");
  });

  test("a message split across reads", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60 });
    for (const chunk of ["You've hit your ", "session limit · rese", "ts 6:20pm"]) h.output(chunk);
    h.runFor(25 * 60);
    assert.equal(h.typed, "continue\r");
  });

  test("ANSI split across reads does not break detection", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60 });
    h.output("\x1b[31mYou've hit your session limit · resets 6:2");
    h.output("0pm\x1b[0m");
    h.runFor(25 * 60);
    assert.equal(h.typed, "continue\r");
  });

  test("a nonsense reset is ignored", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0));
    h.output("You've hit your usage limit. Try again at Jul 23rd, 2099 1:16 AM.");
    h.runFor(60 * 60);
    assert.equal(h.typed, "");
  });
});

describe("the blocking menu", () => {
  test("answers the claude menu before continuing", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60 });
    h.output(CLAUDE_MENU);
    h.runFor(22 * 60);
    assert.equal(h.typed, "3\rcontinue\r");
  });

  test("answers the codex menu before continuing", () => {
    const h = new Harness(at(2026, 7, 16, 19, 0), { grace_seconds: 60 });
    h.output(CODEX_MENU);
    h.runFor(70 * 60);
    assert.equal(h.typed, "2\rcontinue\r");
  });

  test("the answer comes first and the continue waits", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60 });
    h.output(CLAUDE_MENU);
    h.advance(21 * 60 * 1000);
    h.tick();
    assert.equal(h.typed, "3", "the message must not be glued to the menu key");
    h.runFor(3);
    assert.equal(h.typed, "3\rcontinue\r");
  });

  test("no menu means no stray keypress", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60 });
    h.output(LIMIT);
    h.runFor(22 * 60);
    assert.equal(h.typed, "continue\r");
  });

  test("does not answer if you were at the keyboard", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60 });
    h.output(CLAUDE_MENU);
    h.advance(5 * 60 * 1000);
    h.keypress(); // you picked the option yourself
    h.runFor(20 * 60);
    assert.equal(h.typed, "continue\r");
  });

  test("can be turned off", () => {
    const h = new Harness(at(2026, 7, 16, 18, 0), { grace_seconds: 60, answer_limit_prompt: false });
    h.output(CLAUDE_MENU);
    h.runFor(22 * 60);
    assert.equal(h.typed, "continue\r");
  });
});

describe("auto ping", () => {
  const on = { enabled: true, times: ["05:00"], idle_seconds: 20 };

  test("fires at the scheduled time when idle", () => {
    const h = new Harness(at(2026, 7, 16, 4, 59), {}, on);
    h.runFor(120);
    assert.equal(h.typed, "hi\r");
  });

  test("does not fire before the time", () => {
    const h = new Harness(at(2026, 7, 16, 4, 0), {}, on);
    h.runFor(30 * 60);
    assert.equal(h.typed, "");
  });

  test("fires only once per day", () => {
    const h = new Harness(at(2026, 7, 16, 4, 59), {}, on);
    h.runFor(20 * 60);
    assert.equal(h.typed, "hi\r");
  });

  test("waits for a quiet session", () => {
    const h = new Harness(at(2026, 7, 16, 4, 59), {}, on);
    h.advance(2 * 60 * 1000);
    h.output("agent is busy working");
    h.tick();
    assert.equal(h.typed, "");
    h.runFor(60);
    assert.equal(h.typed, "hi\r");
  });

  test("catches up after the machine slept through it", () => {
    const h = new Harness(at(2026, 7, 16, 5, 10), {}, { ...on, catchup_minutes: 30 });
    h.runFor(60);
    assert.equal(h.typed, "hi\r");
  });

  test("gives up outside the catch-up window", () => {
    const h = new Harness(at(2026, 7, 16, 7, 0), {}, { ...on, catchup_minutes: 30 });
    h.runFor(60);
    assert.equal(h.typed, "");
  });

  test("disabled does nothing", () => {
    const h = new Harness(at(2026, 7, 16, 4, 59), {}, { ...on, enabled: false });
    h.runFor(20 * 60);
    assert.equal(h.typed, "");
  });

  test("two slots both fire", () => {
    const h = new Harness(at(2026, 7, 16, 4, 59), {}, { ...on, times: ["05:00", "17:00"] });
    h.runFor(60 * 60, 10);
    assert.equal(h.typed, "hi\r");
    h.runFor(12 * 60 * 60, 10);
    assert.equal(h.typed, "hi\rhi\r");
  });

  test("an invalid time is skipped, not crashed on", () => {
    const h = new Harness(at(2026, 7, 16, 4, 59), {}, { ...on, times: ["not-a-time", "05:00"] });
    h.runFor(120);
    assert.equal(h.typed, "hi\r");
  });

  test("a ping does not collide with a pending continue", () => {
    const h = new Harness(at(2026, 7, 16, 4, 50), { grace_seconds: 60 }, on);
    h.output("You've hit your session limit · resets 6:00am");
    h.runFor(15 * 60);
    assert.equal(h.typed, "");
  });
});
