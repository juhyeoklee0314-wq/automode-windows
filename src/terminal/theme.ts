/**
 * Colors for the overlay, picked from the agent it is floating over.
 *
 * 256-color rather than truecolor on purpose: macOS Terminal.app still does
 * not do 24-bit, and this has to look right in whatever terminal you already
 * use.
 */

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
/** Ends bold without dropping the color, unlike RESET. */
export const NOBOLD = "\x1b[22m";
export const DIM = "\x1b[2m";

export interface Theme {
  name: string;
  accent: string; // border and title
  select: string; // the highlighted row bar
}

/** 173 is the closest 256-color step to Claude's terracotta (#d7875f). */
export const CLAUDE: Theme = {
  name: "claude",
  accent: "\x1b[38;5;173m",
  select: "\x1b[48;5;173m\x1b[30m",
};
/** Codex gets the blue. */
export const CODEX: Theme = {
  name: "codex",
  accent: "\x1b[38;5;39m",
  select: "\x1b[48;5;39m\x1b[30m",
};
export const PLAIN: Theme = {
  name: "automode",
  accent: "\x1b[38;5;245m",
  select: "\x1b[7m",
};

const THEMES: Record<string, Theme> = { claude: CLAUDE, codex: CODEX };

export function forAgent(agent?: string | null): Theme {
  return THEMES[(agent ?? "").toLowerCase()] ?? PLAIN;
}
