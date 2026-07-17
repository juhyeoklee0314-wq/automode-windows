import assert from "node:assert/strict";
import test, { describe } from "node:test";

import * as detect from "../src/agents/detect.js";
import * as dialogs from "../src/agents/dialogs.js";
import { zonedToInstant } from "../src/core/timeutil.js";

const SP = "America/Sao_Paulo";

function at(y: number, mo: number, d: number, h: number, mi = 0): Date {
  return zonedToInstant({ year: y, month: mo, day: d, hour: h, minute: mi }, SP);
}

describe("stripping ANSI out of a stream", () => {
  test("removes colors and cursor moves", () => {
    const [clean, left] = detect.stripAnsiStream("\x1b[31mred\x1b[0m\x1b[2J done");
    assert.equal(clean, "red done");
    assert.equal(left, "");
  });

  test("holds back a sequence split across two reads", () => {
    let [clean, left] = detect.stripAnsiStream("ok\x1b[3");
    assert.equal(clean, "ok");
    assert.equal(left, "\x1b[3");
    [clean, left] = detect.stripAnsiStream(left + "1mred");
    assert.equal(clean, "red");
    assert.equal(left, "");
  });

  test("drops a stray ESC that never terminates", () => {
    const [clean, left] = detect.stripAnsiStream("\x1b" + "x".repeat(60));
    assert.equal(clean, "x".repeat(60));
    assert.equal(left, "");
  });

  test("strips the window title sequence", () => {
    const [clean] = detect.stripAnsiStream("\x1b]0;my title\x07hello");
    assert.equal(clean, "hello");
  });
});

describe("normalizing", () => {
  test("flattens box borders and wrapping", () => {
    const raw =
      "╭──────────────╮\r\n" +
      "│ You've hit your usage limit. Try   │\r\n" +
      "│ again in 2 hours 5 minutes.        │\r\n" +
      "╰──────────────╯\r\n";
    assert.equal(
      detect.normalize(raw),
      " You've hit your usage limit. Try again in 2 hours 5 minutes. ",
    );
  });
});

describe("reading limit messages", () => {
  test("codex, absolute date", () => {
    const hit = detect.scan(detect.normalize(detect.SAMPLES[0]!), at(2026, 7, 16, 20), SP);
    assert.equal(hit?.kind, "absolute");
    assert.equal(hit?.resetAt.getTime(), at(2026, 7, 23, 1, 16).getTime());
  });

  test("claude session limit, with a timezone", () => {
    const hit = detect.scan(
      detect.normalize(detect.SAMPLES[1]!),
      at(2026, 7, 16, 14, 30),
      SP,
    );
    assert.equal(hit?.kind, "clock");
    assert.equal(hit?.resetAt.getTime(), at(2026, 7, 16, 18, 20).getTime());
  });

  test("the will-reset-at wording", () => {
    const hit = detect.scan(
      detect.normalize(detect.SAMPLES[2]!),
      at(2026, 7, 16, 14, 30),
      SP,
    );
    assert.equal(hit?.resetAt.getTime(), at(2026, 7, 16, 16, 0).getTime());
  });

  test("weekly limit, with a weekday", () => {
    // 2026-07-16 is a Thursday; next Tuesday is the 21st.
    const hit = detect.scan(
      detect.normalize(detect.SAMPLES[3]!),
      at(2026, 7, 16, 14, 30),
      SP,
    );
    assert.equal(hit?.resetAt.getTime(), at(2026, 7, 21, 9, 0).getTime());
  });

  test("five-hour limit, no timezone", () => {
    const hit = detect.scan(detect.normalize(detect.SAMPLES[4]!), at(2026, 7, 16, 13), SP);
    assert.equal(hit?.resetAt.getTime(), at(2026, 7, 16, 15, 45).getTime());
  });

  test("relative wording", () => {
    const now = at(2026, 7, 16, 13);
    const hit = detect.scan(detect.normalize(detect.SAMPLES[5]!), now, SP);
    assert.equal(hit?.kind, "relative");
    assert.equal(hit?.resetAt.getTime(), now.getTime() + (4 * 60 + 32) * 60_000);
  });

  test("a reading already past rolls to tomorrow", () => {
    const hit = detect.scan(
      detect.normalize("You've hit your session limit · resets 12:20am"),
      at(2026, 7, 16, 23, 50),
      SP,
    );
    assert.equal(hit?.resetAt.getTime(), at(2026, 7, 17, 0, 20).getTime());
  });

  test("noon and midnight are not swapped", () => {
    const hit = detect.scan(
      detect.normalize("session limit reached · resets 12:00pm"),
      at(2026, 7, 16, 6),
      SP,
    );
    assert.equal(hit?.resetAt.getTime(), at(2026, 7, 16, 12, 0).getTime());
  });

  test("a message barely past counts as now", () => {
    const hit = detect.scan(
      detect.normalize("You've hit your session limit · resets 6:20pm"),
      at(2026, 7, 16, 18, 21),
      SP,
    );
    assert.equal(hit?.resetAt.getTime(), at(2026, 7, 16, 18, 20).getTime());
  });

  test("finds it wrapped inside the TUI frame", () => {
    const raw =
      "\x1b[2J\x1b[H╭────────────────────────────────╮\r\n" +
      "│ \x1b[31m■\x1b[0m You've hit your usage limit.  │\r\n" +
      "│ visit https://chatgpt.com/codex/settings/usage to    │\r\n" +
      "│ purchase more credits or try again at Jul 23rd,      │\r\n" +
      "│ 2026 1:16 AM.                                        │\r\n" +
      "╰────────────────────────────────╯\r\n";
    const [clean] = detect.stripAnsiStream(raw);
    const hit = detect.scan(detect.normalize(clean), at(2026, 7, 16, 14), SP);
    assert.equal(hit?.resetAt.getTime(), at(2026, 7, 23, 1, 16).getTime());
  });

  test("the latest message on screen wins", () => {
    const hit = detect.scan(
      detect.normalize(
        "You've hit your session limit · resets 11:00am ... scrollback ... " +
          "You've hit your session limit · resets 3:00pm",
      ),
      at(2026, 7, 16, 10),
      SP,
    );
    assert.equal(hit?.resetAt.getTime(), at(2026, 7, 16, 15, 0).getTime());
  });
});

describe("not firing on things that are not limits", () => {
  test("no trigger means no hit", () => {
    const text = detect.normalize("the meeting resets 6:20pm and then we ship");
    assert.equal(detect.scan(text, at(2026, 7, 16, 14), SP), null);
  });

  test("a trigger with no time is ignored", () => {
    const text = detect.normalize("You've hit your usage limit. Upgrade to Pro.");
    assert.equal(detect.scan(text, at(2026, 7, 16, 14), SP), null);
  });

  test("a time too far from the trigger is ignored", () => {
    const text = detect.normalize(
      "You've hit your usage limit." + " filler".repeat(120) + " resets 6:20pm",
    );
    assert.equal(detect.scan(text, at(2026, 7, 16, 14), SP), null);
  });

  test("plausibility", () => {
    const now = at(2026, 7, 16, 14);
    assert.ok(detect.plausible(new Date(now.getTime() + 5 * 3_600_000), now));
    assert.ok(!detect.plausible(new Date(now.getTime() + 400 * 86_400_000), now));
    assert.ok(!detect.plausible(new Date(now.getTime() - 2 * 86_400_000), now));
  });
});

describe("the blocking menus", () => {
  test("every known prompt is answered correctly", () => {
    for (const sample of dialogs.SAMPLES) {
      const answer = dialogs.find(detect.normalize(sample.text));
      assert.equal(answer?.name, sample.name);
      assert.equal(answer?.key, sample.key, sample.name);
    }
  });

  test("claude: picks wait, not upgrade", () => {
    const answer = dialogs.find(
      detect.normalize(
        "What do you want to do? ❯ 1. Upgrade your plan " +
          "2. Upgrade to Team plan 3. Stop and wait for limit to reset",
      ),
    );
    assert.equal(answer?.key, "3");
  });

  test("the option number is read, not assumed", () => {
    const answer = dialogs.find(
      detect.normalize(
        "What do you want to do? 1. Stop and wait for limit to reset 2. Upgrade your plan",
      ),
    );
    assert.equal(answer?.key, "1");
  });

  test("codex: never-show-again is not mistaken for keep", () => {
    const answer = dialogs.find(detect.normalize(dialogs.SAMPLES[1]!.text));
    assert.equal(answer?.key, "2");
    assert.notEqual(answer?.key, "3");
  });

  test("the menu wrapped in a TUI frame", () => {
    const raw =
      "\x1b[2J╭────────────────────────────╮\r\n" +
      "│ \x1b[1mWhat do you want to do?\x1b[0m    │\r\n" +
      "│ ❯ 1. Upgrade your plan        │\r\n" +
      "│   2. Upgrade to Team plan     │\r\n" +
      "│   3. Stop and wait for limit  │\r\n" +
      "│      to reset                 │\r\n" +
      "╰────────────────────────────╯\r\n";
    const [clean] = detect.stripAnsiStream(raw);
    assert.equal(dialogs.find(detect.normalize(clean))?.key, "3");
  });

  test("context is required", () => {
    assert.equal(dialogs.find("3. Stop and wait for limit to reset"), null);
    assert.equal(dialogs.find("2. Keep current model"), null);
  });

  test("ordinary screen text is not a prompt", () => {
    for (const text of [
      "",
      "the model is fine, keep current model settings",
      "What do you want to do? 1. Deploy 2. Rollback",
      "You've hit your session limit · resets 6:20pm",
    ]) {
      assert.equal(dialogs.find(text), null, text);
    }
  });
});
