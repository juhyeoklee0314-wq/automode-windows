import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { providerIdentityKey } from "../src/gui/account-store-model.js";
import {
  decideStoreActivation,
  decideStoreMigration,
} from "../src/gui/account-store-verification.js";

describe("R1.07 store migration verification", () => {
  it("binds a migrated store when every known task creator matches the current provider account", () => {
    const result = decideStoreMigration({
      providerAccountId: "account-a",
      creatorAccountIds: ["account-a", null, "account-a"],
    });
    assert.deepEqual(result, {
      state: "bindable",
      identityKey: providerIdentityKey("account-a"),
      reason: "ownership_consistent",
    });
  });

  it("allows an empty store to bind to its verified current provider identity", () => {
    assert.equal(decideStoreMigration({
      providerAccountId: "account-a",
      creatorAccountIds: [],
    }).state, "bindable");
  });

  it("requires migration review when any known creator belongs to another account", () => {
    const result = decideStoreMigration({
      providerAccountId: "account-b",
      creatorAccountIds: ["account-a", null],
    });
    assert.equal(result.state, "migration_review");
    assert.equal(result.reason, "creator_account_mismatch");
  });

  it("does not guess store ownership when provider identity cannot be verified", () => {
    assert.deepEqual(decideStoreMigration({
      providerAccountId: null,
      creatorAccountIds: ["account-a"],
    }), {
      state: "account_unverified",
      identityKey: null,
      reason: "provider_identity_unavailable",
    });
  });
});

describe("R1.07 account switch commit gate", () => {
  it("commits an existing store only when the actual provider identity matches its binding", () => {
    const key = providerIdentityKey("account-b");
    assert.deepEqual(decideStoreActivation({
      selectedStoreIdentityKey: key,
      actualProviderAccountId: "account-b",
      isNewStore: false,
    }), {
      action: "commit",
      identityKey: key,
      reason: "identity_verified",
    });
  });

  it("rejects an existing store when the user logs into another account", () => {
    const result = decideStoreActivation({
      selectedStoreIdentityKey: providerIdentityKey("account-b"),
      actualProviderAccountId: "account-c",
      isNewStore: false,
    });
    assert.equal(result.action, "reject");
    assert.equal(result.reason, "account_mismatch");
  });

  it("accepts the first verified identity for a new pending store", () => {
    const result = decideStoreActivation({
      selectedStoreIdentityKey: null,
      actualProviderAccountId: "account-new",
      isNewStore: true,
    });
    assert.equal(result.action, "commit");
    assert.equal(result.identityKey, providerIdentityKey("account-new"));
  });

  it("never commits a store when provider identity is unavailable", () => {
    assert.deepEqual(decideStoreActivation({
      selectedStoreIdentityKey: null,
      actualProviderAccountId: null,
      isNewStore: true,
    }), {
      action: "reject",
      identityKey: null,
      reason: "identity_unverified",
    });
  });
});
