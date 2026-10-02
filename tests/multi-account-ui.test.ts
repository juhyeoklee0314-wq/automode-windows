import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULTS } from "../src/core/config.js";
import {
  classifyCodexLoginStatus,
  deviceLoginPendingStatus,
  parseCodexAccountIdentity,
  parseCodexDeviceLoginPrompt,
} from "../src/gui/account-auth.js";
import {
  activeAccountStore,
  codexProfilesRoot,
  findAccountTarget,
  loadPreferences,
  newAccountProfile,
  newAccountStore,
  preferencesPath,
  runnableAccountTargets,
} from "../src/gui/preferences.js";
import { accountCatchupMinutes } from "../src/gui/scheduled-runner.js";
import { expireMissedTaskResumeSchedulesForStore } from "../src/gui/service.js";
import { WindowsScheduler } from "../src/gui/scheduler.js";
import type { AccountTarget } from "../src/gui/types.js";

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

function target(profileId: string, storeId: string, time: string, wakePc = false): AccountTarget {
  return {
    id: profileId,
    profileId,
    storeId,
    displayName: profileId,
    enabled: true,
    codexHome: join(codexProfilesRoot(), profileId, storeId),
    identityKey: "identity-" + storeId,
    bindingState: "ready",
    message: "hi",
    schedules: [time],
    agent: "codex",
    catchupMinutes: 30,
    wakePc,
  };
}

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

  it("extracts only non-secret ChatGPT display identity fields from account/read", () => {
    assert.deepEqual(
      parseCodexAccountIdentity({
        account: {
          type: "chatgpt",
          email: "person@example.com",
          planType: "plus",
          accessToken: "must-not-be-consumed",
        },
      }),
      { email: "person@example.com", planType: "plus" },
    );
    assert.equal(parseCodexAccountIdentity({ account: { type: "apiKey" } }), null);
  });
});

describe("R1.07 account-store persistence", () => {
  it("projects v1 data into schema v2 without moving the existing CODEX_HOME", () => {
    const path = preferencesPath();
    mkdirSync(join(path, ".."), { recursive: true });
    const legacyHome = join(root, "legacy-codex-home");
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      schedulerEnabled: true,
      runAtLogin: false,
      accounts: [{
        id: "default",
        displayName: "Main",
        enabled: true,
        codexHome: legacyHome,
        message: "hi",
        schedules: ["06:00"],
        agent: "codex",
      }],
      taskResumeSchedules: [{
        id: "resume-old",
        accountId: "default",
        threadId: "01a00000-0000-7000-8000-000000000001",
        title: "Old task",
        runAt: new Date(Date.now() + 60_000).toISOString(),
        expectedUpdatedAt: 1,
        wakePc: false,
        enabled: true,
        createdAt: new Date().toISOString(),
      }],
    }), "utf8");

    const loaded = loadPreferences(DEFAULTS);
    assert.equal(loaded.schemaVersion, 2);
    assert.equal(loaded.accounts.length, 1);
    const profile = loaded.accounts[0]!;
    const store = activeAccountStore(profile);
    assert.ok(store);
    assert.equal(profile.displayName, "Main");
    assert.equal(store.codexHome, legacyHome);
    assert.equal(store.bindingState, "needs_verification");
    assert.equal(store.catchupMinutes, DEFAULTS.ping.catchup_minutes);
    assert.equal(loaded.taskResumeSchedules[0]?.profileId, "default");
    assert.equal(loaded.taskResumeSchedules[0]?.storeId, store.id);
  });

  it("creates a local profile with independent account stores", () => {
    const profile = newAccountProfile(DEFAULTS, []);
    const first = activeAccountStore(profile);
    assert.ok(first);
    const second = newAccountStore(DEFAULTS, profile);
    assert.equal(profile.agent, "codex");
    assert.equal(profile.enabled, false);
    assert.equal(first.wakePc, true);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.codexHome, second.codexHome);
    assert.ok(first.codexHome.startsWith(codexProfilesRoot()));
    assert.ok(second.codexHome.startsWith(codexProfilesRoot()));
    assert.equal(second.bindingState, "pending");
  });

  it("reuses the exact previous store when switching A to B to A", () => {
    const profile = newAccountProfile(DEFAULTS, []);
    profile.enabled = true;
    const a = activeAccountStore(profile)!;
    a.bindingState = "ready";
    a.identityKey = "identity-a";
    const b = newAccountStore(DEFAULTS, profile);
    b.bindingState = "ready";
    b.identityKey = "identity-b";
    profile.stores.push(b);

    const preferences = {
      schemaVersion: 2 as const,
      runAtLogin: false,
      schedulerEnabled: true,
      accounts: [profile],
      taskResumeSchedules: [],
    };

    profile.activeStoreId = a.id;
    assert.equal(findAccountTarget(preferences, profile.id, a.id)?.codexHome, a.codexHome);
    profile.activeStoreId = b.id;
    assert.equal(findAccountTarget(preferences, profile.id, b.id)?.codexHome, b.codexHome);
    profile.activeStoreId = a.id;
    assert.equal(findAccountTarget(preferences, profile.id, a.id)?.codexHome, a.codexHome);
  });

  it("exposes only the active ready store to automatic execution", () => {
    const profile = newAccountProfile(DEFAULTS, []);
    profile.enabled = true;
    const a = activeAccountStore(profile)!;
    a.bindingState = "ready";
    const b = newAccountStore(DEFAULTS, profile);
    b.bindingState = "ready";
    profile.stores.push(b);
    const preferences = {
      schemaVersion: 2 as const,
      runAtLogin: false,
      schedulerEnabled: true,
      accounts: [profile],
      taskResumeSchedules: [],
    };

    profile.activeStoreId = a.id;
    assert.deepEqual(runnableAccountTargets(preferences).map((entry) => entry.storeId), [a.id]);
    profile.activeStoreId = b.id;
    assert.deepEqual(runnableAccountTargets(preferences).map((entry) => entry.storeId), [b.id]);
    b.bindingState = "account_mismatch";
    assert.deepEqual(runnableAccountTargets(preferences), []);
  });

  it("expires a missed one-shot only when its inactive store is reactivated", () => {
    const profile = newAccountProfile(DEFAULTS, []);
    profile.enabled = true;
    const a = activeAccountStore(profile)!;
    a.bindingState = "ready";
    const b = newAccountStore(DEFAULTS, profile);
    b.bindingState = "ready";
    profile.stores.push(b);
    profile.activeStoreId = a.id;

    const preferences = {
      schemaVersion: 2 as const,
      runAtLogin: false,
      schedulerEnabled: true,
      accounts: [profile],
      taskResumeSchedules: [{
        id: "resume-b",
        profileId: profile.id,
        storeId: b.id,
        threadId: "01a00000-0000-7000-8000-000000000001",
        title: "B task",
        runAt: "2026-10-03T00:00:00.000Z",
        expectedUpdatedAt: null,
        wakePc: false,
        enabled: true,
        createdAt: "2026-10-02T00:00:00.000Z",
        completedAt: null,
        lastStatus: null,
      }],
    };

    assert.equal(expireMissedTaskResumeSchedulesForStore(
      preferences,
      profile.id,
      b.id,
      new Date("2026-10-03T00:01:00.000Z"),
    ), 1);
    assert.equal(preferences.taskResumeSchedules[0]?.enabled, false);
    assert.equal(preferences.taskResumeSchedules[0]?.lastStatus, "rejected");
  });

  it("uses each store catch-up window with legacy fallback", () => {
    const base = target("a", "store-a", "06:00");
    assert.equal(accountCatchupMinutes({ ...base, catchupMinutes: 7 }, DEFAULTS), 7);
    assert.equal(accountCatchupMinutes({ ...base, catchupMinutes: undefined }, DEFAULTS), DEFAULTS.ping.catchup_minutes);
    assert.equal(accountCatchupMinutes({ ...base, catchupMinutes: 999 }, DEFAULTS), 180);
  });
});

describe("R1.07 scheduler reconciliation", () => {
  it("removes tasks belonging to an inactive store", () => {
    const receipt = join(root, "schedule.json");
    const calls: string[][] = [];
    const scheduler = new WindowsScheduler("C:\\PingGPT\\PingGPT.exe", (args) => {
      calls.push(args);
      return { ok: true, output: "Ready" };
    }, receipt);
    const a = target("main", "store-a", "06:00");
    const b = target("main", "store-b", "07:00");
    scheduler.install([a, b]);
    calls.length = 0;
    const kept = scheduler.prune([b]);
    assert.equal(kept.length, 1);
    const deleted = calls.filter((args) => args[0] === "/Delete").map((args) => args[2]);
    assert.equal(deleted.length, 1);
    assert.match(deleted[0] ?? "", /store-a/);
  });

  it("keeps a stale task tracked when Windows refuses to delete it", () => {
    const receipt = join(root, "schedule-delete-failure.json");
    const a = target("main", "store-a", "06:00");
    const b = target("main", "store-b", "07:00");
    const installScheduler = new WindowsScheduler("C:\\PingGPT\\PingGPT.exe", () => ({ ok: true, output: "Ready" }), receipt);
    installScheduler.install([a, b]);

    const failingScheduler = new WindowsScheduler("C:\\PingGPT\\PingGPT.exe", (args) => {
      if (args[0] === "/Delete" && String(args[2]).includes("store-b")) return { ok: false, output: "ACCESS_DENIED" };
      return { ok: true, output: "Ready" };
    }, receipt);
    assert.throws(() => failingScheduler.prune([a]), /could not remove obsolete PingGPT tasks/);
    const raw = JSON.parse(readFileSync(receipt, "utf8")) as { tasks: Array<{ name: string }> };
    assert.ok(raw.tasks.some((task) => task.name.includes("store-b")));
  });

  it("routes each scheduled action with exact profile and store ids", () => {
    const receipt = join(root, "schedule-routing.json");
    const actions: string[] = [];
    const scheduler = new WindowsScheduler("C:\\PingGPT\\PingGPT.exe", (args) => {
      if (args[0] === "/Create") actions.push(String(args[args.indexOf("/TR") + 1]));
      return { ok: true, output: "Ready" };
    }, receipt);
    scheduler.install([
      target("main", "store-a", "06:00", true),
      target("sub", "store-c", "07:00", false),
    ]);
    assert.equal(actions.length, 2);
    assert.match(actions[0] ?? "", /"main" "store-a"/);
    assert.match(actions[1] ?? "", /"sub" "store-c"/);
  });

  it("keeps per-store wake choice", () => {
    const receipt = join(root, "schedule-power.json");
    const calls: string[][] = [];
    const scheduler = new WindowsScheduler("C:\\PingGPT\\PingGPT.exe", (args) => {
      calls.push(args);
      return { ok: true, output: "Ready" };
    }, receipt);
    scheduler.install([
      target("main", "wake", "06:00", true),
      target("sub", "no-wake", "07:00", false),
    ]);
    const powerCalls = calls.filter((args) => args[0] === "@ConfigurePower");
    assert.deepEqual(powerCalls.map((args) => args[2]), ["true", "false"]);
  });
});

describe("R1.07 account-management GUI wiring", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("presents one Manage account action and hides stored accounts until requested", () => {
    const app = source("src/gui/renderer/app.js");
    assert.match(app, /Manage account/);
    assert.match(app, /Connect another account/);
    assert.match(app, /account-store-manager hidden/);
    assert.match(app, /newAccountStore\(accountId\)/);
    assert.match(app, /activateAccountStore\(accountId, storeId\)/);
    assert.doesNotMatch(app, /Reconnect" : "Connect/);
  });

  it("wires account-store management through sandboxed IPC", () => {
    const preload = source("src/gui/preload.cts");
    const main = source("src/gui/main.ts");
    assert.match(preload, /automode:new-account-store/);
    assert.match(preload, /automode:account-activate-store/);
    assert.match(main, /automode:new-account-store/);
    assert.match(main, /automode:account-activate-store/);
    assert.match(source("src/gui/account-auth.ts"), /login", "--device-auth"/);
  });

  it("commits activeStoreId only after auth, ownership, and duplicate-store checks", () => {
    const service = source("src/gui/service.ts");
    const start = service.indexOf("async activateAccountStore");
    const auth = service.indexOf("await codexAuthStatus(account)", start);
    const discovery = service.indexOf("await discoverCodexTasks([account])", start);
    const mismatch = service.indexOf("const hasMismatch", start);
    const duplicate = service.indexOf("const duplicate", start);
    const commit = service.indexOf("profile.activeStoreId = store.id", duplicate);
    assert.ok(start >= 0);
    assert.ok(auth > start);
    assert.ok(discovery > auth);
    assert.ok(mismatch > discovery);
    assert.ok(duplicate > mismatch);
    assert.ok(commit > duplicate);
  });

  it("keeps Start Menu integration while disabling the Desktop shortcut", () => {
    const packageJson = JSON.parse(source("package.json")) as {
      build: { nsis: { createDesktopShortcut: boolean; createStartMenuShortcut: boolean } };
    };
    assert.equal(packageJson.build.nsis.createDesktopShortcut, false);
    assert.equal(packageJson.build.nsis.createStartMenuShortcut, true);
  });
});
