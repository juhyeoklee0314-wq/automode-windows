import type { AutomodeApi, SavePayload } from "./types.js";

// Sandboxed Electron preloads must be self-contained CommonJS. Keep runtime
// channel constants local so this file never imports another preload module.
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
const QUIT_CHANNEL = "automode:quit";
const DIAGNOSTIC_CHANNEL = "automode:diagnostic";

const api: AutomodeApi = Object.freeze({
  getSnapshot: () => ipcRenderer.invoke("automode:get-snapshot"),
  save: (payload: SavePayload) => ipcRenderer.invoke("automode:save", payload),
  setScheduler: (enabled: boolean) => ipcRenderer.invoke("automode:set-scheduler", enabled),
  setRunAtLogin: (enabled: boolean) => ipcRenderer.invoke("automode:set-login", enabled),
  newAccountProfile: () => ipcRenderer.invoke("automode:new-account-profile"),
  getAccountAuthStatus: (accountId: string) => ipcRenderer.invoke("automode:account-auth-status", accountId),
  connectAccount: (accountId: string) => ipcRenderer.invoke("automode:account-connect", accountId),
  openExternalLogin: (url: string, code: string) => ipcRenderer.invoke("automode:open-external-login", url, code),
  doctor: () => ipcRenderer.invoke("automode:doctor"),
  readLog: () => ipcRenderer.invoke("automode:read-log"),
  openLogFolder: () => ipcRenderer.invoke("automode:open-log-folder"),
  exportDiagnostic: () => ipcRenderer.invoke("automode:export-diagnostic"),
  rendererReady: () => ipcRenderer.send(DIAGNOSTIC_CHANNEL, "START_15_RENDERER_READY"),
  rendererEvent: (stage: "EXIT_GUI_01_RENDERER_CLICK" | "RENDERER_ERROR" | "RENDERER_UNHANDLED_REJECTION") =>
    ipcRenderer.send(DIAGNOSTIC_CHANNEL, stage),
  quit: () => {
    ipcRenderer.send(DIAGNOSTIC_CHANNEL, "EXIT_GUI_02_PRELOAD_API_ENTER");
    ipcRenderer.send(DIAGNOSTIC_CHANNEL, "EXIT_GUI_03_IPC_SENT");
    ipcRenderer.send(QUIT_CHANNEL);
  },
});

contextBridge.exposeInMainWorld("automode", api);
