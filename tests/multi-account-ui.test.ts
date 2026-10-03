import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULTS } from "../src/core/config.js";
import { classifyCodexLoginStatus, deviceLoginPendingStatus, parseCodexAccountIdentity, parseCodexDeviceLoginPrompt } from "../src/gui/account-auth.js";
import { codexProfilesRoot, loadPreferences, newAccountProfile, preferencesPath, savePreferences } from "../src/gui/preferences.js";
import { accountCatchupMinutes } from "../src/gui/scheduled-runner.js";
import { WindowsScheduler } from "../src/gui/scheduler.js";

const root = mkdtempSync(join(tmpdir(), "pinggpt-multi-account-test-"));
const oldState = process.env.XDG_STATE_HOME;
const oldConfig = process.env.XDG_CONFIG_HOME;
const oldLocal = process.env.LOCALAPPDATA;

before(() => {
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.LOCALAPPDATA = join(root, "localappdata");
});

after(() => {
  if (oldState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = oldState;
  if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldConfig;
  if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = oldLocal;
  rmSync(root, { recursive: true, force: true });
});

describe("Codex account authentication classification", () => {
  it("accepts only ChatGPT login mode for a ChatGPT profile", () => {
    assert.equal(classifyCodexLoginStatus("a", 0, "Logged in using ChatGPT").state, "connected");
    assert.equal(classifyCodexLoginStatus("a", 0, "Logged in using an API key").state, "wrong_auth");
    assert.equal(classifyCodexLoginStatus("a", 0, "Logged in using workload identity").state, "wrong_auth");
    assert.equal(classifyCodexLoginStatus("a", 1, "Not logged in").state, "not_connected");
  });

  it("parses device-login instructions without depending on ANSI color codes", () => {
    const output = [
      "\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
      "Enter this one-time code (expires in 15 minutes)",
      "   \u001b[94mABCD-EFGHI\u001b[0m",
    ].join("\n");
    assert.deepEqual(parseCodexDeviceLoginPrompt(output), {
      loginUrl: "https://auth.openai.com/codex/device",
      loginCode: "ABCD-EFGHI",
    });
  });

  it("keeps the device code in pending auth status while the login process is alive", () => {
    assert.deepEqual(deviceLoginPendingStatus("profile-a", {
      loginUrl: "https://auth.openai.com/codex/device",
      loginCode: "ABCD-EFGHI",
    }), {
      accountId: "profile-a",
      state: "login_started",
      detail: "Device login is waiting for authorization.",
      loginUrl: "https://auth.openai.com/codex/device",
      loginCode: "ABCD-EFGHI",
    });
  });

  it("extracts only non-secret ChatGPT identity fields from account/read", () => {
    assert.deepEqual(
      parseCodexAccountIdentity({
        account: {
          type: "chatgpt",
          email: "person@example.com",
          planType: "plus",
          accessToken: "must-not-be-consumed",
        },
        requiresOpenaiAuth: true,
      }),
      { email: "person@example.com", planType: "plus" },
    );
    assert.deepEqual(
      parseCodexAccountIdentity({
        account: { type: "chatgpt", email: null, planType: "pro" },
      }),
      { email: null, planType: "pro" },
    );
    assert.equal(parseCodexAccountIdentity({ account: { type: "apiKey" } }), null);
    assert.equal(parseCodexAccountIdentity({ account: null }), null);
  });
});

describe("multi-account profile persistence", () => {
  it("migrates legacy account data with the global catch-up value", () => {
    const path = preferencesPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      schedulerEnabled: true,
      runAtLogin: false,
      accounts: [{
        id: "default",
        displayName: "Legacy",
        enabled: true,
        message: "hi",
        schedules: ["06:00"],
        agent: "codex",
      }],
    }), "utf8");
    const loaded = loadPreferences(DEFAULTS);
    assert.equal(loaded.accounts.length, 1);
    assert.equal(loaded.accounts[0]?.catchupMinutes, DEFAULTS.ping.catchup_minutes);
    assert.equal(loaded.accounts[0]?.wakePc, false);
    assert.equal(loaded.accounts[0]?.codexHome, join(codexProfilesRoot(), "default"));
    assert.equal(loaded.schemaVersion, 2);
    assert.equal(loaded.profiles[0]?.activeStoreId, "store-default-legacy");
    assert.equal(loaded.accountStores[0]?.bindingState, "migration_pending");
    assert.equal(loaded.accountStores[0]?.codexHome, join(codexProfilesRoot(), "default"));
  });

  it("persists schema v2 without writing the runtime accounts projection", () => {
    const loaded = loadPreferences(DEFAULTS);
    savePreferences(loaded);
    const raw = JSON.parse(readFileSync(preferencesPath(), "utf8")) as Record<string, unknown>;
    assert.equal(raw.schemaVersion, 2);
    assert.ok(Array.isArray(raw.profiles));
    assert.ok(Array.isArray(raw.accountStores));
    assert.equal("accounts" in raw, false);
  });

  it("creates independent Codex homes and safe unique profile ids", () => {
    const first = newAccountProfile(DEFAULTS, []);
    const second = newAccountProfile(DEFAULTS, [first]);
    assert.equal(first.agent, "codex");
    assert.equal(first.enabled, false);
    assert.equal(first.wakePc, true);
    assert.notEqual(first.id, second.id);
    assert.match(first.id, /^profile-[A-Za-z0-9_.-]+$/);
    assert.ok(first.codexHome?.startsWith(codexProfilesRoot()));
    assert.notEqual(first.codexHome, second.codexHome);
  });

  it("uses each account's catch-up window with legacy fallback", () => {
    const base = {
      id: "a",
      displayName: "A",
      enabled: true,
      message: "hi",
      schedules: ["06:00"],
      agent: "codex" as const,
    };
    assert.equal(accountCatchupMinutes({ ...base, catchupMinutes: 7 }, DEFAULTS), 7);
    assert.equal(accountCatchupMinutes(base, DEFAULTS), DEFAULTS.ping.catchup_minutes);
    assert.equal(accountCatchupMinutes({ ...base, catchupMinutes: 999 }, DEFAULTS), 180);
  });
});

describe("multi-account scheduler reconciliation", () => {
  it("removes deleted profile tasks while global scheduling is off", () => {
    const receipt = join(root, "schedule.json");
    const calls: string[][] = [];
    const scheduler = new WindowsScheduler("C:\\PingGPT\\PingGPT.exe", (args) => {
      calls.push(args);
      return { ok: true, output: "Ready" };
    }, receipt);
    const accountA = {
      id: "account-a", displayName: "A", enabled: true, message: "hi",
      schedules: ["06:00"], agent: "codex" as const, catchupMinutes: 10,
    };
    const accountB = {
      id: "account-b", displayName: "B", enabled: true, message: "hi",
      schedules: ["07:00"], agent: "codex" as const, catchupMinutes: 20,
    };
    scheduler.install([accountA, accountB]);
    calls.length = 0;
    const kept = scheduler.prune([accountA]);
    assert.equal(kept.length, 1);
    const deleted = calls.filter((args) => args[0] === "/Delete").map((args) => args[2]);
    assert.equal(deleted.length, 1);
    assert.match(deleted[0] ?? "", /account-b/);
  });

  it("keeps a stale task tracked when Windows refuses to delete it", () => {
    const receipt = join(root, "schedule-delete-failure.json");
    const accountA = {
      id: "account-a", displayName: "A", enabled: true, message: "hi",
      schedules: ["06:00"], agent: "codex" as const, catchupMinutes: 10,
    };
    const accountB = {
      id: "account-b", displayName: "B", enabled: true, message: "hi",
      schedules: ["07:00"], agent: "codex" as const, catchupMinutes: 20,
    };
    const installScheduler = new WindowsScheduler("C:\\PingGPT\\PingGPT.exe", () => ({ ok: true, output: "Ready" }), receipt);
    installScheduler.install([accountA, accountB]);

    const failingScheduler = new WindowsScheduler("C:\\PingGPT\\PingGPT.exe", (args) => {
      if (args[0] === "/Delete" && String(args[2]).includes("account-b")) return { ok: false, output: "ACCESS_DENIED" };
      return { ok: true, output: "Ready" };
    }, receipt);
    assert.throws(() => failingScheduler.prune([accountA]), /could not remove obsolete PingGPT tasks/);
    const raw = JSON.parse(readFileSync(receipt, "utf8")) as { tasks: Array<{ name: string }> };
    assert.ok(raw.tasks.some((task) => task.name.includes("account-b")));
  });

  it("routes each desired task with its exact account id", () => {
    const receipt = join(root, "schedule-account-routing.json");
    const actions: string[] = [];
    const scheduler = new WindowsScheduler("C:\\PingGPT\\PingGPT.exe", (args) => {
      if (args[0] === "/Create") actions.push(String(args[args.indexOf("/TR") + 1]));
      return { ok: true, output: "Ready" };
    }, receipt);
    scheduler.install([
      { id: "profile-a", displayName: "A", enabled: true, message: "hi", schedules: ["06:00"], agent: "codex" as const, wakePc: true },
      { id: "profile-a-long", displayName: "B", enabled: true, message: "hi", schedules: ["07:00"], agent: "codex" as const, wakePc: false },
    ]);
    assert.equal(actions.length, 2);
    assert.match(actions[0] ?? "", /"profile-a"/);
    assert.match(actions[1] ?? "", /"profile-a-long"/);
  });

  it("configures wake only for selected profiles and keeps every task AC-only", () => {
    const receipt = join(root, "schedule-power.json");
    const calls: string[][] = [];
    const scheduler = new WindowsScheduler("C:\\PingGPT\\PingGPT.exe", (args) => {
      calls.push(args);
      return { ok: true, output: "Ready" };
    }, receipt);
    scheduler.install([
      { id: "wake", displayName: "Wake", enabled: true, message: "hi", schedules: ["06:00"], agent: "codex" as const, wakePc: true },
      { id: "no-wake", displayName: "No Wake", enabled: true, message: "hi", schedules: ["07:00"], agent: "codex" as const, wakePc: false },
    ]);
    const powerCalls = calls.filter((args) => args[0] === "@ConfigurePower");
    assert.equal(powerCalls.length, 2);
    assert.deepEqual(powerCalls.map((args) => args[2]), ["true", "false"]);
  });
});

describe("multi-account GUI wiring", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("exposes dynamic account cards instead of one fixed ping target", () => {
    const html = source("src/gui/renderer/index.html");
    const app = source("src/gui/renderer/app.js");
    assert.match(html, /id="add-account"/);
    assert.match(html, /id="account-list"/);
    assert.doesNotMatch(html, /id="ping-agent"|id="ping-message"|id="catchup"/);
    assert.match(app, /newAccountProfile\(\)/);
    assert.match(app, /readAccounts\(\)/);
    assert.match(app, /toggleAccountManager\(card\)/);
    assert.match(app, /getAccountStores\(profileId\)/);
    assert.match(app, /createAccountStore\(profileId\)/);
    assert.match(app, /activateAccountStore\(profileId, storeId\)/);
    assert.match(app, /account-auth-identity/);
    assert.match(app, /Identity verified by Codex/);
    assert.match(app, /Manage account/);
  });

  it("wires account creation and login through sandboxed IPC", () => {
    const preload = source("src/gui/preload.cts");
    const main = source("src/gui/main.ts");
    assert.match(preload, /automode:new-account-profile/);
    assert.match(preload, /automode:account-auth-status/);
    assert.match(preload, /automode:account-connect/);
    assert.match(preload, /automode:account-stores/);
    assert.match(preload, /automode:account-store-create/);
    assert.match(preload, /automode:account-store-auth-status/);
    assert.match(preload, /automode:account-store-connect/);
    assert.match(preload, /automode:account-store-activate/);
    assert.match(preload, /automode:open-external-login/);
    assert.match(preload, /url: string, code: string/);
    assert.match(main, /automode:new-account-profile/);
    assert.match(main, /automode:account-auth-status/);
    assert.match(main, /automode:account-connect/);
    assert.match(main, /automode:account-stores/);
    assert.match(main, /automode:account-store-create/);
    assert.match(main, /automode:account-store-auth-status/);
    assert.match(main, /automode:account-store-connect/);
    assert.match(main, /automode:account-store-activate/);
    assert.match(main, /automode:open-external-login/);
    assert.match(main, /auth\.openai\.com/);
    assert.match(main, /clipboard\.writeText\(code\)/);
    assert.match(main, /\[A-Z0-9-\]\{2,30\}/);
    assert.match(source("src/gui/account-auth.ts"), /login", "--device-auth"/);
    assert.match(source("src/gui/renderer/app.js"), /Device code:/);
    assert.match(source("src/gui/renderer/app.js"), /copied to clipboard/);
  });

  it("keeps Start Menu integration while disabling the Desktop shortcut", () => {
    const packageJson = JSON.parse(source("package.json")) as {
      build: { nsis: { createDesktopShortcut: boolean; createStartMenuShortcut: boolean } };
    };
    assert.equal(packageJson.build.nsis.createDesktopShortcut, false);
    assert.equal(packageJson.build.nsis.createStartMenuShortcut, true);
  });
});
