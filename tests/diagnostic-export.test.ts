import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  diagnosticFilename,
  exportDiagnosticSnapshot,
  filterDiagnosticLog,
  uniqueDiagnosticPath,
  type DiagnosticExportContext,
} from "../src/gui/diagnostic-export.js";

const now = new Date("2026-09-29T08:45:01.000Z");
const line = (value: Record<string, unknown>) => JSON.stringify(value);

function context(): DiagnosticExportContext {
  return {
    desktopPath: "C:\\Users\\example\\Desktop",
    appVersion: "0.1.0",
    buildIdentity: "phase7-test",
    diagnosticBuildIdentity: "phase7-test",
    packaged: true,
    runId: "current-run",
    primaryInstance: true,
    schedulerTarget: "C:\\Apps\\PingGPT.exe",
    diagnosticLogPath: "C:\\state\\phase6-diagnostic.log",
    schedulerTasks: [{ name: "Automode GUI Ping default 0600-0", scheduleId: "0600-0", time: "06:00", installed: true, enabled: true }],
    accounts: [{
      id: "default",
      profileId: "default",
      storeId: "store-default",
      displayName: "Default",
      enabled: true,
      agent: "codex",
      codexHome: "C:\\CodexHome",
      identityKey: "hashed-identity",
      bindingState: "ready",
      message: "TOP SECRET MESSAGE",
      schedules: ["06:00"],
    }],
    now,
  };
}

describe("Phase 7 diagnostic export", () => {
  it("uses the required local timestamp filename", () => {
    const local = new Date(2026, 8, 29, 17, 45, 1);
    assert.equal(diagnosticFilename(local), "PingGPT_Diagnostic_20260929_174501.txt");
  });

  it("adds a suffix when the timestamp filename already exists", () => {
    const base = diagnosticFilename(now);
    const path = uniqueDiagnosticPath("C:\\Desktop", now, (candidate) => candidate.endsWith(base));
    assert.match(path, /-2\.txt$/);
  });

  it("prefers exact runId and excludes stale historical runs", () => {
    const text = [
      line({ timestamp: now.toISOString(), pid: process.pid, runId: "stale", detail: "STALE_MARKER" }),
      line({ timestamp: now.toISOString(), pid: 1, runId: "current-run", detail: "CURRENT_MARKER" }),
    ].join("\n");
    const selected = filterDiagnosticLog(text, "current-run", process.pid, now);
    assert.equal(selected.mode, "RUN_ID");
    assert.match(selected.lines.join("\n"), /CURRENT_MARKER/);
    assert.doesNotMatch(selected.lines.join("\n"), /STALE_MARKER/);
  });

  it("falls back to PID only when runId is unavailable", () => {
    const text = line({ timestamp: now.toISOString(), pid: process.pid, runId: "other", detail: "PID_MARKER" });
    const selected = filterDiagnosticLog(text, "missing", process.pid, now);
    assert.equal(selected.mode, "PID");
    assert.match(selected.lines[0]!, /PID_MARKER/);
  });

  it("does not accept stale PID evidence outside the bounded window", () => {
    const text = line({
      timestamp: new Date(now.getTime() - 31 * 60_000).toISOString(),
      pid: process.pid,
      runId: "other",
      detail: "STALE_PID_MARKER",
    });
    const selected = filterDiagnosticLog(text, "missing", process.pid, now);
    assert.equal(selected.mode, "NO_MATCH");
    assert.equal(selected.status, "UNAVAILABLE");
    assert.equal(selected.lines.length, 0);
  });

  it("uses a bounded recent-time fallback and excludes old records", () => {
    const text = [
      line({ timestamp: new Date(now.getTime() - 31 * 60_000).toISOString(), pid: 1, runId: "old", detail: "OLD_MARKER" }),
      line({ timestamp: new Date(now.getTime() - 5 * 60_000).toISOString(), pid: 2, runId: "recent", detail: "RECENT_MARKER" }),
    ].join("\n");
    const selected = filterDiagnosticLog(text, "missing", 999_999, now);
    assert.equal(selected.mode, "BOUNDED_TIME_FALLBACK");
    assert.equal(selected.status, "DEGRADED");
    assert.match(selected.lines.join("\n"), /RECENT_MARKER/);
    assert.doesNotMatch(selected.lines.join("\n"), /OLD_MARKER/);
  });

  it("writes a redacted snapshot without the configured ping message", async () => {
    let writtenPath = "";
    let written = "";
    const result = await exportDiagnosticSnapshot(context(), {
      pathExists: () => false,
      readText: () => line({ timestamp: now.toISOString(), pid: process.pid, runId: "current-run", detail: "Authorization: Bearer abc.secret" }),
      processTree: () => "pid=1 access_token=unsafe",
      crashEvents: () => "exceptionCode=0x80000003 offset=0x14C9B",
      schedulerDetails: () => "action=PingGPT.exe --scheduled-runner default 0600-0",
      writeExclusive: (path, text) => { writtenPath = path; written = text; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "COMPLETE");
    assert.match(writtenPath, /PingGPT_Diagnostic_/);
    assert.match(written, /messageConfigured/);
    assert.match(written, /\[REDACTED\]/);
    assert.doesNotMatch(written, /TOP SECRET MESSAGE|abc\.secret|unsafe/);
    assert.match(written, /current-run|0x14C9B/);
  });

  it("isolates missing log, WER, scheduler, and process failures as PARTIAL", async () => {
    let written = "";
    const unavailable = () => { throw new Error("ACCESS_DENIED password=hunter2"); };
    const result = await exportDiagnosticSnapshot(context(), {
      pathExists: () => false,
      readText: unavailable,
      processTree: unavailable,
      crashEvents: unavailable,
      schedulerDetails: unavailable,
      writeExclusive: (_path, text) => { written = text; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "PARTIAL");
    assert.match(written, /EXPORT_STATUS=PARTIAL/);
    assert.match(written, /STATUS=UNAVAILABLE/);
    assert.doesNotMatch(written, /hunter2/);
  });

  it("marks recent-time-only evidence as PARTIAL instead of COMPLETE", async () => {
    let written = "";
    const result = await exportDiagnosticSnapshot(context(), {
      pathExists: () => false,
      readText: () => line({
        timestamp: new Date(now.getTime() - 5 * 60_000).toISOString(),
        pid: 999_999,
        runId: "other",
        detail: "RECENT_ONLY",
      }),
      processTree: () => "none",
      crashEvents: () => JSON.stringify({ queryStatus: "OK", matchingEventCount: 0, events: [] }),
      schedulerDetails: () => "none",
      writeExclusive: (_path, text) => { written = text; },
    });
    assert.equal(result.status, "PARTIAL");
    assert.match(written, /STATUS=DEGRADED/);
    assert.match(written, /DIAGNOSTIC_FILTER_MODE=BOUNDED_TIME_FALLBACK/);
  });

  it("marks no matching diagnostic evidence as unavailable", async () => {
    let written = "";
    const result = await exportDiagnosticSnapshot(context(), {
      pathExists: () => false,
      readText: () => "",
      processTree: () => "none",
      crashEvents: () => JSON.stringify({ queryStatus: "OK", matchingEventCount: 0, events: [] }),
      schedulerDetails: () => "none",
      writeExclusive: (_path, text) => { written = text; },
    });
    assert.equal(result.status, "PARTIAL");
    assert.match(written, /\[DIAGNOSTIC_LOG\]\nSTATUS=UNAVAILABLE/);
    assert.doesNotMatch(written, /NO_MATCHING_RECORDS/);
  });

  it("distinguishes a successful zero-event WER query from query failure", async () => {
    let zeroEventText = "";
    const zeroEvent = await exportDiagnosticSnapshot(context(), {
      pathExists: () => false,
      readText: () => line({ timestamp: now.toISOString(), pid: process.pid, runId: "current-run" }),
      processTree: () => "none",
      crashEvents: () => JSON.stringify({ queryStatus: "OK", queriedEventCount: 0, matchingEventCount: 0, events: [] }),
      schedulerDetails: () => "none",
      writeExclusive: (_path, text) => { zeroEventText = text; },
    });
    assert.equal(zeroEvent.status, "COMPLETE");
    assert.match(zeroEventText, /matchingEventCount[^\n]*0/);

    let unavailableText = "";
    const unavailable = await exportDiagnosticSnapshot(context(), {
      pathExists: () => false,
      readText: () => line({ timestamp: now.toISOString(), pid: process.pid, runId: "current-run" }),
      processTree: () => "none",
      crashEvents: () => { throw new Error("WER_QUERY_DENIED"); },
      schedulerDetails: () => "none",
      writeExclusive: (_path, text) => { unavailableText = text; },
    });
    assert.equal(unavailable.status, "PARTIAL");
    assert.match(unavailableText, /\[WINDOWS_CRASH_EVENTS\]\nSTATUS=UNAVAILABLE/);
  });

  it("isolates scheduler status and account preference acquisition failures", async () => {
    let written = "";
    const failedContext = {
      ...context(),
      schedulerStatusError: "SCHEDULER_STATUS_FAILED",
      accountPreferencesError: "PREFERENCES_READ_FAILED",
      schedulerTasks: [],
      accounts: [],
    };
    const result = await exportDiagnosticSnapshot(failedContext, {
      pathExists: () => false,
      readText: () => line({ timestamp: now.toISOString(), pid: process.pid, runId: "current-run" }),
      processTree: () => "none",
      crashEvents: () => "none",
      schedulerDetails: () => "NO_GUI_OWNED_TASKS",
      writeExclusive: (_path, text) => { written = text; },
    });
    assert.equal(result.status, "PARTIAL");
    assert.match(written, /Scheduler status unavailable/);
    assert.match(written, /Account preferences unavailable/);
    assert.doesNotMatch(written, /\[SCHEDULER_DIAGNOSTIC\]\nSTATUS=OK\nNO_GUI_OWNED_TASKS/);
  });

  it("reports Desktop write failure without throwing", async () => {
    const result = await exportDiagnosticSnapshot(context(), {
      pathExists: () => false,
      readText: () => "",
      processTree: () => "none",
      crashEvents: () => "none",
      schedulerDetails: () => "none",
      writeExclusive: () => { throw new Error("ACCESS_DENIED"); },
    });
    assert.deepEqual(result, { ok: false, status: "FAILED", error: "ACCESS_DENIED" });
  });
});

describe("Phase 7 wiring and branding", () => {
  const root = process.cwd();
  const source = (path: string) => readFileSync(join(root, path), "utf8");

  it("wires renderer to preload to main IPC without exposing filesystem access", () => {
    assert.match(source("src/gui/renderer/app.js"), /automode\.exportDiagnostic\(\)/);
    assert.match(source("src/gui/preload.cts"), /ipcRenderer\.invoke\("automode:export-diagnostic"\)/);
    assert.match(source("src/gui/main.ts"), /ipcMain\.handle\("automode:export-diagnostic"/);
    assert.doesNotMatch(source("src/gui/renderer/app.js"), /node:fs|child_process/);
  });

  it("uses bounded asynchronous SystemRoot helpers for diagnostic collection", () => {
    const diagnostic = source("src/gui/diagnostic-export.ts");
    assert.doesNotMatch(diagnostic, /execFileSync/);
    assert.match(diagnostic, /execFile\(/);
    assert.match(diagnostic, /SystemRoot/);
    assert.match(diagnostic, /WindowsPowerShell["'],\s*["']v1\.0["'],\s*["']powershell\.exe/);
    assert.match(diagnostic, /systemBinary\("schtasks\.exe"\)/);
    assert.match(diagnostic, /timeout/);
    assert.match(diagnostic, /maxBuffer/);
    assert.match(diagnostic, /\$helperPid=\$PID/);
  });

  it("uses PingGPT user-facing branding while preserving compatibility identifiers", () => {
    const html = source("src/gui/renderer/index.html");
    const main = source("src/gui/main.ts");
    const packageJson = JSON.parse(source("package.json")) as { name: string; bin: Record<string, string>; build: { appId: string; productName: string } };
    assert.match(html, /PingGPT/);
    assert.doesNotMatch(html, />Automode<|AUTOMODE FOR WINDOWS|Exit Automode/);
    assert.match(main, /setToolTip\("PingGPT"\)|title: "PingGPT"/);
    assert.match(main, /setPath\("userData", join\(app\.getPath\("appData"\), "Automode"\)\)/);
    assert.equal(packageJson.build.productName, "PingGPT");
    assert.equal(packageJson.build.appId, "com.automode.windows");
    assert.ok(packageJson.bin.automode);
  });

  it("includes the logo, multi-size ICO, and PingGPT artifact names", () => {
    for (const asset of ["pinggpt-logo-source.png", "pinggpt-icon.png", "pinggpt-tray-64.png", "pinggpt.ico", "tray-icon.png"]) {
      assert.equal(existsSync(join(root, "src", "gui", "assets", asset)), true, asset);
    }
    const ico = readFileSync(join(root, "src", "gui", "assets", "pinggpt.ico"));
    assert.equal(ico.readUInt16LE(4), 7);
    const packageText = source("package.json");
    assert.match(packageText, /PingGPT-Windows-Setup/);
    assert.match(packageText, /PingGPT-Windows-Portable/);
    assert.match(packageText, /pinggpt\.ico/);
  });
});
