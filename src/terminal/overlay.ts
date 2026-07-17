/**
 * The hotkey overlay: the menu on top of a running agent.
 *
 * Several hotkeys can be live at once (`ctrl+g, alt+g` by default), because
 * which one reaches us depends on the terminal: macOS Terminal.app sends
 * Option+G as "©" unless you turn on "Use Option as Meta key", so ctrl+g is the
 * one that always arrives.
 *
 * Two problems have to be solved to put a menu over someone else's TUI:
 *
 * 1. Telling alt+g apart from a real Escape. A terminal sends alt+g as ESC then
 *    'g' with no gap, so both bytes land in one read. A human pressing Esc and
 *    then typing g cannot beat that, because the bytes arrive in separate
 *    reads. So the hotkey only counts when it is the whole chunk.
 *
 * 2. Not losing the agent's screen. We switch to the alternate screen buffer,
 *    which the terminal restores on exit, and hold everything the agent prints
 *    meanwhile to replay afterwards. If the agent is itself using the alternate
 *    screen, we never left it, so we track that from its output.
 */

import type { Config } from "../core/config.js";
import { t } from "../core/i18n.js";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CURSOR_HIDE, CURSOR_SHOW, Menu } from "./menu.js";
import { type Theme, forAgent } from "./theme.js";

// The agent switching the alternate screen on/off, seen in its own output.
const ALT_ON = /\x1b\[\?(?:1049|47|1047)h/g;
const ALT_OFF = /\x1b\[\?(?:1049|47|1047)l/g;

/** Anything longer than this is a paste or a mouse report, not a hotkey. */
const MAX_HOTKEY_BYTES = 4;

/** Turn "alt+g" / "ctrl+g" into the bytes the terminal actually sends. */
export function parseHotkey(spec: string): Buffer | null {
  const text = spec.trim().toLowerCase().replace(/\s/g, "");
  if (!text) return null;
  if (!text.includes("+")) return text.length === 1 ? Buffer.from(text) : null;
  const at = text.lastIndexOf("+");
  const modifier = text.slice(0, at);
  const key = text.slice(at + 1);
  if (key.length !== 1 || !/[a-z]/.test(key)) return null;
  if (["alt", "meta", "option", "opt"].includes(modifier)) {
    return Buffer.concat([Buffer.from([0x1b]), Buffer.from(key)]);
  }
  if (["ctrl", "control", "c"].includes(modifier)) {
    return Buffer.from([key.charCodeAt(0) - 96]);
  }
  return null;
}

/** Several accepted spellings, comma separated: "ctrl+g, alt+g". */
export function parseHotkeys(spec: string): Buffer[] {
  const found: Buffer[] = [];
  for (const part of String(spec).split(",")) {
    const parsed = parseHotkey(part);
    if (parsed && !found.some((k) => k.equals(parsed))) found.push(parsed);
  }
  return found;
}

/** The configured hotkeys, spelled for a human: "ctrl+g or alt+g". */
export function describeHotkey(spec: string): string {
  const parts = String(spec).split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  return parts.length ? parts.join(t("hotkey.join")) : "ctrl+g";
}

/** Menu state plus the terminal bookkeeping to float it over the agent. */
export class Overlay {
  open = false;
  menu: Menu | null = null;
  childInAlt = false;
  private held: string[] = [];

  constructor(
    public config: Config,
    public hotkeys: Buffer[],
    public theme: Theme = forAgent(null),
    public size: [number, number] = [24, 80],
  ) {}

  /** Follow whether the agent has the alternate screen up. */
  trackOutput(data: string): void {
    ALT_ON.lastIndex = 0;
    ALT_OFF.lastIndex = 0;
    let lastOn = -1;
    let lastOff = -1;
    for (const m of data.matchAll(ALT_ON)) lastOn = m.index ?? -1;
    for (const m of data.matchAll(ALT_OFF)) lastOff = m.index ?? -1;
    if (lastOn < 0 && lastOff < 0) return;
    this.childInAlt = lastOn > lastOff;
  }

  matchesHotkey(data: Buffer): boolean {
    return (
      !this.open &&
      data.length <= MAX_HOTKEY_BYTES &&
      this.hotkeys.some((key) => key.equals(data))
    );
  }

  /** Stash agent output produced while the menu is up. */
  hold(data: string): void {
    this.held.push(data);
  }

  resize(size: [number, number]): string {
    this.size = size;
    if (!this.menu) return "";
    this.menu.resize(size);
    return this.menu.render();
  }

  enter(size?: [number, number]): string {
    if (size) this.size = size;
    this.open = true;
    this.menu = new Menu(this.config, this.theme, this.size);
    this.held = [];
    const prefix = this.childInAlt ? "" : ALT_SCREEN_ON;
    return prefix + CURSOR_HIDE + this.menu.render();
  }

  /** Feed keys to the menu; returns what to draw. */
  handle(data: Buffer): string {
    if (!this.menu) return "";
    this.menu.handle(data);
    return this.menu.done ? "" : this.menu.render();
  }

  get done(): boolean {
    return this.menu?.done ?? false;
  }

  /** Close the menu and hand the screen back to the agent. */
  leave(): string {
    if (!this.menu) return "";
    Object.assign(this.config, this.menu.config);
    this.open = false;
    this.menu = null;
    // The terminal restores the agent's screen on the way out of the alternate
    // buffer; if the agent lives there too, we never left it.
    const restore = this.childInAlt ? "" : ALT_SCREEN_OFF;
    const replay = this.held.join("");
    this.held = [];
    return restore + CURSOR_SHOW + replay;
  }
}

/** Overlay for this config, or null if no hotkey is usable. */
export function build(
  config: Config,
  agent?: string,
  size: [number, number] = [24, 80],
): Overlay | null {
  const hotkeys = parseHotkeys(String(config.hotkey ?? "ctrl+g"));
  if (!hotkeys.length) return null;
  return new Overlay(config, hotkeys, forAgent(agent), size);
}
