import { app, BrowserWindow, ipcMain, Menu, nativeImage, powerMonitor, shell, Tray } from "electron";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { clearLease, writeLease } from "./lease.js";
import { exportDiagnosticSnapshot } from "./diagnostic-export.js";
import { DIAGNOSTIC_CHANNEL } from "./channels.js";
import { BUILD_IDENTITY, DIAGNOSTIC_LOG_PATH, DIAGNOSTIC_RECEIPT_PATH, DiagnosticTrace } from "./diagnostics.js";
import { loadDiagnosticPreferences, loadPreferences, savePreferences } from "./preferences.js";
import { requestWindowsSleep } from "./power-control.js";
import { recordResume, recordSuspend } from "./power-state.js";
import { resolveProcessMode } from "./routing.js";
import { runScheduled, runScheduledDryRun } from "./scheduled-runner.js";
import { schedulerExecutable, WindowsScheduler } from "./scheduler.js";
import { GuiService } from "./service.js";
import { registerQuitHandler } from "./shutdown.js";
import type { ExitSource } from "./shutdown.js";
import { appIconPath, trayIconPath } from "./tray-icon.js";
import type { SavePayload, SchedulerTaskStatus } from "./types.js";
import * as configmod from "../core/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const trace = new DiagnosticTrace();
const mode = resolveProcessMode(process.argv);
trace.emit("START_01_MAIN_ENTRY", "main", { execPath: process.execPath, mode: mode.kind, buildIdentity: BUILD_IDENTITY });

if (mode.kind === "scheduled") {
  trace.emit("START_02_MODE_ROUTED", "scheduled");
  app.whenReady()
    .then(() => runScheduled(mode.accountId, mode.scheduleId, new Date(), trace, {
      isOnBatteryPower: () => powerMonitor.isOnBatteryPower(),
      getSystemIdleTime: () => powerMonitor.getSystemIdleTime(),
      requestSleep: () => requestWindowsSleep(),
    }))
    .then((code) => app.exit(code))
    .catch(() => app.exit(1));
} else if (mode.kind === "scheduled-dry-run") {
  trace.emit("START_02_MODE_ROUTED", "dry_run");
  runScheduledDryRun(mode.accountId, mode.scheduleId, new Date(), trace).then((code) => app.exit(code));
} else {
  trace.emit("START_02_MODE_ROUTED", "gui");
  startGui();
}

function startGui(): void {
  const diagnosticStartup = process.argv.includes("--diagnostic-startup");
  const diagnosticAutoExit = process.argv.includes("--diagnostic-auto-exit");
  if (diagnosticStartup) {
    app.setPath("userData", join(tmpdir(), "automode-phase6-diagnostic", trace.runId));
  } else {
    // productName is now PingGPT, but existing installations must continue to
    // use the established Electron profile rather than silently creating a new one.
    app.setPath("userData", join(app.getPath("appData"), "Automode"));
  }
  const gotLock = app.requestSingleInstanceLock();
  trace.emit("START_03_SINGLE_INSTANCE_DECISION", "main", { gotLock });
  if (!gotLock) {
    app.quit();
    return;
  }

  let window: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let quitting = false;
  let heartbeat: NodeJS.Timeout | null = null;
  if (!app.isPackaged || diagnosticStartup) process.env.AUTOMODE_SCHEDULER_DRY_RUN = "1";
  const schedulerTarget = schedulerExecutable(process.execPath);
  const scheduler = new WindowsScheduler(
    schedulerTarget,
    undefined,
    diagnosticStartup ? DIAGNOSTIC_RECEIPT_PATH() : undefined,
  );
  const service = new GuiService(scheduler, app.getVersion(), trace);
  trace.emit("BUILD_IDENTITY", "main", {
    appVersion: app.getVersion(), packaged: app.isPackaged, diagnosticStartup,
    schedulerTarget, portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
  });

  const showWindow = () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  const disableAndDisarm = (source: ExitSource) => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    trace.emit(source === "tray" ? "EXIT_TRAY_06_SCHEDULER_DISABLE_BEGIN" : "EXIT_GUI_06_SCHEDULER_DISABLE_BEGIN", source);
    if (!diagnosticStartup) {
      try { scheduler.setEnabled(false); } catch { /* fail closed via lease */ }
    }
    trace.emit(source === "tray" ? "EXIT_TRAY_07_SCHEDULER_DISABLE_END" : "EXIT_GUI_07_SCHEDULER_DISABLE_END", source);
    trace.emit(source === "tray" ? "EXIT_TRAY_08_LEASE_DISARM_BEGIN" : "EXIT_GUI_08_LEASE_DISARM_BEGIN", source);
    if (!diagnosticStartup) clearLease();
    trace.emit(source === "tray" ? "EXIT_TRAY_09_LEASE_DISARM_END" : "EXIT_GUI_09_LEASE_DISARM_END", source);
  };

  let activeExitSource: ExitSource = "system";
  const cleanExit = (source: ExitSource) => {
    if (quitting) return;
    quitting = true;
    activeExitSource = source;
    trace.emit(source === "tray" ? "EXIT_TRAY_05_CLEAN_EXIT_ENTER" : "EXIT_GUI_05_CLEAN_EXIT_ENTER", source);
    disableAndDisarm(source);
    tray?.destroy();
    window?.destroy();
    trace.emit(source === "tray" ? "EXIT_TRAY_10_APP_QUIT_CALLED" : "EXIT_GUI_10_APP_QUIT_CALLED", source);
    app.quit();
  };

  const setRunAtLogin = (enabled: boolean) => {
    if (!app.isPackaged) throw new Error("Run at login is available in the packaged Windows app.");
    const args = ["--background"];
    app.setLoginItemSettings({ openAtLogin: enabled, path: schedulerExecutable(process.execPath), args });
    const config = configmod.load();
    const preferences = loadPreferences(config);
    preferences.runAtLogin = enabled;
    savePreferences(preferences);
    return service.snapshot();
  };

  app.on("second-instance", () => {
    trace.emit("START_SECOND_INSTANCE_FOCUSED", "main");
    showWindow();
  });
  app.on("before-quit", () => {
    trace.emit(activeExitSource === "tray" ? "EXIT_TRAY_11_BEFORE_QUIT" : "EXIT_GUI_11_BEFORE_QUIT", activeExitSource);
    if (!quitting) disableAndDisarm("system");
  });
  app.on("will-quit", () => {
    trace.emit(activeExitSource === "tray" ? "EXIT_TRAY_12_WILL_QUIT" : "EXIT_GUI_12_WILL_QUIT", activeExitSource);
  });
  app.on("window-all-closed", () => {});

  app.whenReady().then(() => {
    trace.emit("START_04_APP_READY", "main");

    powerMonitor.on("suspend", () => {
      if (diagnosticStartup) return;
      recordSuspend();
      trace.emit("POWER_SUSPEND_RECORDED", "main");
    });
    powerMonitor.on("resume", () => {
      if (diagnosticStartup) return;
      recordResume();
      const resumePreferences = loadPreferences(configmod.load());
      if (resumePreferences.schedulerEnabled) writeLease(true);
      trace.emit("POWER_RESUME_RECORDED", "main", { schedulerEnabled: resumePreferences.schedulerEnabled });
    });
    trace.emit("START_11_WINDOW_CREATE_BEGIN", "main");
    window = new BrowserWindow({
      width: 1160,
      height: 820,
      minWidth: 900,
      minHeight: 640,
      show: false,
      backgroundColor: "#0c1017",
      title: "PingGPT",
      icon: appIconPath(app.getAppPath()),
      webPreferences: {
        preload: join(here, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    trace.emit("START_12_WINDOW_CREATE_END", "main");
    window.removeMenu();
    const rendererRoot = join(app.getAppPath(), "src", "gui", "renderer");
    const rendererEntry = join(rendererRoot, "index.html");
    const rendererUrl = pathToFileURL(rendererEntry).href;
    try {
      const rendererHash = createHash("sha256").update(readFileSync(join(rendererRoot, "app.js"))).digest("hex");
      trace.emit("RENDERER_ASSET_IDENTITY", "main", { rendererHash });
    } catch {
      trace.emit("RENDERER_ASSET_IDENTITY_FAILED", "main");
    }
    window.webContents.once("did-finish-load", () => trace.emit("START_13_RENDERER_DID_FINISH_LOAD", "main"));
    window.once("ready-to-show", () => {
      if (!process.argv.includes("--background")) {
        showWindow();
        trace.emit("START_14_WINDOW_SHOW", "main");
      }
    });
    window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        window?.hide();
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== rendererUrl) event.preventDefault();
    });

    const iconPath = trayIconPath(app.getAppPath());
    const trayImage = nativeImage.createFromPath(iconPath);
    if (trayImage.isEmpty()) throw new Error(`PingGPT tray icon could not be loaded: ${iconPath}`);
    tray = new Tray(trayImage.resize({ width: 16, height: 16, quality: "best" }));
    tray.setToolTip("PingGPT");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open PingGPT", click: showWindow },
      { type: "separator" },
      { label: "Exit", click: () => {
        trace.emit("EXIT_TRAY_01_MENU_CLICK", "tray");
        cleanExit("tray");
      } },
    ]));
    tray.on("double-click", showWindow);

    trace.emit("START_SCHEDULER_BOOTSTRAP_BEGIN", "main");
    const preferences = loadPreferences(configmod.load());
    if (app.isPackaged && !diagnosticStartup && preferences.runAtLogin) {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: schedulerExecutable(process.execPath),
        args: ["--background"],
      });
    }
    if (preferences.schedulerEnabled) {
      try {
        scheduler.install(preferences.accounts);
        if (!diagnosticStartup) writeLease(true);
      } catch {
        if (!diagnosticStartup) clearLease();
      }
    } else if (!diagnosticStartup) {
      clearLease();
    }
    trace.emit("START_SCHEDULER_BOOTSTRAP_END", "main", { enabled: preferences.schedulerEnabled });
    if (!diagnosticStartup) {
      heartbeat = setInterval(() => {
        if (loadPreferences(configmod.load()).schedulerEnabled) writeLease(true);
      }, 10_000);
    }

    ipcMain.handle("automode:get-snapshot", () => service.snapshot());
    ipcMain.handle("automode:save", (_event, payload: SavePayload) => service.save(payload));
    ipcMain.handle("automode:set-scheduler", (_event, enabled: boolean) => service.setScheduler(Boolean(enabled)));
    ipcMain.handle("automode:set-login", (_event, enabled: boolean) => setRunAtLogin(Boolean(enabled)));
    ipcMain.handle("automode:new-account-profile", () => service.newAccountProfile());
    ipcMain.handle("automode:account-auth-status", (_event, accountId: unknown) =>
      service.getAccountAuthStatus(String(accountId ?? "")));
    ipcMain.handle("automode:account-connect", (_event, accountId: unknown) =>
      service.connectAccount(String(accountId ?? "")));
    ipcMain.handle("automode:doctor", () => service.doctor());
    ipcMain.handle("automode:read-log", () => service.readLog());
    ipcMain.handle("automode:open-log-folder", async () => {
      const error = await shell.openPath(dirname(configmod.logPath()));
      return !error;
    });
    ipcMain.handle("automode:export-diagnostic", async () => {
      let accounts = [] as ReturnType<typeof loadPreferences>["accounts"];
      let accountPreferencesError: string | undefined;
      try {
        accounts = loadDiagnosticPreferences(configmod.load()).accounts;
      } catch (error) {
        accountPreferencesError = String((error as { message?: unknown })?.message ?? error);
      }
      let schedulerTasks: SchedulerTaskStatus[] = [];
      let schedulerStatusError: string | undefined;
      try { schedulerTasks = scheduler.diagnosticReceiptTasks(); }
      catch (error) { schedulerStatusError = String((error as { message?: unknown })?.message ?? error); }
      return exportDiagnosticSnapshot({
        desktopPath: app.getPath("desktop"),
        appVersion: app.getVersion(),
        buildIdentity: BUILD_IDENTITY,
        diagnosticBuildIdentity: BUILD_IDENTITY,
        packaged: app.isPackaged,
        runId: trace.runId,
        primaryInstance: gotLock,
        schedulerTarget,
        accounts,
        accountPreferencesError,
        schedulerTasks,
        schedulerStatusError,
        diagnosticLogPath: DIAGNOSTIC_LOG_PATH(),
      });
    });
    const allowedRendererStages = new Set([
      "START_15_RENDERER_READY",
      "EXIT_GUI_01_RENDERER_CLICK",
      "EXIT_GUI_02_PRELOAD_API_ENTER",
      "EXIT_GUI_03_IPC_SENT",
      "RENDERER_ERROR",
      "RENDERER_UNHANDLED_REJECTION",
    ]);
    ipcMain.on(DIAGNOSTIC_CHANNEL, (_event, stage: unknown) => {
      if (typeof stage !== "string" || !allowedRendererStages.has(stage)) return;
      const source = stage.startsWith("EXIT_GUI") ? "gui_button" : "renderer";
      trace.emit(stage, source);
      if (stage === "START_15_RENDERER_READY" && diagnosticAutoExit) {
        setTimeout(() => cleanExit("diagnostic"), 500);
      }
    });
    registerQuitHandler(ipcMain, cleanExit, (stage, source) => trace.emit(stage, source));
    window.loadFile(rendererEntry);
  });
}
