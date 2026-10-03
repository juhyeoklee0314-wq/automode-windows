import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("R1.07 active-store runtime gates", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

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
