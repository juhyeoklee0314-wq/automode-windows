import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("R1.07 active-store runtime gates", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("serializes account-store verification so parallel profile checks cannot overwrite newer bindings", () => {
    const runtime = source("src/gui/account-store-runtime.ts");
    const lockAt = runtime.indexOf("async function withVerificationLock");
    const unlockedAt = runtime.indexOf("async function verifyAccountStoreUnlocked");
    const publicAt = runtime.indexOf("export async function verifyAccountStore");
    assert.ok(lockAt >= 0);
    assert.ok(unlockedAt > lockAt);
    assert.ok(publicAt > unlockedAt);
    assert.match(runtime.slice(publicAt), /withVerificationLock\(\(\) => verifyAccountStoreUnlocked\(profileId, storeId\)\)/);
  });

  it("rebases Save changes onto fresh canonical store state instead of stale renderer preferences", () => {
    const service = source("src/gui/service.ts");
    const saveAt = service.indexOf("save(payload: SavePayload)");
    const configSaveAt = service.indexOf("configmod.save(payload.config)", saveAt);
    const reloadAt = service.indexOf("const canonicalPreferences = loadPreferences", configSaveAt);
    const accountsAt = service.indexOf("canonicalPreferences.accounts = payload.preferences.accounts", reloadAt);
    const persistAt = service.indexOf("savePreferences(canonicalPreferences)", accountsAt);
    assert.ok(saveAt >= 0);
    assert.ok(configSaveAt > saveAt);
    assert.ok(reloadAt > configSaveAt);
    assert.ok(accountsAt > reloadAt);
    assert.ok(persistAt > accountsAt);
    assert.doesNotMatch(service.slice(configSaveAt, persistAt), /savePreferences\(payload\.preferences\)/);
  });

  it("audits migrated rollout creators read-only before binding a store", () => {
    const runtime = source("src/gui/account-store-runtime.ts");
    const discovery = source("src/gui/codex-task-discovery.ts");
    assert.match(runtime, /readRolloutCreatorAccountIds/);
    assert.match(runtime, /decideStoreMigration/);
    assert.match(runtime, /bindingState === "migration_review"/);
    assert.match(runtime, /store\.bindingState = "bound"/);
    assert.match(discovery, /export function readRolloutCreatorAccountIds/);
    assert.doesNotMatch(runtime, /writeFileSync|renameSync|unlinkSync|rmSync/);
  });

  it("gates immediate resume, rate limits, and scheduled resume through active-store verification", () => {
    const service = source("src/gui/service.ts");
    const scheduledResume = source("src/gui/scheduled-task-resume.ts");
    assert.match(service, /resumeTask[\s\S]*ensureActiveAccountStore\(accountId\)/);
    assert.match(service, /getAccountRateLimitStatus[\s\S]*ensureActiveAccountStore\(accountId\)/);
    assert.match(service, /scheduleTaskResume[\s\S]*ensureActiveAccountStore\(accountId\)/);
    assert.match(scheduledResume, /ensureActiveAccountStore\(schedule\.accountId\)/);
  });

  it("gates scheduled pings before invoking the account CODEX_HOME", () => {
    const runner = source("src/gui/scheduled-runner.ts");
    const gateAt = runner.indexOf("ensureActiveAccountStore(accountId)");
    const pingAt = runner.indexOf("reliablePing(account.agent");
    assert.ok(gateAt >= 0);
    assert.ok(pingAt > gateAt);
    assert.match(runner, /PING_ACCOUNT_STORE_REJECTED/);
  });

  it("does not expose raw provider ids through the public auth status type", () => {
    const types = source("src/gui/types.ts");
    const statusStart = types.indexOf("export interface AccountAuthStatus");
    const statusEnd = types.indexOf("export interface TaskResumeSchedule", statusStart);
    const statusBlock = types.slice(statusStart, statusEnd);
    assert.doesNotMatch(statusBlock, /providerAccountId/);
    assert.match(source("src/gui/account-auth.ts"), /account\/rateLimits\/read/);
    assert.match(source("src/gui/account-store-model.ts"), /createHash\("sha256"\)/);
  });
});
