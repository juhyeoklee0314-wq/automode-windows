import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  legacyAccountStoreId,
  migrateV1AccountProfiles,
  projectActiveAccountProfiles,
  providerIdentityKey,
} from "../src/gui/account-store-model.js";

describe("R1.07 account-store model", () => {
  it("migrates a Codex v1 profile into a profile plus migration-pending store without moving CODEX_HOME", () => {
    const v1 = [{
      id: "default",
      displayName: "Main",
      enabled: true,
      codexHome: "C:\\PingGPT\\codex-profiles\\default",
      message: "hi",
      schedules: ["06:00", "17:00"],
      agent: "codex" as const,
      catchupMinutes: 30,
      wakePc: true,
    }];

    const migrated = migrateV1AccountProfiles(v1);
    assert.equal(migrated.profiles.length, 1);
    assert.equal(migrated.accountStores.length, 1);

    const profile = migrated.profiles[0]!;
    const store = migrated.accountStores[0]!;
    assert.equal(profile.id, "default");
    assert.equal(profile.activeStoreId, legacyAccountStoreId("default"));
    assert.equal(store.profileId, "default");
    assert.equal(store.codexHome, v1[0]!.codexHome);
    assert.equal(store.bindingState, "migration_pending");
    assert.equal(store.identityKey, null);
    assert.deepEqual(store.automation.schedules, ["06:00", "17:00"]);
  });

  it("does not invent an account store for a Claude-only v1 profile", () => {
    const migrated = migrateV1AccountProfiles([{
      id: "claude",
      displayName: "Claude",
      enabled: true,
      message: "hi",
      schedules: ["09:00"],
      agent: "claude" as const,
      catchupMinutes: 10,
      wakePc: false,
    }]);
    assert.equal(migrated.profiles[0]?.activeStoreId, null);
    assert.equal(migrated.accountStores.length, 0);
  });

  it("projects only the active store into the existing runtime account view", () => {
    const migrated = migrateV1AccountProfiles([{
      id: "main",
      displayName: "Main",
      enabled: true,
      codexHome: "C:\\A",
      message: "A-message",
      schedules: ["06:00"],
      agent: "codex" as const,
      catchupMinutes: 30,
      wakePc: true,
    }]);
    const profile = migrated.profiles[0]!;
    migrated.accountStores.push({
      id: "store-main-b",
      profileId: "main",
      codexHome: "C:\\B",
      identityKey: "b",
      bindingState: "bound",
      automation: {
        message: "B-message",
        schedules: ["10:00"],
        catchupMinutes: 20,
        wakePc: false,
      },
    });
    profile.activeStoreId = "store-main-b";

    const projected = projectActiveAccountProfiles(migrated.profiles, migrated.accountStores);
    assert.equal(projected.length, 1);
    assert.equal(projected[0]?.id, "main");
    assert.equal(projected[0]?.codexHome, "C:\\B");
    assert.equal(projected[0]?.message, "B-message");
    assert.deepEqual(projected[0]?.schedules, ["10:00"]);
  });

  it("stores only a deterministic pseudonymous key for provider identity comparison", () => {
    const raw = "provider-account-secret-looking-id";
    const first = providerIdentityKey(raw);
    const second = providerIdentityKey(raw);
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.notEqual(first, raw);
  });
});
