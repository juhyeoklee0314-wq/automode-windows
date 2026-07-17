/**
 * Prompts the agents put on screen when you hit the limit.
 *
 * Hitting the limit does not just print a message. It leaves the agent sitting
 * on a menu, waiting for an answer:
 *
 *     What do you want to do?
 *     > 1. Upgrade your plan
 *       2. Upgrade to Team plan
 *       3. Stop and wait for limit to reset
 *
 * Typing `continue` at that screen picks nothing and goes nowhere. The blocking
 * choice has to be answered first.
 *
 * The option number is read out of the text rather than hardcoded, so a
 * reordered menu still gets the right answer.
 */

export interface Prompt {
  name: string;
  /** Group 1 must capture the number of the option we want. */
  pattern: RegExp;
  /** What the screen must also contain, to be sure this is really the prompt. */
  context: RegExp;
}

export const PROMPTS: Prompt[] = [
  {
    // claude: waiting is the whole point; the other options cost money.
    name: "claude-wait-for-reset",
    pattern: /(\d)\s*\.\s*Stop and wait for (?:the )?limit to reset/i,
    context: /What do you want to do\?/i,
  },
  {
    // codex: keep the model we are on. The "(never show again)" variant is a
    // different option and must not be mistaken for this one.
    name: "codex-keep-model",
    pattern: /(\d)\s*\.\s*Keep current model(?!\s*\(never)/i,
    context: /Approaching rate limits|Switch to \S+ for lower/i,
  },
];

export interface Answer {
  name: string;
  key: string;
}

/** The blocking prompt on screen, and the key that dismisses it. */
export function find(text: string): Answer | null {
  for (const prompt of PROMPTS) {
    if (!prompt.context.test(text)) continue;
    const match = prompt.pattern.exec(text);
    if (match?.[1]) return { name: prompt.name, key: match[1] };
  }
  return null;
}

export const SAMPLES: Array<{ name: string; key: string; text: string }> = [
  {
    name: "claude-wait-for-reset",
    key: "3",
    text:
      "What do you want to do? " +
      "❯ 1. Upgrade your plan " +
      "2. Upgrade to Team plan " +
      "3. Stop and wait for limit to reset",
  },
  {
    name: "codex-keep-model",
    key: "2",
    text:
      "Approaching rate limits Switch to gpt-5.4-mini for lower credit usage? " +
      "1. Switch to gpt-5.4-mini Small, fast, and cost-efficient model for " +
      "simpler coding tasks. › 2. Keep current model " +
      "3. Keep current model (never show again) Hide future rate limit " +
      "reminders about switching models. Press enter to confirm or esc to go back",
  },
];
