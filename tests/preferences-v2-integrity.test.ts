import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULTS } from "../src/core/config.js";
import { loadPreferences, preferencesPath } from "../src/gui/preferences.js";

const root = mkdtempSync(join(tmpdir(), "pinggpt-r107-preferences-integrity-"));
const oldState = process.env.XDG_STATE_HOME;
const oldConfig = process.env.XDG_CONFIG_HOME;
const oldLocal = process.env.LOCALAPPDATA;
const threadId = "01a00000-0000-7000-8000-000000000111";

before(() => {
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.LOCALAPPDATA = join(root, "localappdata");
});

after(() => {
  if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState;
  if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
  if (oldLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldLocal;
  rmSync(root, { recursive: true, force: true });
});

function write(raw: unknown): void {
  const path = preferencesPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(raw), "utf8");
}

function baseV2(schedule: Record<string, unknown>) {
  return {
    schemaVersion: 2,
    schedulerEnabled: true,
    runAtLogin: false,
    profiles: [{
      id: "main",
      displayName: "Main",
      enabled: true,
      agent: "codex",
      activeStoreId: "store-main-a",
      automation: { message: "hi", schedules: ["06:00"], catchupMinutes: 30, wakePc: false },
    }],
    accountStores: [{
      id: "store-main-a",
      profileId: "main",
      codexHome: "C:\\PingGPT\\A",
      identityKey: "a".repeat(64),
      bindingState: "bound",
      automation: { message: "hi", schedules: ["06:00"], catchupMinutes: 30, wakePc: false },
    }],
    taskResumeSchedules: [{
      id: "resume-test",
      accountId: "main",
      threadId,
      title: "Task",
      runAt: "2026-10-05T01:00:00.000Z",
      expectedUpdatedAt: null,
      wakePc: false,
      enabled: true,
      createdAt: "2026-10-03T01:00:00.000Z",
      ...schedule,
    }],
  };
}

describe("R1.07 preference integrity", () => {
  it("drops a schema v2 task resume that has no exact store id", () => {
    write(baseV2({}));
    assert.equal(loadPreferences(DEFAULTS).taskResumeSchedules.length, 0);
  });

  it("drops a schema v2 task resume whose store id is unknown", () => {
    write(baseV2({ storeId: "store-main-missing" }));
    assert.equal(loadPreferences(DEFAULTS).taskResumeSchedules.length, 0);
  });

  it("keeps a schema v2 task resume only when its exact store belongs to the profile", () => {
    write(baseV2({ storeId: "store-main-a" }));
    const loaded = loadPreferences(DEFAULTS);
    assert.equal(loaded.taskResumeSchedules.length, 1);
    assert.equal(loaded.taskResumeSchedules[0]?.storeId, "store-main-a");
  });

  it("allows the one-time v1 migration to attach a legacy resume to the imported store", () => {
    write({
      schemaVersion: 1,
      schedulerEnabled: true,
      runAtLogin: false,
      accounts: [{
        id: "main",
        displayName: "Main",
        enabled: true,
        codexHome: "C:\\PingGPT\\Legacy",
        message: "hi",
        schedules: ["06:00"],
        agent: "codex",
      }],
      taskResumeSchedules: [{
        id: "resume-v1",
        accountId: "main",
        threadId,
        title: "Legacy task",
        runAt: "2026-10-05T01:00:00.000Z",
        expectedUpdatedAt: null,
        wakePc: false,
        enabled: true,
        createdAt: "2026-10-03T01:00:00.000Z",
      }],
    });
    const loaded = loadPreferences(DEFAULTS);
    assert.equal(loaded.taskResumeSchedules.length, 1);
    assert.equal(loaded.taskResumeSchedules[0]?.storeId, "store-main-legacy");
  });
});
