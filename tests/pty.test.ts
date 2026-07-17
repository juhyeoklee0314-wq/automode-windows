/**
 * Drive the whole wrapper through a real PTY.
 *
 * Everything else mocks the terminal. This spawns automode for real, presses
 * keys at it, and reads what a terminal would have received. It is the only
 * way to know the open/close flow actually works.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";
import { fileURLToPath } from "node:url";

import * as pty from "node-pty";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(ROOT, "dist", "src", "cli.js");

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";

/** Raw mode, like every real agent TUI: reads land byte by byte, no echo. */
const FAKE_AGENT = `
process.stdin.setRawMode(true);
process.stdout.write("AGENT-READY\\r\\n");
process.stdin.on("data", (d) => {
  process.stdout.write("AGENT-GOT:" + JSON.stringify(d.toString()) + "\\r\\n");
});
`;

const CONFIG = `
auto_continue = true
notify = false
hotkey = "ctrl+g, alt+g"
`;

class Harness {
  private child: pty.IPty;
  private buffer = "";

  constructor() {
    const dir = mkdtempSync(join(tmpdir(), "automode-"));
    const configDir = join(dir, "automode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.toml"), CONFIG);
    const agent = join(dir, "agent.mjs");
    writeFileSync(agent, FAKE_AGENT);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
      XDG_CONFIG_HOME: dir,
      XDG_STATE_HOME: join(dir, "state"),
    };
    // The suite may itself be running inside a wrapped session. The depth
    // counter is inherited, and a deep enough one turns the wrapper off.
    delete env.AUTOMODE_DEPTH;
    delete env.AUTOMODE_SESSION;

    this.child = pty.spawn(process.execPath, [CLI, "--", process.execPath, agent], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: dir,
      env,
    });
    this.child.onData((data) => {
      this.buffer += data;
    });
  }

  press(data: string): void {
    this.child.write(data);
  }

  async read(ms = 900): Promise<string> {
    this.buffer = "";
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.buffer;
  }

  async settle(ms = 1500): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    const seen = this.buffer;
    this.buffer = "";
    return seen;
  }

  kill(): void {
    try {
      this.child.kill();
    } catch {
      // Already gone.
    }
  }
}

describe("the overlay, through a real terminal", () => {
  const started: Harness[] = [];
  const boot = async () => {
    const h = new Harness();
    started.push(h);
    const first = await h.settle(1800);
    assert.ok(first.includes("AGENT-READY"), "the fake agent never started");
    return h;
  };
  after(() => started.forEach((h) => h.kill()));

  test("ctrl+g opens the menu and q closes it", async () => {
    const h = await boot();
    h.press("\x07");
    const opened = await h.read(1200);
    assert.ok(opened.includes(ALT_ON), "did not enter the alternate screen");
    assert.ok(opened.includes("MOD"), "the autoMODe title never appeared");
    assert.ok(opened.includes("╔"), "the box was not drawn");

    h.press("q");
    const closed = await h.read(1200);
    assert.ok(closed.includes(ALT_OFF), "did not leave the alternate screen");
    assert.ok(closed.includes("\x1b[?25h"), "did not give the cursor back");
  });

  test("the hotkey never reaches the agent", async () => {
    const h = await boot();
    h.press("\x07");
    await h.read(800);
    h.press("q");
    const out = await h.read(800);
    assert.ok(!out.includes("AGENT-GOT"), "the agent got the menu key");
  });

  test("keys reach the agent again after closing", async () => {
    const h = await boot();
    h.press("\x07");
    await h.read(800);
    h.press("q");
    await h.read(800);
    h.press("hi\r");
    const after = await h.read(1200);
    assert.ok(after.includes("AGENT-GOT"), "the keyboard never went back to the agent");
  });

  test("a lone escape goes to the agent, not the menu", async () => {
    // Esc is how you interrupt claude; it must never be eaten by automode.
    const h = await boot();
    h.press("\x1b");
    const out = await h.read(900);
    assert.ok(!out.includes(ALT_ON), "the menu opened on a bare Esc");
    assert.ok(out.includes("AGENT-GOT"), "the Esc never reached the agent");
  });

  test("alt+g also opens, for terminals that send Meta", async () => {
    const h = await boot();
    h.press("\x1bg");
    assert.ok((await h.read(1200)).includes(ALT_ON));
  });

  test("arrows navigate without closing", async () => {
    const h = await boot();
    h.press("\x07");
    await h.read(800);
    h.press("\x1b[B");
    h.press("\x1b[B");
    assert.ok(!(await h.read(800)).includes(ALT_OFF), "the arrows closed the menu");
    h.press("q");
    assert.ok((await h.read(1000)).includes(ALT_OFF));
  });

  test("space toggles a checkbox", async () => {
    const h = await boot();
    h.press("\x07");
    await h.read(800);
    h.press(" ");
    assert.ok((await h.read(800)).includes("[ ]"), "the checkbox did not clear");
  });

  test("q typed into a number neither closes nor corrupts it", async () => {
    // Space on a number opens an editor, so `q` is text, not a command.
    const h = await boot();
    h.press("\x07");
    await h.read(800);
    h.press("\x1b[B\x1b[B"); // down to "wait after reset"
    h.press(" ");
    h.press("q\r");
    const drawn = await h.read(900);
    assert.ok(!drawn.includes(ALT_OFF), "the q closed the menu from inside the editor");
    assert.ok(drawn.includes("must be a number"));
  });
});
