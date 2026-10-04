import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { classifyTaskOwnership, parseRolloutInventoryText, parseTaskInventoryPage, parseTaskInventoryThread } from "../src/gui/codex-task-discovery.js";

describe("Codex task inventory parsing", () => {
  const accountTarget = {
    source: "account" as const,
    accountId: "profile-a",
    accountLabel: "Main",
  };
  const legacyTarget = {
    source: "legacy_global" as const,
    accountId: null,
    accountLabel: "Legacy / Global",
  };

  it("maps account-store threads to the owning PingGPT profile", () => {
    const item = parseTaskInventoryThread({
      id: "01a00000-0000-7000-8000-000000000001",
      name: "Named task",
      preview: "first user message",
      cwd: "C:\\work",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      createdAt: 100,
      updatedAt: 200,
      recencyAt: 250,
      status: "notLoaded",
      historyMode: "paginated",
      source: "vscode",
      originator: "codex_work_desktop",
      path: "C:\\secret\\rollout.jsonl",
    }, accountTarget);

    assert.ok(item);
    assert.equal(item.accountId, "profile-a");
    assert.equal(item.accountLabel, "Main");
    assert.equal(item.title, "Named task");
    assert.equal(item.ownershipStatus, "unverified");
    assert.equal(item.resumeEligibility, "ownership_unverified");
    assert.equal("path" in item, false);
  });

  it("keeps legacy global threads explicitly unassigned", () => {
    const page = parseTaskInventoryPage({
      data: [{
        id: "01a00000-0000-7000-8000-000000000002",
        preview: "legacy task",
        createdAt: 100,
        updatedAt: 120,
        status: { active: { activeFlags: [] } },
        historyMode: "paginated",
        source: "vscode",
      }],
      nextCursor: "next-page",
    }, legacyTarget);

    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.source, "legacy_global");
    assert.equal(page.items[0]?.accountId, null);
    assert.equal(page.items[0]?.ownershipStatus, "legacy");
    assert.equal(page.items[0]?.resumeEligibility, "legacy_unassigned");
    assert.equal(page.nextCursor, "next-page");
  });

  it("rejects malformed rows instead of inventing task ids", () => {
    assert.equal(parseTaskInventoryThread({ preview: "missing id" }, accountTarget), null);
    assert.equal(parseTaskInventoryThread(null, accountTarget), null);
  });

  it("discovers an unindexed isolated exec rollout without provider-store mutation", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-10-02T12:13:11.000Z",
        type: "session_meta",
        payload: {
          creator_account_id: "acct-test",
          id: "01a0fc88-6926-7d61-8ca9-b71b7dd898e3",
          timestamp: "2026-10-02T12:13:11.000Z",
          cwd: "C:\\work",
          originator: "codex_exec",
          cli_version: "0.157.1",
          source: "exec",
          model_provider: "openai",
          history_mode: "paginated",
        },
      }),
      JSON.stringify({
        timestamp: "2026-10-02T12:13:12.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "[PINGGPT_RESUME_TEST_20261002-211311] disposable verification",
        },
      }),
      JSON.stringify({
        timestamp: "2026-10-02T12:13:12.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      }),
    ].join("\n");

    const item = parseRolloutInventoryText(text, 1_759_407_192.987, accountTarget);
    assert.ok(item);
    assert.equal(item.id, "01a0fc88-6926-7d61-8ca9-b71b7dd898e3");
    assert.equal(item.sessionSource, "exec");
    assert.equal(item.model, "gpt-5.6-sol");
    assert.equal(item.updatedAt, 1_759_407_192);
    assert.equal(item.recencyAt, 1_759_407_192);
    assert.match(item.title, /PINGGPT_RESUME_TEST/);
    assert.equal(item.ownershipStatus, "unverified");
    assert.equal(item.resumeEligibility, "ownership_unverified");
    assert.equal("path" in item, false);
  });

  it("keeps rollout rows without creator identity visible but non-resumable", () => {
    const text = JSON.stringify({
      type: "session_meta",
      payload: {
        id: "01a0fc88-6926-7d61-8ca9-b71b7dd898e3",
        timestamp: "2026-10-02T12:13:11.000Z",
        cwd: "C:\\work",
        source: "exec",
      },
    });
    const item = parseRolloutInventoryText(text, 123, accountTarget);
    assert.ok(item);
    assert.equal(item.ownershipStatus, "unverified");
    assert.equal(item.resumeEligibility, "ownership_unverified");
  });

  it("classifies creator ownership without returning provider account ids", () => {
    const item = parseTaskInventoryThread({
      id: "01a00000-0000-7000-8000-000000000003",
      preview: "ownership test",
      source: "exec",
    }, accountTarget);
    assert.ok(item);

    const matched = classifyTaskOwnership(item, "provider-a", {
      providerAccountId: "provider-a",
      connectedEmail: "main@example.com",
      planType: "plus",
      identityVerified: true,
    });
    assert.equal(matched.ownershipStatus, "matched");
    assert.equal(matched.resumeEligibility, "same_profile_candidate");
    assert.equal("providerAccountId" in matched, false);

    const mismatch = classifyTaskOwnership(item, "provider-a", {
      providerAccountId: "provider-b",
      connectedEmail: "other@example.com",
      planType: "plus",
      identityVerified: true,
    });
    assert.equal(mismatch.ownershipStatus, "mismatch");
    assert.equal(mismatch.resumeEligibility, "account_mismatch");

    const unverified = classifyTaskOwnership(item, null, {
      providerAccountId: "provider-a",
      connectedEmail: "main@example.com",
      planType: "plus",
      identityVerified: true,
    });
    assert.equal(unverified.ownershipStatus, "unverified");
    assert.equal(unverified.resumeEligibility, "ownership_unverified");
  });
});

describe("task discovery safety boundary", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("keeps discovery read-only while covering indexed and unindexed account tasks", () => {
    const discovery = source("src/gui/codex-task-discovery.ts");
    assert.match(discovery, /["']thread\/list["']/);
    assert.match(discovery, /useStateDbOnly:\s*true/);
    assert.match(discovery, /sourceKinds:\s*target\.source === "account"/);
    assert.match(discovery, /"exec", "appServer"/);
    assert.match(discovery, /join\(codexHome, "sessions"\)/);
    assert.match(discovery, /parseRolloutInventoryText/);
    assert.match(discovery, /["']account\/read["']/);
    assert.match(discovery, /["']account\/rateLimits\/read["']/);
    assert.match(discovery, /creator_account_id/);
    assert.match(discovery, /classifyTaskOwnership/);
    assert.doesNotMatch(discovery, /useStateDbOnly:\s*false/);
    assert.doesNotMatch(discovery, /["']thread\/(?:start|resume|fork|delete|archive|unarchive|rollback)["']/);
    assert.doesNotMatch(discovery, /["']turn\/(?:start|steer|interrupt)["']/);
    assert.match(discovery, /delete env\.OPENAI_API_KEY/);
    assert.match(discovery, /delete env\.CODEX_API_KEY/);
    assert.match(discovery, /delete env\.CODEX_ACCESS_TOKEN/);
  });

  it("wires a dedicated Tasks page through sandboxed IPC", () => {
    const html = source("src/gui/renderer/index.html");
    const renderer = source("src/gui/renderer/app.js");
    const preload = source("src/gui/preload.cts");
    const main = source("src/gui/main.ts");

    assert.match(html, /data-page="tasks"/);
    assert.match(html, /id="codex-task-list"/);
    assert.doesNotMatch(html, /Legacy \/ Global|legacy global Codex store/i);
    assert.match(html, /active verified ChatGPT account store/);
    assert.match(renderer, /getTaskInventory\(\)/);
    assert.match(preload, /automode:get-task-inventory/);
    assert.match(main, /automode:get-task-inventory/);
  });

  it("keeps task account tabs as a view filter instead of an execution authority", () => {
    const html = source("src/gui/renderer/index.html");
    const renderer = source("src/gui/renderer/app.js");
    const styles = source("src/gui/renderer/styles.css");

    assert.match(html, /id="task-account-tabs"/);
    assert.match(html, /id="task-search"/);
    assert.match(renderer, /taskAccountFilter/);
    assert.match(renderer, /addTab\('all', 'All'/);
    assert.doesNotMatch(renderer, /addTab\('legacy', 'Legacy'/);
    assert.doesNotMatch(renderer, /legacyCount|legacy task/);
    assert.match(renderer, /window\.automode\.resumeTask\(item\.accountId, item\.id, item\.updatedAt\)/);
    assert.match(renderer, /window\.automode\.scheduleTaskResume\(\s*item\.accountId,/);
    assert.doesNotMatch(renderer, /resumeTask\(taskAccountFilter/);
    assert.doesNotMatch(renderer, /scheduleTaskResume\(\s*taskAccountFilter/);
    assert.match(styles, /header \{ position:sticky; top:0;/);
    assert.match(styles, /aside \{ position:fixed;/);
    assert.match(styles, /\.task-account-tabs\{/);
  });

  it("uses local profile names for top tabs and adds Automation account filtering", () => {
    const html = source("src/gui/renderer/index.html");
    const renderer = source("src/gui/renderer/app.js");
    const styles = source("src/gui/renderer/styles.css");

    assert.match(html, /id="automation-account-tabs"/);
    assert.match(renderer, /automationAccountFilter/);
    assert.match(renderer, /automationProfileName/);
    assert.match(renderer, /label: account\.displayName \|\| account\.id/);
    assert.match(renderer, /label: item\.accountLabel \|\| item\.accountId/);
    assert.match(renderer, /account-filter-hidden/);
    assert.match(styles, /\.account-filter-hidden\{display:none!important\}/);
    assert.doesNotMatch(renderer, /label:\s*\(account\.displayName \|\| account\.id\) \+ ' · ' \+ connected/);
  });

  it("refreshes task ownership after a verified account-store activation and keeps manual refresh fresh", () => {
    const renderer = source("src/gui/renderer/app.js");
    const discovery = source("src/gui/codex-task-discovery.ts");

    const pollAt = renderer.indexOf("async function pollAccountStoreAuth");
    const storeStatusAt = renderer.indexOf("getAccountStoreAuthStatus(profileId, storeId)", pollAt);
    const activateFnAt = renderer.indexOf("async function activateVerifiedStore");
    const activateAt = renderer.indexOf("activateAccountStore(profileId, storeId)", activateFnAt);
    const refreshAt = renderer.indexOf('refreshTasks({ source: "account-switch", quiet: true })', activateAt);
    assert.ok(pollAt >= 0);
    assert.ok(storeStatusAt > pollAt);
    assert.ok(activateFnAt >= 0);
    assert.ok(activateAt > activateFnAt);
    assert.ok(refreshAt > activateAt);
    assert.match(renderer, /\$\("refresh-tasks"\)\.onclick = \(\) => refreshTasks\(\{ source: "manual" \}\)/);
    assert.match(renderer, /window\.automode\.getTaskInventory\(\)/);

    const listAt = discovery.indexOf("async function listSource");
    const identityAt = discovery.indexOf("const identity = await readSourceIdentity", listAt);
    const noDbReturnAt = discovery.indexOf("if (!stateDbExists) return { items: [], identity };", listAt);
    assert.ok(listAt >= 0);
    assert.ok(identityAt > listAt);
    assert.ok(noDbReturnAt > identityAt);
  });

  it("builds one frozen R1.06 DeliveryBundle from the exact runtime patch", () => {
    const workflow = source(".github/workflows/pinggpt-task-resume-package.yml");
    const applyTemplate = source("scripts/pinggpt-runtime-patch-apply.template.ps1");

    assert.match(workflow, /Working_ZIP_PingGPT_261003_AccountTabsRefresh_R1\.06_RuntimePatch\.zip/);
    assert.match(workflow, /Working_ZIP_PingGPT_261003_AccountTabsRefresh_R1\.06_DeliveryBundle\.zip/);
    assert.match(workflow, /PingGPT_R1\.06_DeliveryReceipt\.txt/);
    assert.match(workflow, /powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass/);
    assert.match(workflow, /POWERSHELL51_PARSE=PASS/);
    assert.match(workflow, /REEXTRACT_VERIFY=PASS/);
    assert.match(workflow, /FROZEN_AFTER_VERIFY=YES/);
    assert.match(workflow, /pinggpt-r106-delivery-bundle/);

    assert.match(applyTemplate, /\$PatchZip = Join-Path \$PSScriptRoot \$PatchFileName/);
    assert.match(applyTemplate, /Runtime ZIP SHA256 mismatch/);
    assert.match(applyTemplate, /Patch commit mismatch/);
    assert.doesNotMatch(applyTemplate, /Downloads/);
  });

  it("sorts and filters task inventory locally without reclassifying ownership", () => {
    const renderer = source("src/gui/renderer/app.js");
    const visibleAt = renderer.indexOf("const userVisibleItems = data.items.filter((item) => item.source === 'account')");
    const searchAt = renderer.indexOf(".filter(taskMatchesSearch)", visibleAt);
    const renderAt = renderer.indexOf("filteredItems.forEach((item)", searchAt);
    assert.ok(visibleAt >= 0);
    assert.ok(searchAt > visibleAt);
    assert.ok(renderAt > searchAt);
    assert.match(renderer, /\.filter\(taskMatchesFilter\)/);
    assert.match(renderer, /\.filter\(taskMatchesSearch\)/);
    assert.match(renderer, /\.sort\(\(a, b\) => taskTimestamp\(b\) - taskTimestamp\(a\)\)/);
    assert.match(renderer, /if \(item\.source !== 'account'\) return false;/);
    assert.match(renderer, /item\.accountId === taskAccountFilter/);
    assert.match(renderer, /SCHEDULED/);
    assert.match(renderer, /RUNNING/);
    assert.match(renderer, /READY/);
    assert.match(renderer, /PROFILE TASK/);
    assert.match(renderer, /ACCOUNT MISMATCH/);
    assert.match(renderer, /OWNERSHIP UNVERIFIED/);
    assert.match(renderer, /Reconnect matching account/);
    assert.match(renderer, /Connected:/);
  });

  it("hides Legacy inventory from normal Tasks tabs, All, search, summary, and rows", () => {
    const html = source("src/gui/renderer/index.html");
    const renderer = source("src/gui/renderer/app.js");
    const discovery = source("src/gui/codex-task-discovery.ts");

    assert.doesNotMatch(html, /Legacy \/ Global|legacy global Codex store/i);
    assert.doesNotMatch(renderer, /addTab\('legacy'|legacyCount|legacy task|LEGACY \/ GLOBAL/);
    assert.match(renderer, /total: \(data\.items \|\| \[\]\)\.filter\(\(item\) => item\.source === 'account'\)\.length/);
    assert.match(renderer, /const userVisibleItems = data\.items\.filter\(\(item\) => item\.source === 'account'\)/);
    assert.match(renderer, /const userVisibleErrors = data\.errors\.filter\(\(entry\) => entry\.source === 'account'\)/);
    assert.match(renderer, /function taskMatchesSearch\(item\) \{\s*if \(item\.source !== 'account'\) return false;/);
    assert.match(renderer, /ownership\.textContent = 'PROFILE TASK'/);

    // Backend discovery and read-only Legacy evidence remain intact.
    assert.match(discovery, /source: "legacy_global"/);
    assert.match(discovery, /classifyTaskOwnership/);
    assert.match(discovery, /readRolloutCreatorAccountIds/);
    assert.match(discovery, /useStateDbOnly:\s*true/);
  });
});
