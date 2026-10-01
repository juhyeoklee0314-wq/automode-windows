import { readFileSync } from "node:fs";

import * as detect from "../agents/detect.js";
import * as dialogs from "../agents/dialogs.js";
import { which } from "../agents/ping.js";
import * as configmod from "../core/config.js";
import { redactSecrets } from "../core/redact.js";
import { nextOccurrence, parseHhmm, resolveTz } from "../core/timeutil.js";
import { codexAuthStatus, startCodexLogin } from "./account-auth.js";
import { leaseIsLive, writeLease } from "./lease.js";
import { loadPreferences, newAccountProfile as createAccountProfile, savePreferences } from "./preferences.js";
import { WindowsScheduler } from "./scheduler.js";
import type { AccountAuthStatus, AccountProfile, AppSnapshot, DoctorCheck, GuiPreferences, SavePayload } from "./types.js";
import { BUILD_IDENTITY } from "./diagnostics.js";
import type { DiagnosticTrace } from "./diagnostics.js";

function nextPing(preferences: GuiPreferences, config: configmod.Config): string | null {
  if (!preferences.schedulerEnabled) return null;
  const tz = resolveTz(config.timezone || null);
  const now = new Date();
  const candidates = preferences.accounts.flatMap((account) => account.enabled
    ? account.schedules.map((entry) => parseHhmm(entry)).filter((entry): entry is [number, number] => entry !== null)
    : []);
  if (!candidates.length) return null;
  return candidates
    .map(([hour, minute]) => nextOccurrence(now, hour, minute, tz))
    .sort((a, b) => a.getTime() - b.getTime())[0]!.toISOString();
}

function missingProfileStatus(accountId: string): AccountAuthStatus {
  return { accountId, state: "profile_missing", detail: "Account profile was not found. Save changes and try again." };
}

export class GuiService {
  constructor(
    private readonly scheduler: WindowsScheduler,
    private readonly version: string,
    private readonly trace?: DiagnosticTrace,
  ) {}

  snapshot(): AppSnapshot {
    this.trace?.emit("START_05_CONFIG_LOAD_BEGIN", "main");
    const config = configmod.load();
    this.trace?.emit("START_06_CONFIG_LOAD_END", "main");
    const preferences = loadPreferences(config);
    this.trace?.emit("START_07_AGENT_DISCOVERY_BEGIN", "main");
    const agents = { claude: which("claude"), codex: which("codex") };
    this.trace?.emit("START_08_AGENT_DISCOVERY_END", "main", {
      claudeFound: Boolean(agents.claude), codexFound: Boolean(agents.codex),
    });
    this.trace?.emit("START_09_SCHEDULER_STATUS_BEGIN", "main");
    const scheduler = this.scheduler.status();
    this.trace?.emit("START_10_SCHEDULER_STATUS_END", "main", { taskCount: scheduler.length });
    return {
      config,
      preferences,
      configPath: configmod.configPath(),
      logPath: configmod.logPath(),
      armed: leaseIsLive(),
      nextPing: nextPing(preferences, config),
      agents,
      scheduler,
      version: this.version,
      buildIdentity: BUILD_IDENTITY,
    };
  }

  save(payload: SavePayload): AppSnapshot {
    const primary = payload.preferences.accounts.find((account) => account.enabled) ?? payload.preferences.accounts[0];
    payload.config.ping.enabled = payload.preferences.schedulerEnabled;
    if (primary) {
      payload.config.ping.agent = primary.agent;
      payload.config.ping.message = primary.message;
      payload.config.ping.times = [...primary.schedules];
      payload.config.ping.catchup_minutes = primary.catchupMinutes ?? payload.config.ping.catchup_minutes;
    }
    configmod.save(payload.config);
    savePreferences(payload.preferences);
    if (payload.preferences.schedulerEnabled) {
      this.scheduler.install(payload.preferences.accounts);
      writeLease(true);
    } else {
      this.scheduler.prune(payload.preferences.accounts);
      this.scheduler.setEnabled(false);
      writeLease(false);
    }
    return this.snapshot();
  }

  setScheduler(enabled: boolean): AppSnapshot {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    preferences.schedulerEnabled = enabled;
    savePreferences(preferences);
    if (enabled) {
      this.scheduler.install(preferences.accounts);
      writeLease(true);
    } else {
      this.scheduler.setEnabled(false);
      writeLease(false);
    }
    return this.snapshot();
  }

  newAccountProfile(): AccountProfile {
    const config = configmod.load();
    const preferences = loadPreferences(config);
    return createAccountProfile(config, preferences.accounts);
  }

  async getAccountAuthStatus(accountId: string): Promise<AccountAuthStatus> {
    const config = configmod.load();
    const account = loadPreferences(config).accounts.find((entry) => entry.id === accountId);
    if (!account) return missingProfileStatus(accountId);
    return await codexAuthStatus(account);
  }

  connectAccount(accountId: string): AccountAuthStatus {
    const config = configmod.load();
    const account = loadPreferences(config).accounts.find((entry) => entry.id === accountId);
    if (!account) return missingProfileStatus(accountId);
    const result = startCodexLogin(account);
    this.trace?.emit("ACCOUNT_LOGIN_REQUESTED", "main", { accountId, state: result.state });
    return result;
  }

  doctor(): DoctorCheck[] {
    const config = configmod.load();
    const tz = resolveTz(config.timezone || null);
    const now = new Date();
    const limitHits = detect.SAMPLES.filter((sample) => detect.scan(detect.normalize(sample), now, tz)).length;
    const dialogHits = dialogs.SAMPLES.filter((sample) => dialogs.find(detect.normalize(sample.text))?.key === sample.key).length;
    return [
      { name: "Limit detector", ok: limitHits === detect.SAMPLES.length, detail: `${limitHits}/${detect.SAMPLES.length} samples` },
      { name: "Blocking dialogs", ok: dialogHits === dialogs.SAMPLES.length, detail: `${dialogHits}/${dialogs.SAMPLES.length} samples` },
      { name: "Claude", ok: Boolean(which("claude")), detail: which("claude") ?? "Not found on PATH" },
      { name: "Codex", ok: Boolean(which("codex")), detail: which("codex") ?? "Not found on PATH" },
      { name: "GUI lease", ok: leaseIsLive(), detail: leaseIsLive() ? "Live and armed" : "Disarmed or stale" },
    ];
  }

  readLog(): string {
    try {
      const text = readFileSync(configmod.logPath(), "utf8");
      return redactSecrets(text.slice(-200_000));
    } catch {
      return "No log entries yet.";
    }
  }
}
