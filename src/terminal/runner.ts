/**
 * Run a child process under a PTY, passing the terminal through untouched.
 *
 * automode sits between your keyboard and the agent. Bytes are forwarded in
 * both directions verbatim, so the agent's TUI looks and behaves exactly as it
 * does unwrapped, while a copy of the output goes to the controller, which may
 * type into the PTY on your behalf.
 *
 * The Python original drives a select loop. Node has no select, so the same
 * shape comes out of events plus a timer the controller re-arms.
 */

import * as pty from "node-pty";

import type { Overlay } from "./overlay.js";

/**
 * Cap the timer so the schedule is re-checked promptly after the machine wakes
 * from sleep, where the wall clock jumps but no event fires.
 */
const MAX_TIMEOUT_MS = 5000;

/**
 * Long enough for the agent to notice the fake resize and repaint. Only ever
 * paid once, when the menu closes.
 */
const REDRAW_SETTLE_MS = 200;

/**
 * How many nested wrappers before we assume something is looping. A shell
 * function or a script named `claude` that calls automode back would recurse
 * forever; genuine nesting never goes this deep.
 */
export const MAX_DEPTH = 3;

export interface Controller {
  onOutput(data: string): void;
  onUserInput(data: Buffer): void;
  nextTimeout(): number;
  tick(inject: (payload: string) => void): void;
}

/** How many automode wrappers we are already inside. */
export function sessionDepth(): number {
  const raw = Number.parseInt(process.env.AUTOMODE_DEPTH ?? "0", 10);
  return Number.isFinite(raw) ? raw : 0;
}

/** Run argv under a PTY. Resolves with the child's exit code. */
export function run(
  argv: string[],
  controller: Controller,
  overlay: Overlay | null = null,
): Promise<number> {
  const [command, ...args] = argv;
  const interactive = process.stdin.isTTY === true;
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const depth = sessionDepth();

  const child = pty.spawn(command!, args, {
    name: process.env.TERM || "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTOMODE_SESSION: "1",
      AUTOMODE_DEPTH: String(depth + 1),
    } as Record<string, string>,
  });

  if (interactive) process.stdin.setRawMode(true);
  process.stdin.resume();

  const inject = (payload: string) => {
    try {
      child.write(payload);
    } catch {
      // The child is gone; nothing to type at.
    }
  };

  let timer: NodeJS.Timeout | null = null;
  const scheduleTick = () => {
    if (timer) clearTimeout(timer);
    const ms = Math.min(Math.max(controller.nextTimeout() * 1000, 50), MAX_TIMEOUT_MS);
    timer = setTimeout(() => {
      controller.tick(inject);
      scheduleTick();
    }, ms);
  };

  child.onData((data: string) => {
    if (overlay) {
      overlay.trackOutput(data);
      if (overlay.open) overlay.hold(data);
      else process.stdout.write(data);
    } else {
      process.stdout.write(data);
    }
    controller.onOutput(data);
  });

  const onStdin = (data: Buffer) => {
    controller.onUserInput(data);
    if (overlay?.open) {
      process.stdout.write(overlay.handle(data));
      if (overlay.done) {
        process.stdout.write(overlay.leave());
        forceRedraw(child, rows, cols);
      }
      return;
    }
    if (overlay?.matchesHotkey(data)) {
      process.stdout.write(overlay.enter([process.stdout.rows || 24, process.stdout.columns || 80]));
      return;
    }
    child.write(data.toString("binary"));
  };
  process.stdin.on("data", onStdin);

  // Our stdin ended, which only happens when it is a pipe. A PTY has no EOF of
  // its own, so pass along the character that means one. A TTY never ends, so
  // this cannot fire on a real session and cannot be mistaken for a keypress.
  process.stdin.on("end", () => {
    if (!interactive) child.write("\x04");
  });

  const onResize = () => {
    const size: [number, number] = [process.stdout.rows || 24, process.stdout.columns || 80];
    try {
      child.resize(size[1], size[0]);
    } catch {
      // Racing the child's exit.
    }
    if (overlay?.open) process.stdout.write(overlay.resize(size));
  };
  process.stdout.on("resize", onResize);

  scheduleTick();

  return new Promise<number>((resolve) => {
    child.onExit(({ exitCode, signal }) => {
      if (timer) clearTimeout(timer);
      process.stdin.off("data", onStdin);
      process.stdout.off("resize", onResize);
      if (interactive && process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(signal ? 128 + signal : exitCode);
    });
  });
}

/**
 * Make the agent repaint everything after the menu covered it.
 *
 * Leaving the alternate screen is supposed to restore the agent's screen, and
 * usually does. But the agents draw their header exactly once and never again,
 * so if the restore comes up short there is nothing to bring it back.
 *
 * Measured against Claude Code: a same-size resize is ignored, but a real size
 * change makes it re-emit its entire UI, header included. So we lie about the
 * size for a moment and put it back.
 */
function forceRedraw(child: pty.IPty, rows: number, cols: number): void {
  if (rows < 2) return;
  try {
    child.resize(cols, rows - 1);
    setTimeout(() => {
      try {
        child.resize(cols, rows);
      } catch {
        // The child exited while we were lying to it.
      }
    }, REDRAW_SETTLE_MS);
  } catch {
    // Same.
  }
}
