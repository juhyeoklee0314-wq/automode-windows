/** `automode menu` outside a session. */

import * as configmod from "../core/config.js";
import { t } from "../core/i18n.js";
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  CURSOR_SHOW,
  Menu,
  terminalSize,
} from "./menu.js";

export function runStandalone(): Promise<number> {
  if (!process.stdin.isTTY) {
    process.stderr.write(`automode: ${t("menu.needs_terminal")}\n`);
    return Promise.resolve(1);
  }

  const menu = new Menu(configmod.load(), undefined, terminalSize());
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(ALT_SCREEN_ON);
  process.stdout.write(menu.render());

  return new Promise<number>((resolve) => {
    const finish = () => {
      process.stdout.write(ALT_SCREEN_OFF + CURSOR_SHOW);
      process.stdin.off("data", onData);
      process.stdout.off("resize", onResize);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      if (menu.dirty) console.log(`automode: ${t("menu.unsaved")}`);
      resolve(0);
    };
    const onData = (data: Buffer) => {
      menu.handle(data);
      if (menu.done) finish();
      else process.stdout.write(menu.render());
    };
    const onResize = () => {
      menu.resize(terminalSize());
      process.stdout.write(menu.render());
    };
    process.stdin.on("data", onData);
    process.stdout.on("resize", onResize);
  });
}
