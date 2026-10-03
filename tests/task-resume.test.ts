import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { chooseSuggestedResetAt, decideResumeRecovery } from "../src/gui/codex-task-runtime.js";
import { resumeTaskName, TaskResumeScheduler } from "../src/gui/task-resume-scheduler.js";

describe("task resume recovery policy", () => {
  it("waits when the latest turn is already running", () => {
    assert.deepEqual(decideResumeRecovery([
      { id: "turn-1", status: "inProgress", items: [] },
    ]), { action: "wait", reason: "turn_running" });
  });

  it("continues after a completed turn", () => {
    assert.deepEqual(decideResumeRecovery([
      { id: "turn-1", status: "completed", items: [{ type: "agentMessage", id: "a" }] },
    ]), { action: "continue", reason: "last_turn_completed" });
  });

  it("continues an interrupted turn when agent progress exists", () => {
    assert.deepEqual(decideResumeRecovery([
      {
        id: "turn-2",
        status: "interrupted",
        items: [
          { type: "userMessage", id: "u", content: [{ type: "text", text: "do work", textElements: [] }] },
          { type: "commandExecution", id: "cmd" },
        ],
      },
    ]), { action: "continue", reason: "agent_progress_exists" });
  });

  it("reverts and replays original input when a failed turn has no agent progress", () => {
    const input = [{ type: "text", text: "original request", textElements: [] }];
    assert.deepEqual(decideResumeRecovery([
      { id: "turn-3", status: "failed", items: [{ type: "userMessage", id: "u", content: input }] },
    ]), {
      action: "replay",
      reason: "no_agent_progress_replay_original",
      replayInput: input,
      beforeTurnId: "turn-3",
    });
  });

  it("fails closed when replay is required for non-paginated history", () => {
    assert.deepEqual(decideResumeRecovery([
      { id: "turn-4", status: "failed", items: [{ type: "userMessage", id: "u", content: [{ type: "text", text: "x" }] }] },
    ], "legacy"), {
      action: "abort",
      reason: "replay_requires_paginated_history",
    });
  });
});

describe("task reset scheduling policy", () => {
  const nowMs = 1_000_000;

  it("waits for the latest blocked window when multiple limits are exhausted", () => {
    assert.equal(chooseSuggestedResetAt(false, 100, 2000, 100, 3000, nowMs), 3000);
  });

  it("uses the conservative latest reset when usage is blocked without an exact 100 percent window", () => {
    assert.equal(chooseSuggestedResetAt(false, 99, 2000, 87, 3000, nowMs), 3000);
  });

  it("uses the next reset when usage is currently allowed", () => {
    assert.equal(chooseSuggestedResetAt(true, 2, 2000, 87, 3000, nowMs), 2000);
  });
});

describe("one-shot task resume scheduler", () => {
  it("routes the exact schedule id and removes stale receipts", () => {
    const calls: Array<{ operation: string; id: string }> = [];
    const scheduler = new TaskResumeScheduler("C:\\PingGPT\\PingGPT.exe", (operation, task) => {
      calls.push({ operation, id: task.id });
      return { ok: true, output: "ok" };
    }, join(process.cwd(), ".tmp-task-resume-test.json"));

    const schedule = {
      id: "resume-abc",
      accountId: "profile-a",
      storeId: "store-profile-a",
      threadId: "01a00000-0000-7000-8000-000000000001",
      title: "Task",
      runAt: new Date(Date.now() + 60_000).toISOString(),
      expectedUpdatedAt: 123,
      wakePc: true,
      enabled: true,
      createdAt: new Date().toISOString(),
      completedAt: null,
      lastStatus: null,
    };

    scheduler.sync([schedule]);
    scheduler.sync([]);
    assert.deepEqual(calls.map((entry) => entry.operation), ["register", "delete"]);
    assert.equal(resumeTaskName(schedule.id), "PingGPT Task Resume resume-abc");

    rmSync(join(process.cwd(), ".tmp-task-resume-test.json"), { force: true });
  });
});

describe("task resume wiring safety", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("keeps legacy/global rows non-resumable in the renderer", () => {
    const renderer = source("src/gui/renderer/app.js");
    assert.match(renderer, /Cross-account unavailable/);
    assert.match(renderer, /resumeEligibility === ['"]same_profile_candidate['"]/);
    assert.match(renderer, /getAccountRateLimitStatus/);
    assert.match(renderer, /scheduleTaskResume/);
  });

  it("never auto-approves background command or file-change approval requests", () => {
    const runtime = source("src/gui/codex-task-runtime.ts");
    assert.match(runtime, /item\/commandExecution\/requestApproval/);
    assert.match(runtime, /item\/fileChange\/requestApproval/);
    assert.match(runtime, /decision: "decline"/);
    assert.doesNotMatch(runtime, /decision: "accept"/i);
  });

  it("verifies persisted creator identity before any resume input", () => {
    const runtime = source("src/gui/codex-task-runtime.ts");
    assert.match(runtime, /account\/rateLimits\/read/);
    assert.match(runtime, /creator_account_id/);
    assert.match(runtime, /verifyTaskAccountOwnership\(before, account\.codexHome, currentAccountId\)/);
    assert.match(runtime, /Task creator account does not match/);
    assert.match(runtime, /Task rollout is outside the selected account store/);
  });

  it("prunes resume schedules that no longer have an enabled Codex account", () => {
    const service = source("src/gui/service.ts");
    assert.match(service, /resumableAccounts/);
    assert.match(service, /canonicalPreferences\.taskResumeSchedules = canonicalPreferences\.taskResumeSchedules/);
    assert.match(service, /filter\(\(schedule\) => resumableAccounts\.has\(schedule\.accountId\)\)/);
  });

  it("hydrates only an empty paginated projection before deciding recovery", () => {
    const runtime = source("src/gui/codex-task-runtime.ts");
    const ownershipAt = runtime.indexOf("verifyTaskAccountOwnership(before, account.codexHome, currentAccountId)");
    const staleCheckAt = runtime.indexOf("expectedUpdatedAt !== null && actualUpdatedAt !== expectedUpdatedAt");
    const hydrateGuardAt = runtime.indexOf('inspectionTurns.length === 0 && historyMode === "paginated"');
    const hydrateResumeAt = runtime.indexOf("await resumeThread(session, threadId)", hydrateGuardAt);
    const decisionAt = runtime.indexOf("const decision = decideResumeRecovery", hydrateGuardAt);
    assert.ok(ownershipAt >= 0);
    assert.ok(staleCheckAt > ownershipAt);
    assert.ok(hydrateGuardAt > staleCheckAt);
    assert.ok(hydrateResumeAt > hydrateGuardAt);
    assert.ok(decisionAt > hydrateResumeAt);
    assert.match(runtime, /if \(!alreadyResumed\)\s*\{\s*await resumeThread\(session, threadId\)/);
  });

  it("uses the existing safe wake-return pattern for scheduled task resumes", () => {
    const runner = source("src/gui/scheduled-task-resume.ts");
    const main = source("src/gui/main.ts");
    assert.match(runner, /recentlyResumedFromSuspend/);
    assert.match(runner, /activeExecutionLockCount/);
    assert.match(runner, /idleGrowth \+ IDLE_TOLERANCE_SECONDS < elapsedSeconds/);
    assert.match(main, /requestSleep: \(\) => requestWindowsSleep\(\)/);
    assert.match(main, /getSystemIdleTime: \(\) => powerMonitor\.getSystemIdleTime\(\)/);
  });

  it("streams long-running app-server output without a cumulative byte kill switch", () => {
    const runtime = source("src/gui/codex-task-runtime.ts");
    assert.doesNotMatch(runtime, /MAX_CAPTURE|captured:\s*number|session\.captured/);
    assert.match(runtime, /MAX_RPC_LINE_BUFFER/);
    assert.match(runtime, /message\.method === "turn\/completed"/);
  });

  it("uses official resume, turns-list, revert, and turn-start APIs", () => {
    const runtime = source("src/gui/codex-task-runtime.ts");
    assert.match(runtime, /"thread\/resume"/);
    assert.match(runtime, /"thread\/turns\/list"/);
    assert.match(runtime, /"thread\/revert"/);
    assert.match(runtime, /"turn\/start"/);
    assert.doesNotMatch(runtime, /thread\/rollback/);
  });
});
