import { join } from "node:path";

export const TRAY_ICON_RELATIVE_PATH = join("src", "gui", "assets", "tray-icon.png");
export const APP_ICON_RELATIVE_PATH = join("src", "gui", "assets", "pinggpt-icon.png");

export function trayIconPath(appRoot: string): string {
  return join(appRoot, TRAY_ICON_RELATIVE_PATH);
}

export function appIconPath(appRoot: string): string {
  return join(appRoot, APP_ICON_RELATIVE_PATH);
}
