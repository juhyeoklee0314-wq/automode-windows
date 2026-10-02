import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { redactSecrets } from "../src/core/redact.js";
import { acquireExecutionLock, clearLease, executionLockPath, leaseIsLive, STALE_LOCK_GRACE_MS, writeLease } from "../src/gui/lease.js";
import { defaults, loadDiagnosticPreferences, loadPreferences, preferencesPath, savePreferences } from "../src/gui/preferences.js";
import { reliablePing } from "../src/gui/reliable-ping.js";
import { GUI_TASK_PREFIX, schedulerExecutable, WindowsScheduler } from "../src/gui/scheduler.js";
import { buildPingEnvironment, headlessArgv } from "../src/agents/ping.js";
import { accountPingEnvironment, accountPingUnsetEnvironment, elapsedMinutesForSchedule, runScheduled, runScheduledDryRun } from "../src/gui/scheduled-runner.js";
import { recordResume, recordSuspend, recentlyResumedFromSuspend } from "../src/gui/power-state.js";
import { QUIT_CHANNEL, registerQuitHandler } from "../src/gui/shutdown.js";
import { TRAY_ICON_RELATIVE_PATH, trayIconPath } from "../src/gui/tray-icon.js";
import { DEFAULTS } from "../src/core/config.js";
import { codexNativeCandidates, commandCandidates, prepareStdioSpawn } from "../src/platform/command.js";
import { DIAGNOSTIC_LOG_PATH, DiagnosticTrace } from "../src/gui/diagnostics.js";
import { resolveProcessMode } from "../src/gui/routing.js";

const root = mkdtempSync(join(tmpdir(), "automode-gui-test-"));
const oldState = process.env.XDG_STATE_HOME;
const oldConfig = process.env.XDG_CONFIG_HOME;

before(() => {
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_CONFIG_HOME = join(root, "config");
});

after(() => {
  if (oldState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = oldState;
  if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldConfig;
  rmSync(root, { recursive: true, force: true });
});

describe("power wake state", () => {
  it("correlates a resume only after a recorded suspend", () => {
    const base = Date.now();
    recordSuspend(base, process.pid);
    assert.equal(recentlyResumedFromSuspend(base + 1_000), false);
    recordResume(base + 2_000, process.pid);
    assert.equal(recentlyResumedFromSuspend(base + 3_000), true);
    assert.equal(recentlyResumedFromSuspend(base + 400_000), false);
  });

  it("handles catch-up across midnight without treating future schedules as due", () => {
    assert.equal(elapsedMinutesForSchedule(new Date("2026-10-02T00:05:00Z"), "UTC", "23:55"), 10);
    assert.equal(elapsedMinutesForSchedule(new Date("2026-10-02T16:00:00Z"), "UTC", "17:00"), 1380);
  });
});

describe("Windows command resolution", () => {
  it("never selects an extensionless npm shim on Windows", () => {
    assert.deepEqual(
      commandCandidates("C:\\npm\\codex", "win32", ".COM;.EXE;.BAT;.CMD"),
      [
        "C:\\npm\\codex.com",
        "C:\\npm\\codex.exe",
        "C:\\npm\\codex.bat",
        "C:\\npm\\codex.cmd",
      ],
    );
  });

  it("leaves an already-qualified command untouched", () => {
    assert.deepEqual(
      commandCandidates("C:\\npm\\codex.cmd", "win32", ".COM;.EXE;.BAT;.CMD"),
      ["C:\\npm\\codex.cmd"],
    );
  });

  it("derives the native Codex executable behind a global npm shim", () => {
    const candidates = codexNativeCandidates(
      "C:\\Users\\sapdo\\AppData\\Local\\Author Software\\nvm\\installs\\v20.20.2\\codex.cmd",
      "win32",
      "x64",
    );
    assert.equal(
      candidates[0],
      "C:\\Users\\sapdo\\AppData\\Local\\Author Software\\nvm\\installs\\v20.20.2\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
    );
    assert.ok(candidates.some((entry) =>
      entry.endsWith("\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe")));
  });

  it("routes long-lived Windows cmd shims through cmd.exe so redirected stdin survives", () => {
    const oldComSpec = process.env.ComSpec;
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    try {
      const prepared = prepareStdioSpawn(
        "C:\\Program Files\\npm\\codex.cmd",
        ["app-server", "--listen", "stdio://"],
      );
      if (process.platform === "win32") {
        assert.equal(prepared.command, "C:\\Windows\\System32\\cmd.exe");
        assert.deepEqual(prepared.args, [
          "/d",
          "/s",
          "/c",
          "\"C:\\Program Files\\npm\\codex.cmd\" \"app-server\" \"--listen\" \"stdio://\"",
        ]);
      } else {
        assert.deepEqual(prepared, {
          command: "C:\\Program Files\\npm\\codex.cmd",
          args: ["app-server", "--listen", "stdio://"],
        });
      }
    } finally {
      if (oldComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = oldComSpec;
    }
  });
});

describe("GUI lifecycle lease", () => {
  it("is live only for an armed, current lease with a live owner", () => {
    writeLease(true, Date.now(), process.pid);
    assert.equal(leaseIsLive(), true);
    writeLease(true, Date.now() - 120_000, process.pid);
    assert.equal(leaseIsLive(), false);
    writeLease(true, Date.now(), 2_000_000_000);
    assert.equal(leaseIsLive(), false);
  });

  it("clean exit disarms scheduled execution", async () => {
    writeLease(true, Date.now(), process.pid);
    clearLease();
    assert.equal(leaseIsLive(), false);
    assert.equal(await runScheduled("default", "0600-0"), 75);
  });
});

describe("GUI native control wiring", () => {
  it("routes the renderer quit command to the canonical clean exit callback", () => {
    let channel = "";
    let listener: ((...args: unknown[]) => void) | undefined;
    let exits = 0;
    let source = "";
    const stages: string[] = [];
    registerQuitHandler({
      on(name, callback) {
        channel = name;
        listener = callback;
      },
    }, (selectedSource) => { exits += 1; source = selectedSource; }, (stage) => stages.push(stage));
    assert.equal(channel, QUIT_CHANNEL);
    assert.equal(exits, 0);
    listener?.({});
    assert.equal(exits, 1);
    assert.equal(source, "gui_button");
    assert.deepEqual(stages, ["EXIT_GUI_04_IPC_MAIN_RECEIVED"]);
  });

  it("routes scheduled modes before the normal GUI path", () => {
    assert.deepEqual(resolveProcessMode(["Automode.exe", "--scheduled-runner", "default", "0600-0"]), {
      kind: "scheduled", accountId: "default", scheduleId: "0600-0",
    });
    assert.deepEqual(resolveProcessMode(["Automode.exe"]), { kind: "gui" });
  });

  it("writes bounded redacted diagnostic events without allowing trace identity overwrite", () => {
    new DiagnosticTrace("unit-test").emit("TEST_STAGE", "test", {
      detail: "access_token=secret123",
      runId: "spoofed-run",
      pid: 0,
      stage: "SPOOFED_STAGE",
      buildIdentity: "spoofed-build",
    });
    const text = readFileSync(DIAGNOSTIC_LOG_PATH(), "utf8");
    assert.match(text, /TEST_STAGE/);
    assert.match(text, /unit-test/);
    assert.doesNotMatch(text, /secret123/);
    assert.doesNotMatch(text, /spoofed-run|SPOOFED_STAGE|spoofed-build/);
  });

  it("ships an explicit non-empty PNG tray asset in the packaged file set", () => {
    const projectRoot = process.cwd();
    const path = trayIconPath(projectRoot);
    assert.equal(TRAY_ICON_RELATIVE_PATH.endsWith("tray-icon.png"), true);
    assert.equal(existsSync(path), true);
    assert.ok(readFileSync(path).length > 100);
    const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
      build?: { files?: string[] };
    };
    assert.ok(packageJson.build?.files?.includes("src/gui/assets/**/*"));
  });
});

describe("Windows GUI scheduler", () => {
  it("uses a separate namespace and a stable executable action", () => {
    const calls: string[][] = [];
    const scheduler = new WindowsScheduler("C:\\Program Files\\Automode\\Automode.exe", (args) => {
      calls.push(args);
      return { ok: true, output: "Ready" };
    });
    const tasks = scheduler.install([{
      id: "default", displayName: "Default", enabled: true, message: "hi",
      schedules: ["06:00", "17:00"], agent: "codex",
    }]);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((task) => task.name.startsWith(GUI_TASK_PREFIX)));
    assert.ok(tasks.every((task) => !["Automode Ping 0600", "Automode Ping 1700"].includes(task.name)));
    const create = calls.find((args) => args[0] === "/Create");
    assert.ok(create);
    const action = create![create!.indexOf("/TR") + 1]!;
    assert.match(action, /C:\\Program Files\\Automode\\Automode\.exe/);
    assert.match(action, /--scheduled-runner/);
  });

  it("uses the original Portable launcher instead of its temporary extraction", () => {
    assert.equal(
      schedulerExecutable("C:\\Temp\\Automode.exe", "C:\\Tools\\Automode-Windows-Portable.exe"),
      "C:\\Tools\\Automode-Windows-Portable.exe",
    );
    assert.equal(schedulerExecutable("C:\\Program Files\\Automode\\Automode.exe", ""), "C:\\Program Files\\Automode\\Automode.exe");
  });

  it("uses the stable launcher for login startup and reconciles enabled legacy registration", () => {
    const source = readFileSync(join(process.cwd(), "src", "gui", "main.ts"), "utf8");
    assert.match(source, /setLoginItemSettings\(\{ openAtLogin: enabled, path: schedulerExecutable\(process\.execPath\), args \}\)/);
    assert.match(source, /preferences\.runAtLogin/);
    assert.match(source, /setLoginItemSettings\(\{[\s\S]*openAtLogin: true,[\s\S]*path: schedulerExecutable\(process\.execPath\)/);
    assert.doesNotMatch(source, /setLoginItemSettings\(\{ openAtLogin: enabled, path: process\.execPath/);
  });

  it("disables only tasks recorded in its own receipt", () => {
    const calls: string[][] = [];
    const scheduler = new WindowsScheduler("C:\\Automode.exe", (args) => {
      calls.push(args);
      return { ok: true, output: "Ready" };
    });
    scheduler.setEnabled(false);
    const names = calls.filter((args) => args[0] === "/Change").map((args) => args[2]);
    assert.ok(names.every((name) => name?.startsWith(GUI_TASK_PREFIX)));
    assert.ok(!names.includes("Automode Ping 0600"));
    assert.ok(!names.includes("Automode Ping 1700"));
  });

  it("reads diagnostic receipt identities without invoking Task Scheduler and surfaces malformed receipts", () => {
    const receipt = join(root, "diagnostic-receipt.json");
    let externalCalls = 0;
    const scheduler = new WindowsScheduler("C:\\Automode.exe", () => {
      externalCalls += 1;
      return { ok: true, output: "Ready" };
    }, receipt);
    assert.deepEqual(scheduler.diagnosticReceiptTasks(), []);
    assert.equal(externalCalls, 0);

    writeFileSync(receipt, JSON.stringify({ tasks: [{
      name: "Automode GUI Ping default 0600-0",
      scheduleId: "0600-0",
      time: "06:00",
      installed: true,
      enabled: true,
    }] }), "utf8");
    assert.equal(scheduler.diagnosticReceiptTasks().length, 1);
    assert.equal(externalCalls, 0);

    writeFileSync(receipt, "{not-json", "utf8");
    assert.throws(() => scheduler.diagnosticReceiptTasks());
    assert.equal(externalCalls, 0);
  });
});

describe("reliability safeguards", () => {
  it("reclaims a lock whose owner PID is no longer alive", () => {
    const path = executionLockPath("stale-unit-test");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({
      identity: "stale-unit-test",
      ownerPid: 2_000_000_000,
      createdAt: Date.now() - STALE_LOCK_GRACE_MS - 1,
    }), "utf8");
    const release = acquireExecutionLock("stale-unit-test");
    assert.ok(release);
    release?.();
    assert.equal(existsSync(path), false);
  });

  it("never reclaims a live long-running lock", () => {
    const identity = "live-long-running-unit-test";
    const path = executionLockPath(identity);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({
      identity,
      ownerPid: process.pid,
      createdAt: Date.now() - STALE_LOCK_GRACE_MS * 10,
    }), "utf8");
    assert.equal(acquireExecutionLock(identity), null);
    assert.equal(existsSync(path), true);
  });

  it("never reclaims a young lock or a mismatched execution identity", () => {
    const identity = "identity-unit-test";
    const path = executionLockPath(identity);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ identity, ownerPid: 2_000_000_000, createdAt: Date.now() }), "utf8");
    assert.equal(acquireExecutionLock(identity), null);
    writeFileSync(path, JSON.stringify({
      identity: "different-identity",
      ownerPid: 2_000_000_000,
      createdAt: Date.now() - STALE_LOCK_GRACE_MS - 1,
    }), "utf8");
    assert.equal(acquireExecutionLock(identity), null);
  });

  it("scheduled dry-run cannot commit production dedupe state", async () => {
    savePreferences(defaults(DEFAULTS));
    const statePath = join(process.env.XDG_STATE_HOME!, "automode", "state.json");
    const code = await runScheduledDryRun("default", "0500-0");
    assert.ok([0, 127].includes(code));
    assert.equal(existsSync(statePath), false);
  });

  it("keeps headless Codex pings ephemeral so they do not pollute task history", () => {
    assert.deepEqual(headlessArgv("codex", "hi"), ["codex", "exec", "--ephemeral", "hi"]);
  });

  it("applies CODEX_HOME only to an explicitly configured Codex account", () => {
    const inherited = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "inherited-profile";
    const base = { id: "default", displayName: "Default", enabled: true, message: "hi", schedules: ["05:00"] };
    assert.equal(accountPingEnvironment({ ...base, agent: "codex" }), undefined);
    assert.deepEqual(accountPingEnvironment({ ...base, agent: "codex", codexHome: "C:\\Profiles\\work" }), {
      CODEX_HOME: "C:\\Profiles\\work",
    });
    assert.deepEqual(accountPingUnsetEnvironment({ ...base, agent: "codex", codexHome: "C:\\Profiles\\work" }), [
      "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
    ]);
    assert.equal(accountPingEnvironment({ ...base, agent: "claude", codexHome: "C:\\Profiles\\work" }), undefined);
    const childEnv = buildPingEnvironment(
      { CODEX_HOME: "C:\\Profiles\\work", OPENAI_API_KEY: "temporary-value" },
      ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
    );
    assert.equal(childEnv.CODEX_HOME, "C:\\Profiles\\work");
    assert.equal(childEnv.OPENAI_API_KEY, undefined);
    assert.equal(childEnv.CODEX_API_KEY, undefined);
    assert.equal(childEnv.CODEX_ACCESS_TOKEN, undefined);
    assert.equal(process.env.CODEX_HOME, "inherited-profile");
    if (inherited === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = inherited;
  });

  it("uses one bounded retry and then succeeds", async () => {
    let attempts = 0;
    const result = await reliablePing("codex", "hi", undefined, {
      attempts: 2,
      retryDelayMs: 0,
      waitForNetwork: async () => true,
      ping: async () => (++attempts === 1 ? 1 : 0),
    });
    assert.equal(result, 0);
    assert.equal(attempts, 2);
  });

  it("does not send when the network-ready wait fails", async () => {
    let attempts = 0;
    const result = await reliablePing("codex", "hi", undefined, {
      waitForNetwork: async () => false,
      ping: async () => { attempts += 1; return 0; },
    });
    assert.equal(result, 68);
    assert.equal(attempts, 0);
  });

  it("redacts common credentials", () => {
    const input = [
      "Authorization: Basic dXNlcjpwYXNz with trailing credential material",
      "OPENAI_API_KEY=env-api-key",
      "SERVICE_TOKEN='env token'",
      "DB_PASSWORD=env-password",
      "APP_SECRET=env-secret",
      "access_token=secret123 sk-abcdefghijk",
    ].join("\n");
    const output = redactSecrets(input);
    assert.doesNotMatch(output, /dXNlcjpwYXNz|trailing credential|env-api-key|env token|env-password|env-secret|secret123|sk-abcdefghijk/);
    assert.match(output, /REDACTED/);
  });
});

describe("multi-account-ready preferences", () => {
  it("projects the legacy single-account config as the default profile", () => {
    const preferences = defaults(DEFAULTS);
    assert.equal(preferences.accounts[0]?.id, "default");
    assert.deepEqual(preferences.accounts[0]?.schedules, DEFAULTS.ping.times);
    savePreferences(preferences);
    const raw = readFileSync(join(process.env.XDG_STATE_HOME!, "automode", "gui-preferences.json"), "utf8");
    assert.doesNotMatch(raw, /access_token|refresh_token|cookie|auth\.json/i);
    assert.equal(loadPreferences(DEFAULTS).accounts[0]?.id, "default");
  });

  it("keeps normal fallback behavior but exposes corrupt preferences to diagnostics", () => {
    mkdirSync(join(preferencesPath(), ".."), { recursive: true });
    writeFileSync(preferencesPath(), "{not-json", "utf8");
    assert.equal(loadPreferences(DEFAULTS).accounts[0]?.id, "default");
    assert.throws(() => loadDiagnosticPreferences(DEFAULTS));
  });
});
