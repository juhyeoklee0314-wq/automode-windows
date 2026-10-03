import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("R1.07 account switch transaction", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("verifies the selected store before committing activeStoreId", () => {
    const service = source("src/gui/service.ts");
    const methodAt = service.indexOf("async activateAccountStore");
    const verifyAt = service.indexOf("await verifyAccountStore(profileId, storeId)", methodAt);
    const commitAt = service.indexOf("profile.activeStoreId = storeId", methodAt);
    const saveAt = service.indexOf("saveCanonicalPreferences(preferences)", commitAt);
    assert.ok(methodAt >= 0);
    assert.ok(verifyAt > methodAt);
    assert.ok(commitAt > verifyAt);
    assert.ok(saveAt > commitAt);
  });

  it("creates a pending store without changing the profile active binding", () => {
    const service = source("src/gui/service.ts");
    const start = service.indexOf("createAccountStore(profileId");
    const end = service.indexOf("async getAccountStoreAuthStatus", start);
    const block = service.slice(start, end);
    assert.match(block, /bindingState: "pending"/);
    assert.match(block, /saveCanonicalPreferences\(preferences\)/);
    assert.doesNotMatch(block, /profile\.activeStoreId\s*=/);
  });

  it("rejects duplicate account identity instead of binding another store", () => {
    const runtime = source("src/gui/account-store-runtime.ts");
    const duplicateAt = runtime.indexOf("const duplicate = preferences.accountStores.find");
    const bindAt = runtime.indexOf('store.bindingState = "bound"', duplicateAt);
    assert.ok(duplicateAt >= 0);
    assert.ok(bindAt > duplicateAt);
    assert.match(runtime.slice(duplicateAt, bindAt), /account_already_stored/);
  });

  it("reloads canonical store bindings before syncing one-shot resumes after Save", () => {
    const service = source("src/gui/service.ts");
    const saveAt = service.indexOf("save(payload: SavePayload)");
    const persistAt = service.indexOf("savePreferences(payload.preferences)", saveAt);
    const reloadAt = service.indexOf("const savedPreferences = loadPreferences", persistAt);
    const syncAt = service.indexOf("activeTaskResumeSchedules(savedPreferences)", reloadAt);
    assert.ok(saveAt >= 0);
    assert.ok(persistAt > saveAt);
    assert.ok(reloadAt > persistAt);
    assert.ok(syncAt > reloadAt);
  });

  it("restores the previous active binding when scheduler reconciliation fails", () => {
    const service = source("src/gui/service.ts");
    const methodAt = service.indexOf("async activateAccountStore");
    const previousAt = service.indexOf("const previousActiveStoreId", methodAt);
    const commitAt = service.indexOf("profile.activeStoreId = storeId", previousAt);
    const catchAt = service.indexOf("} catch (error) {", commitAt);
    const rollbackAt = service.indexOf("rollbackProfile.activeStoreId = previousActiveStoreId", catchAt);
    const restoreSchedulesAt = service.indexOf("rollback.taskResumeSchedules = previousTaskResumeSchedules", rollbackAt);
    assert.ok(previousAt > methodAt);
    assert.ok(commitAt > previousAt);
    assert.ok(catchAt > commitAt);
    assert.ok(rollbackAt > catchAt);
    assert.ok(restoreSchedulesAt > rollbackAt);
    assert.match(service.slice(catchAt), /ACCOUNT_STORE_ACTIVATION_ROLLED_BACK/);
  });

  it("does not install Codex ping tasks for a profile without a runnable account store", () => {
    const scheduler = source("src/gui/scheduler.ts");
    assert.match(scheduler, /Boolean\(entry\.codexHome\)/);
    assert.match(scheduler, /entry\.storeBindingState !== "pending"/);
    assert.match(scheduler, /entry\.storeBindingState !== "migration_review"/);
  });

  it("binds each Windows scheduled ping to the exact account store and rejects stale tasks", () => {
    const scheduler = source("src/gui/scheduler.ts");
    const runner = source("src/gui/scheduled-runner.ts");
    const routing = source("src/gui/routing.ts");
    assert.match(scheduler, /"--scheduled-runner", accountId, storeId \?\? "-", scheduleId/);
    const staleAt = runner.indexOf("PING_ACCOUNT_STORE_STALE_TASK_REJECTED");
    const verifyAt = runner.indexOf("ensureActiveAccountStore(accountId)", staleAt);
    const pingAt = runner.indexOf("reliablePing(account.agent", staleAt);
    assert.ok(staleAt >= 0);
    assert.ok(verifyAt > staleAt);
    assert.ok(pingAt > verifyAt);
    assert.match(routing, /storeId: null, scheduleId: second/);
    assert.match(routing, /storeId: second \|\| null, scheduleId: third/);
  });

  it("pauses inactive one-shot resumes and refuses stale-store execution", () => {
    const preferences = source("src/gui/preferences.ts");
    const main = source("src/gui/main.ts");
    const runner = source("src/gui/scheduled-task-resume.ts");
    assert.match(preferences, /activeTaskResumeSchedules/);
    assert.match(main, /taskResumeScheduler\.sync\(activeTaskResumeSchedules\(preferences\)\)/);
    assert.match(runner, /account\.storeId !== schedule\.storeId/);
    const mismatchAt = runner.indexOf("account.storeId !== schedule.storeId");
    const resumeAt = runner.indexOf("resumeCodexTask(account", mismatchAt);
    assert.ok(mismatchAt >= 0);
    assert.ok(resumeAt > mismatchAt);
  });

  it("keeps inactive stores out of the ordinary profile surface", () => {
    const renderer = source("src/gui/renderer/app.js");
    const renderAccountsAt = renderer.indexOf("function renderAccounts");
    const managerAt = renderer.indexOf("async function renderAccountStoreManager");
    assert.ok(renderAccountsAt >= 0);
    assert.ok(managerAt > renderAccountsAt);
    assert.doesNotMatch(renderer.slice(renderAccountsAt, managerAt), /getAccountStores/);
    assert.match(renderer.slice(managerAt), /getAccountStores\(profileId\)/);
    assert.match(renderer, /Only the current account is shown outside this panel/);
  });
});
