import { providerIdentityKey } from "./account-store-model.js";

export interface StoreMigrationEvidence {
  providerAccountId: string | null;
  creatorAccountIds: Array<string | null>;
}

export type StoreMigrationDecision =
  | { state: "account_unverified"; identityKey: null; reason: "provider_identity_unavailable" }
  | { state: "migration_review"; identityKey: string; reason: "creator_account_mismatch" }
  | { state: "bindable"; identityKey: string; reason: "ownership_consistent" };

export function decideStoreMigration(evidence: StoreMigrationEvidence): StoreMigrationDecision {
  const provider = evidence.providerAccountId?.trim() || null;
  if (!provider) {
    return {
      state: "account_unverified",
      identityKey: null,
      reason: "provider_identity_unavailable",
    };
  }

  const identityKey = providerIdentityKey(provider);
  const knownCreators = evidence.creatorAccountIds
    .map((value) => value?.trim() || null)
    .filter((value): value is string => value !== null);

  if (knownCreators.some((creator) => creator !== provider)) {
    return {
      state: "migration_review",
      identityKey,
      reason: "creator_account_mismatch",
    };
  }

  return {
    state: "bindable",
    identityKey,
    reason: "ownership_consistent",
  };
}

export interface StoreActivationEvidence {
  selectedStoreIdentityKey: string | null;
  actualProviderAccountId: string | null;
  isNewStore: boolean;
}

export type StoreActivationDecision =
  | { action: "commit"; identityKey: string; reason: "identity_verified" }
  | { action: "reject"; identityKey: string | null; reason: "identity_unverified" | "account_mismatch" };

export function decideStoreActivation(evidence: StoreActivationEvidence): StoreActivationDecision {
  const provider = evidence.actualProviderAccountId?.trim() || null;
  if (!provider) {
    return { action: "reject", identityKey: null, reason: "identity_unverified" };
  }

  const actualKey = providerIdentityKey(provider);
  if (!evidence.isNewStore && evidence.selectedStoreIdentityKey !== actualKey) {
    return { action: "reject", identityKey: actualKey, reason: "account_mismatch" };
  }

  return { action: "commit", identityKey: actualKey, reason: "identity_verified" };
}
