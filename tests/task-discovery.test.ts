import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseRolloutInventoryText, parseTaskInventoryPage, parseTaskInventoryThread } from "../src/gui/codex-task-discovery.js";

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
    assert.equal(item.resumeEligibility, "same_profile_candidate");
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
    assert.equal(item.resumeEligibility, "same_profile_candidate");
    assert.equal("path" in item, false);
  });

  it("rejects rollout fallback rows without persisted creator identity", () => {
    const text = JSON.stringify({
      type: "session_meta",
      payload: {
        id: "01a0fc88-6926-7d61-8ca9-b71b7dd898e3",
        timestamp: "2026-10-02T12:13:11.000Z",
        cwd: "C:\\work",
        source: "exec",
      },
    });
    assert.equal(parseRolloutInventoryText(text, 123, accountTarget), null);
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
    assert.match(html, /Legacy \/ Global/);
    assert.match(renderer, /getTaskInventory\(\)/);
    assert.match(renderer, /Cross-account unavailable/);
    assert.match(preload, /automode:get-task-inventory/);
    assert.match(main, /automode:get-task-inventory/);
  });
});
