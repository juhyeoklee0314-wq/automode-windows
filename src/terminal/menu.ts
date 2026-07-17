/**
 * The overlay menu: a centered box, drawn by hand with ANSI.
 *
 * The look is deliberately Turbo Vision: a double-ruled box floating in the
 * middle of the screen, an inverted bar for the selected row. It borrows its
 * color from whichever agent it is covering.
 */

import * as configmod from "../core/config.js";
import type { Config } from "../core/config.js";
import { LANGUAGES, setLanguage, t } from "../core/i18n.js";
import { localTzName, parseHhmm } from "../core/timeutil.js";
import { BOLD, DIM, NOBOLD, RESET, type Theme, forAgent } from "./theme.js";

const ESC = "\x1b";
export const ALT_SCREEN_ON = `${ESC}[?1049h`;
export const ALT_SCREEN_OFF = `${ESC}[?1049l`;
export const CURSOR_HIDE = `${ESC}[?25l`;
export const CURSOR_SHOW = `${ESC}[?25h`;
const CLEAR = `${ESC}[H${ESC}[2J`;

const TL = "╔", TR = "╗", BL = "╚", BR = "╝", H = "═", V = "║";
const LT = "╠", RT = "╣";

/** The MOD in autoMODe, kept in one place because the title needs it twice. */
const MOD = "MOD";

const LABEL_WIDTH = 21;
const BOX_WIDTH = 62;
const MIN_WIDTH = 34;
const MIN_HEIGHT = 8;

type Kind = "header" | "bool" | "text" | "int" | "times" | "choice";

export interface Row {
  kind: Kind;
  label: string;
  path?: string[];
  options?: string[];
  step?: number;
  lo?: number;
  hi?: number;
  suffix?: string;
  hint?: string;
  placeholder?: string;
}

export const selectable = (row: Row): boolean => row.kind !== "header";

/** The menu, in the current language. Rebuild it when the language changes. */
export function buildRows(): Row[] {
  return [
    { kind: "header", label: t("section.continue") },
    { kind: "bool", label: t("row.auto_continue"), path: ["auto_continue"], hint: t("hint.auto_continue") },
    { kind: "text", label: t("row.continue_message"), path: ["continue_message"], hint: t("hint.continue_message") },
    { kind: "int", label: t("row.grace_seconds"), path: ["grace_seconds"], step: 15, lo: 0, hi: 3600, suffix: "s", hint: t("hint.grace_seconds") },
    { kind: "int", label: t("row.idle_guard_seconds"), path: ["idle_guard_seconds"], step: 1, lo: 0, hi: 120, suffix: "s", hint: t("hint.idle_guard_seconds") },
    { kind: "bool", label: t("row.answer_limit_prompt"), path: ["answer_limit_prompt"], hint: t("hint.answer_limit_prompt") },
    { kind: "header", label: t("section.ping") },
    { kind: "bool", label: t("row.ping_enabled"), path: ["ping", "enabled"], hint: t("hint.ping_enabled") },
    { kind: "text", label: t("row.ping_message"), path: ["ping", "message"] },
    { kind: "times", label: t("row.ping_times"), path: ["ping", "times"], hint: t("hint.ping_times") },
    { kind: "choice", label: t("row.ping_agent"), path: ["ping", "agent"], options: ["claude", "codex"], hint: t("hint.ping_agent") },
    { kind: "int", label: t("row.catchup_minutes"), path: ["ping", "catchup_minutes"], step: 5, lo: 0, hi: 240, suffix: "min", hint: t("hint.catchup_minutes") },
    { kind: "int", label: t("row.ping_idle_seconds"), path: ["ping", "idle_seconds"], step: 5, lo: 0, hi: 300, suffix: "s", hint: t("hint.ping_idle_seconds") },
    { kind: "header", label: t("section.general") },
    { kind: "choice", label: t("row.language"), path: ["language"], options: Object.keys(LANGUAGES), hint: t("hint.language") },
    { kind: "bool", label: t("row.notify"), path: ["notify"] },
    { kind: "text", label: t("row.hotkey"), path: ["hotkey"], hint: t("hint.hotkey") },
    { kind: "text", label: t("row.timezone"), path: ["timezone"], placeholder: t("value.system_tz", { zone: localTzName() }), hint: t("hint.timezone") },
  ];
}

function get(config: any, path: string[]): any {
  return path.reduce((node, key) => node?.[key], config);
}

function set(config: any, path: string[], value: unknown): void {
  const parent = path.slice(0, -1).reduce((node, key) => node[key], config);
  parent[path[path.length - 1]!] = value;
}

function defaultFor(path: string[]): any {
  return structuredClone(get(configmod.DEFAULTS, path));
}

export function terminalSize(): [number, number] {
  return [process.stdout.rows || 24, process.stdout.columns || 80];
}

/** Menu state machine. Feed it keys, ask it to render. */
export class Menu {
  config: Config;
  private original: Config;
  rows: Row[];
  cursor: number;
  editing = false;
  editBuffer = "";
  status = "";
  done = false;
  private top = 0;

  constructor(
    config: Config,
    public theme: Theme = forAgent(null),
    public size: [number, number] = [24, 80],
  ) {
    this.config = structuredClone(config);
    setLanguage(String(this.config.language ?? ""));
    this.rows = buildRows();
    this.coerce();
    this.original = structuredClone(this.config);
    this.cursor = this.rows.findIndex(selectable);
  }

  get dirty(): boolean {
    return JSON.stringify(this.config) !== JSON.stringify(this.original);
  }

  resize(size: [number, number]): void {
    this.size = size;
  }

  /** Repair values a hand-edited config file may have gotten wrong. */
  private coerce(): void {
    for (const row of this.rows) {
      if (!row.path) continue;
      const value = get(this.config, row.path);
      if (row.kind === "int" && typeof value !== "number") {
        const parsed = Number.parseInt(String(value).trim(), 10);
        set(this.config, row.path, Number.isNaN(parsed) ? defaultFor(row.path) : parsed);
      } else if (row.kind === "times" && !Array.isArray(value)) {
        set(this.config, row.path, defaultFor(row.path));
      }
    }
  }

  private move(delta: number): void {
    let index = this.cursor;
    for (let step = 0; step < this.rows.length; step += 1) {
      index = (index + delta + this.rows.length) % this.rows.length;
      if (selectable(this.rows[index]!)) {
        this.cursor = index;
        return;
      }
    }
  }

  /** The value as plain text. Width math needs it free of escapes. */
  private value(row: Row): string {
    const value = get(this.config, row.path!);
    if (row.kind === "bool") return value ? "[X]" : "[ ]";
    if (row.kind === "int") return `${value}${row.suffix ?? ""}`;
    if (row.kind === "times") {
      return (value as string[]).length ? (value as string[]).join(", ") : t("value.none");
    }
    if (row.kind === "choice") {
      return row.options!
        .map((opt) => `(${opt === value ? "o" : " "}) ${this.optionLabel(row, opt)}`)
        .join("  ");
    }
    return String(value) || row.placeholder || "";
  }

  private optionLabel(row: Row, option: string): string {
    return row.path?.[0] === "language" ? (LANGUAGES[option] ?? option) : option;
  }

  private commitEdit(): void {
    const row = this.rows[this.cursor]!;
    const text = this.editBuffer.trim();
    if (row.kind === "int") {
      // Never let a typo become a string in a numeric field: the session would
      // crash later, at the exact moment it had to type `continue`.
      const digits =
        row.suffix && text.endsWith(row.suffix) ? text.slice(0, -row.suffix.length) : text;
      const parsed = Number(digits);
      if (digits.trim() === "" || !Number.isFinite(parsed)) {
        this.status = t("menu.not_a_number", { value: text });
        this.editing = false;
        return;
      }
      set(this.config, row.path!, Math.max(row.lo ?? 0, Math.min(row.hi ?? 0, Math.trunc(parsed))));
    } else if (row.kind === "times") {
      const entries = text.split(",").map((p) => p.trim()).filter(Boolean);
      const bad = entries.filter((e) => parseHhmm(e) === null);
      if (bad.length) {
        this.status = t("menu.bad_time", { value: bad.join(", ") });
        this.editing = false;
        return;
      }
      const normalized = entries.map((entry) => {
        const [h, m] = parseHhmm(entry)!;
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      });
      set(this.config, row.path!, [...new Set(normalized)].sort());
    } else {
      set(this.config, row.path!, text);
    }
    this.editing = false;
    this.status = "";
  }

  private activate(row: Row): void {
    if (row.kind === "bool") {
      set(this.config, row.path!, !get(this.config, row.path!));
    } else if (row.kind === "choice") {
      const options = row.options!;
      const index = options.indexOf(get(this.config, row.path!));
      set(this.config, row.path!, options[(index + 1) % options.length]);
      this.relabel(row);
    } else {
      this.editing = true;
      this.editBuffer = this.editText(row);
    }
  }

  private editText(row: Row): string {
    const value = get(this.config, row.path!);
    return row.kind === "times" ? (value as string[]).join(", ") : String(value);
  }

  /** Redraw the menu in the new language, keeping the cursor put. */
  private relabel(row: Row): void {
    if (row.path?.[0] !== "language") return;
    setLanguage(String(get(this.config, ["language"])));
    const at = this.cursor;
    this.rows = buildRows();
    this.cursor = Math.min(at, this.rows.length - 1);
  }

  private adjust(row: Row, delta: number): void {
    if (row.kind === "int") {
      const value = Number(get(this.config, row.path!)) + delta * (row.step ?? 1);
      set(this.config, row.path!, Math.max(row.lo ?? 0, Math.min(row.hi ?? 0, value)));
    } else if (row.kind === "bool") {
      set(this.config, row.path!, delta > 0);
    } else if (row.kind === "choice") {
      const options = row.options!;
      const index = options.indexOf(get(this.config, row.path!));
      const next = (index + delta + options.length) % options.length;
      set(this.config, row.path!, options[next]);
      this.relabel(row);
    }
  }

  save(): void {
    try {
      configmod.save(this.config);
      this.original = structuredClone(this.config);
      this.status = t("menu.saved");
    } catch (error) {
      this.status = t("menu.save_failed", { error: String(error) });
    }
  }

  /** Feed raw keyboard bytes. */
  handle(data: Buffer | string): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    let index = 0;
    while (index < text.length) {
      if (text.startsWith(`${ESC}[`, index) && index + 2 < text.length) {
        this.handleArrow(text[index + 2]!);
        index += 3;
        continue;
      }
      this.handleChar(text[index]!);
      index += 1;
    }
  }

  private handleArrow(code: string): void {
    if (this.editing) return;
    const row = this.rows[this.cursor]!;
    if (code === "A") this.move(-1);
    else if (code === "B") this.move(1);
    else if (code === "C") this.adjust(row, 1);
    else if (code === "D") this.adjust(row, -1);
  }

  private handleChar(char: string): void {
    if (this.editing) {
      this.handleEditChar(char);
      return;
    }
    if (char === "q" || char === "\x03" || char === "\x07" || char === ESC) this.done = true;
    else if (char === "s") this.save();
    else if (char === "\r" || char === "\n" || char === " ") this.activate(this.rows[this.cursor]!);
    else if (char === "k") this.move(-1);
    else if (char === "j") this.move(1);
  }

  private handleEditChar(char: string): void {
    if (char === "\r" || char === "\n") this.commitEdit();
    else if (char === ESC) {
      this.editing = false;
      this.status = "";
    } else if (char === "\x7f" || char === "\x08") {
      this.editBuffer = this.editBuffer.slice(0, -1);
    } else if (char >= " ") this.editBuffer += char;
  }

  /** Body lines as [plain text, selected]. */
  private content(): Array<[string, boolean]> {
    const lines: Array<[string, boolean]> = [];
    this.rows.forEach((row, index) => {
      if (row.kind === "header") {
        if (lines.length) lines.push(["", false]);
        lines.push([` ${row.label}`, false]);
        return;
      }
      const isSelected = index === this.cursor;
      const pointer = isSelected ? "▸" : " ";
      lines.push([` ${pointer} ${row.label.padEnd(LABEL_WIDTH)} ${this.value(row)}`, isSelected]);
    });
    return lines;
  }

  private footer(): string {
    const row = this.rows[this.cursor]!;
    if (this.editing) return ` ${row.label}: ${this.editBuffer}_`;
    if (this.status) return ` ${this.status}`;
    return row.hint ? ` ${row.hint}` : "";
  }

  render(): string {
    const [rows, cols] = this.size;
    const width = Math.max(Math.min(BOX_WIDTH, cols - 2), MIN_WIDTH);
    const inner = width - 2;

    let body = this.content();
    // The box costs 5 lines of chrome; leave one more so it never hugs the edge.
    const available = Math.max(rows - 6, MIN_HEIGHT);
    if (body.length > available) {
      const selectedAt = body.findIndex(([, sel]) => sel);
      if (selectedAt >= 0 && selectedAt < this.top) this.top = selectedAt;
      else if (selectedAt >= this.top + available) this.top = selectedAt - available + 1;
      this.top = Math.max(0, Math.min(this.top, body.length - available));
      body = body.slice(this.top, this.top + available);
    } else {
      this.top = 0;
    }

    const height = body.length + 5;
    const top = Math.max(Math.floor((rows - height) / 2), 0);
    const left = Math.max(Math.floor((cols - width) / 2), 0);
    const accent = this.theme.accent;

    // Two strings for one title: the escape codes that make MOD stand out
    // would otherwise be counted as width, and the rule would come up short.
    const mark = this.dirty ? "* " : "";
    const titlePlain = ` auto${MOD}e ${mark}`;
    const titleDrawn = ` auto${BOLD}${MOD}${NOBOLD}e ${mark}`;
    const rule = H.repeat(Math.max(inner - titlePlain.length - 2, 0));

    const out: string[] = [CLEAR, CURSOR_HIDE];
    let line = top + 1;
    const place = (text: string) => {
      out.push(`${ESC}[${line};${left + 1}H${text}`);
      line += 1;
    };

    place(`${accent}${TL}${H}${H}${titleDrawn}${accent}${rule}${TR}${RESET}`);
    for (const [text, isSelected] of body) {
      let cell = text.slice(0, inner).padEnd(inner);
      if (isSelected) cell = `${this.theme.select}${cell}${RESET}`;
      else if (text.trim() && !text.startsWith("  ")) cell = `${accent}${BOLD}${cell}${RESET}`;
      place(`${accent}${V}${RESET}${cell}${accent}${V}${RESET}`);
    }
    place(`${accent}${LT}${H.repeat(inner)}${RT}${RESET}`);
    place(`${accent}${V}${RESET}${DIM}${this.footer().slice(0, inner).padEnd(inner)}${RESET}${accent}${V}${RESET}`);
    place(`${accent}${V}${RESET}${t("menu.keys").slice(0, inner).padEnd(inner)}${accent}${V}${RESET}`);
    place(`${accent}${BL}${H.repeat(inner)}${BR}${RESET}`);
    return out.join("");
  }
}
