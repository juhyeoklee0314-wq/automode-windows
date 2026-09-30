export const QUIT_CHANNEL = "automode:quit";

export type ExitSource = "gui_button" | "tray" | "system" | "diagnostic";

export interface QuitIpc {
  on(channel: string, listener: (...args: unknown[]) => void): unknown;
}

/** Route renderer shutdown commands to the canonical main-process exit. */
export function registerQuitHandler(
  ipc: QuitIpc,
  cleanExit: (source: ExitSource) => void,
  trace?: (stage: string, source: ExitSource) => void,
): void {
  ipc.on(QUIT_CHANNEL, () => {
    trace?.("EXIT_GUI_04_IPC_MAIN_RECEIVED", "gui_button");
    cleanExit("gui_button");
  });
}
