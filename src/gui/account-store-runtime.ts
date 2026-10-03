import { which } from "../platform/command.js";
import * as configmod from "../core/config.js";
import { readCodexProviderIdentity } from "./account-auth.js";
import { projectAccountProfileForStore, providerIdentityKey } from "./account-store-model.js";
import { decideStoreMigration } from "./account-store-verification.js";
import { readRolloutCreatorAccountIds } from "./codex-task-discovery.js";
import { loadPreferences, saveCanonicalPreferences } from "./preferences.js";
import type { AccountProfile } from "./types.js";

export type ActiveStoreRuntimeState =
  | "ready"
  | "profile_missing"
  | "account_unverified"
  | "account_mismatch"
  | "account_already_stored"
  | "migration_review";

export interface ActiveStoreRuntimeCheck {
  state: ActiveStoreRuntimeState;
  account: AccountProfile | null;
  detail: string;
  existingStoreId?: string | null;
}

let verificationTail: Promise<void> = Promise.resolve();

async function withVerificationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = verificationTail;
  let release!: () => void;
  verificationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function verifyAccountStoreUnlocked(profileId: string, storeId: string): Promise<ActiveStoreRuntimeCheck> {
  const config = configmod.load();
  const preferences = loadPreferences(config);
  const profile = preferences.profiles.find((entry) => entry.id === profileId);
  const store = preferences.accountStores.find((entry) =>
    entry.id === storeId && entry.profileId === profileId);

  if (!profile || profile.agent !== "codex" || !store) {
    return {
      state: "profile_missing",
      account: null,
      detail: "The selected Codex account store was not found.",
    };
  }

  const account = projectAccountProfileForStore(profile, store);

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
      detail: "PingGPT could not verify the selected ChatGPT account identity.",
    };
  }

  const actualKey = providerIdentityKey(identity.providerAccountId);

  if (store.bindingState === "bound") {
    if (!store.identityKey || store.identityKey !== actualKey) {
      return {
        state: "account_mismatch",
        account,
        detail: "This CODEX_HOME is authenticated as a different ChatGPT account.",
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
    if (changed) saveCanonicalPreferences(preferences);

    return {
      state: "ready",
      account: {
        ...account,
        storeIdentityKey: store.identityKey,
        storeBindingState: "bound",
      },
      detail: "Account store identity verified.",
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
    saveCanonicalPreferences(preferences);
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

  const duplicate = preferences.accountStores.find((entry) =>
    entry.profileId === profileId
    && entry.id !== store.id
    && entry.bindingState === "bound"
    && entry.identityKey === decision.identityKey);
  if (duplicate) {
    return {
      state: "account_already_stored",
      account,
      existingStoreId: duplicate.id,
      detail: "This ChatGPT account already has a stored account context for this profile.",
    };
  }

  store.bindingState = "bound";
  store.identityKey = decision.identityKey;
  store.lastKnownEmail = identity.email;
  store.planType = identity.planType;
  saveCanonicalPreferences(preferences);

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

export async function verifyAccountStore(profileId: string, storeId: string): Promise<ActiveStoreRuntimeCheck> {
  return await withVerificationLock(() => verifyAccountStoreUnlocked(profileId, storeId));
}

export async function ensureActiveAccountStore(profileId: string): Promise<ActiveStoreRuntimeCheck> {
  const preferences = loadPreferences(configmod.load());
  const profile = preferences.profiles.find((entry) => entry.id === profileId);
  if (!profile?.activeStoreId) {
    return {
      state: "profile_missing",
      account: null,
      detail: "The selected Codex profile has no active account store.",
    };
  }
  return await verifyAccountStore(profileId, profile.activeStoreId);
}
