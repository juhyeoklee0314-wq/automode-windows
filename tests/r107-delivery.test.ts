import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("R1.07 delivery and rollback contract", () => {
  it("packages only the R1.07 account-store branch with a new artifact identity", () => {
    const workflow = source(".github/workflows/pinggpt-account-store-package.yml");
    assert.match(workflow, /pinggpt-account-store-r107-001/);
    assert.match(workflow, /R1\.07/);
    assert.match(workflow, /Working_ZIP_PingGPT_261003_AccountStore_R1\.07_RuntimePatch\.zip/);
    assert.match(workflow, /Working_ZIP_PingGPT_261003_AccountStore_R1\.07_DeliveryBundle\.zip/);
    assert.doesNotMatch(workflow, /AccountTabsRefresh_R1\.06/);
  });

  it("requires Windows PowerShell 5.1 parsing for both apply and rollback scripts", () => {
    const workflow = source(".github/workflows/pinggpt-account-store-package.yml");
    assert.match(workflow, /powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass/);
    assert.match(workflow, /POWERSHELL51_APPLY_PARSE=PASS/);
    assert.match(workflow, /POWERSHELL51_ROLLBACK_PARSE=PASS/);
  });

  it("backs up schema-sensitive preferences, config, receipts, and PingGPT-owned Windows tasks before code mutation", () => {
    const apply = source("scripts/pinggpt-r107-runtime-patch-apply.template.ps1");
    const backupAt = apply.indexOf("Backup-StateFile 'PREFERENCES'");
    const schedulerAt = apply.indexOf("\n        Backup-ScheduledTasks", backupAt);
    const mutationAt = apply.indexOf("$MutationStarted = $true");
    assert.ok(backupAt >= 0);
    assert.ok(schedulerAt > backupAt);
    assert.ok(mutationAt > schedulerAt);
    assert.match(apply, /gui-preferences\.json/);
    assert.match(apply, /config\.toml/);
    assert.match(apply, /gui-schedule\.json/);
    assert.match(apply, /task-resume-schedule\.json/);
    assert.match(apply, /Automode GUI Ping \*/);
    assert.match(apply, /PingGPT Task Resume \*/);
  });

  it("restores prior settings and scheduled tasks while leaving new account-store directories untouched", () => {
    const rollback = source("scripts/pinggpt-r107-rollback.template.ps1");
    assert.match(rollback, /Restore-State/);
    assert.match(rollback, /Restore-ScheduledTasks/);
    assert.match(rollback, /Remove-Item -LiteralPath \$target -Force/);
    assert.match(rollback, /NEW_CODEX_STORES\s+: LEFT UNTOUCHED/);
    assert.doesNotMatch(rollback, /codex-profiles.*Remove-Item|Remove-Item.*codex-profiles/i);
  });

  it("snapshots the current R1.07 state before manual rollback overwrites it", () => {
    const rollback = source("scripts/pinggpt-r107-rollback.template.ps1");
    const snapshotAt = rollback.indexOf("$PreRollback = Snapshot-CurrentState");
    const restoreAt = rollback.indexOf("Restore-State", snapshotAt);
    assert.ok(snapshotAt >= 0);
    assert.ok(restoreAt > snapshotAt);
  });
});