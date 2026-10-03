import { which } from "../platform/command.js";
import * as configmod from "../core/config.js";
import { readCodexProviderIdentity } from "./account-auth.js";
import { providerIdentityKey } from "./account-store-model.js";
import { decideStoreMigration } from "./account-store-verification.js";
import { readRolloutCreatorAccountIds } from "./codex-task-discovery.js";
import { loadPreferences, savePreferences } from "./preferences.js";
import type { AccountProfile } from "./types.js";

export type ActiveStoreRuntimeState =
  | "ready"
  | "profile_missing"
  | "account_unverified"
  | "account_mismatch"
  | "migration_review";

export interface ActiveStoreRuntimeCheck {
  state: ActiveStoreRuntimeState;
  account: AccountProfile | null;
  detail: string;
}

export async function ensureActiveAccountStore(profileId: string): Promise<ActiveStoreRuntimeCheck> {
  const config = configmod.load();
  const preferences = loadPreferences(config);
  const profile = preferences.profiles.find((entry) => entry.id === profileId);
  const account = preferences.accounts.find((entry) => entry.id === profileId);

  if (!profile || !account || account.agent !== "codex" || !account.codexHome || !account.storeId) {
    return {
      state: "profile_missing",
      account: null,
      detail: "The selected Codex profile has no active account store.",
    };
  }

  const store = preferences.accountStores.find((entry) =>
    entry.id === account.storeId && entry.profileId === profileId);
  if (!store) {
    return {
      state: "profile_missing",
      account: null,
      detail: "The active account store is missing.",
    };
  }

  if (store.bindingState === "migration_review") {
    return {
      state: "migration_review",
      account,
      detail: "This migrated store contains ownership evidence from another ChatGPT account.",
    };
  }

  const command = which("codex");
  if (!command) {
    return {
      state: "account_unverified",
      account,
      detail: "Codex CLI was not found on PATH.",
    };
  }

  const identity = await readCodexProviderIdentity(command, account);
  if (!identity?.providerAccountId) {
    return {
      state: "account_unverified",
      account,
      detail: "PingGPT could not verify the active ChatGPT account identity.",
    };
  }

  const actualKey = providerIdentityKey(identity.providerAccountId);

  if (store.bindingState === "bound") {
    if (!store.identityKey || store.identityKey !== actualKey) {
      return {
        state: "account_mismatch",
        account,
        detail: "The active CODEX_HOME is authenticated as a different ChatGPT account.",
      };
    }

    let changed = false;
    if ((store.lastKnownEmail ?? null) !== (identity.email ?? null)) {
      store.lastKnownEmail = identity.email;
      changed = true;
    }
    if ((store.planType ?? null) !== (identity.planType ?? null)) {
      store.planType = identity.planType;
      changed = true;
    }
    if (changed) savePreferences(preferences);

    return {
      state: "ready",
      account: {
        ...account,
        storeIdentityKey: store.identityKey,
        storeBindingState: "bound",
      },
      detail: "Active account store identity verified.",
    };
  }

  const decision = decideStoreMigration({
    providerAccountId: identity.providerAccountId,
    creatorAccountIds: readRolloutCreatorAccountIds(store.codexHome),
  });

  if (decision.state === "migration_review") {
    store.bindingState = "migration_review";
    store.identityKey = null;
    store.lastKnownEmail = identity.email;
    store.planType = identity.planType;
    savePreferences(preferences);
    return {
      state: "migration_review",
      account: {
        ...account,
        storeIdentityKey: null,
        storeBindingState: "migration_review",
      },
      detail: "The store contains tasks created by a different ChatGPT account and was not rebound automatically.",
    };
  }

  if (decision.state === "account_unverified") {
    return {
      state: "account_unverified",
      account,
      detail: "PingGPT could not verify the provider account for this store.",
    };
  }

  store.bindingState = "bound";
  store.identityKey = decision.identityKey;
  store.lastKnownEmail = identity.email;
  store.planType = identity.planType;
  savePreferences(preferences);

  return {
    state: "ready",
    account: {
      ...account,
      storeIdentityKey: decision.identityKey,
      storeBindingState: "bound",
    },
    detail: "Account store verified and bound.",
  };
}
