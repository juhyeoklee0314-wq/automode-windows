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
