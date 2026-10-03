import { createHash, randomUUID } from "node:crypto";

import type { AccountProfile, AccountStore, AutomationSettings, LocalProfile } from "./types.js";

function automationFromAccount(account: AccountProfile): AutomationSettings {
  return {
    message: account.message,
    schedules: [...account.schedules],
    catchupMinutes: account.catchupMinutes,
    wakePc: account.wakePc,
  };
}

export function providerIdentityKey(providerAccountId: string): string {
  const value = providerAccountId.trim();
  if (!value) throw new Error("Provider account identity is required.");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function newAccountStoreId(profileId: string): string {
  const safeProfile = profileId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 32) || "profile";
  return `store-${safeProfile}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function legacyAccountStoreId(profileId: string): string {
  const safeProfile = profileId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || "profile";
  return `store-${safeProfile}-legacy`;
}

export interface V1AccountMigration {
  profiles: LocalProfile[];
  accountStores: AccountStore[];
}

export function migrateV1AccountProfiles(accounts: AccountProfile[]): V1AccountMigration {
  const profiles: LocalProfile[] = [];
  const accountStores: AccountStore[] = [];

  for (const account of accounts) {
    const automation = automationFromAccount(account);
    let activeStoreId: string | null = null;

    if (account.agent === "codex" && account.codexHome) {
      activeStoreId = legacyAccountStoreId(account.id);
      accountStores.push({
        id: activeStoreId,
        profileId: account.id,
        codexHome: account.codexHome,
        identityKey: null,
        bindingState: "migration_pending",
        automation: {
          ...automation,
          schedules: [...automation.schedules],
        },
      });
    }

    profiles.push({
      id: account.id,
      displayName: account.displayName,
      enabled: account.enabled,
      agent: account.agent,
      activeStoreId,
      automation: {
        ...automation,
        schedules: [...automation.schedules],
      },
    });
  }

  return { profiles, accountStores };
}

export function activeStoreForProfile(
  profile: Pick<LocalProfile, "id" | "activeStoreId">,
  stores: AccountStore[],
): AccountStore | null {
  if (!profile.activeStoreId) return null;
  return stores.find((store) =>
    store.id === profile.activeStoreId && store.profileId === profile.id) ?? null;
}

export function projectActiveAccountProfiles(
  profiles: LocalProfile[],
  stores: AccountStore[],
): AccountProfile[] {
  return profiles.map((profile) => {
    const store = profile.agent === "codex" ? activeStoreForProfile(profile, stores) : null;
    const automation = store?.automation ?? profile.automation;
    return {
      id: profile.id,
      displayName: profile.displayName,
      enabled: profile.enabled,
      codexHome: store?.codexHome,
      message: automation.message,
      schedules: [...automation.schedules],
      agent: profile.agent,
      catchupMinutes: automation.catchupMinutes,
      wakePc: automation.wakePc,
      storeId: store?.id ?? null,
      storeIdentityKey: store?.identityKey ?? null,
      storeBindingState: store?.bindingState ?? null,
    };
  });
}
