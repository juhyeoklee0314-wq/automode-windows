const $ = (id) => document.getElementById(id);
let snapshot;
let taskInventorySnapshot = null;
let taskAccountFilter = 'all';
let automationAccountFilter = 'all';
let taskSearchQuery = '';

function showBanner(message, error = false) {
  const el = $("banner");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 5000);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function activeStoreForProfile(profile) {
  if (!profile) return null;
  return (profile.stores || []).find((store) => store.id === profile.activeStoreId)
    || (profile.stores || [])[0]
    || null;
}

function render(data) {
  snapshot = data;
  const c = data.config;
  const p = data.preferences;
  $("version").textContent = `v${data.version} · ${data.buildIdentity}`;
  $("auto-continue").checked = c.auto_continue;
  $("continue-message").value = c.continue_message;
  $("grace").value = c.grace_seconds;
  $("idle-guard").value = c.idle_guard_seconds;
  $("auto-ping").checked = p.schedulerEnabled;
  $("run-at-login").checked = p.runAtLogin;
  $("config-path").textContent = `Config: ${data.configPath}`;
  $("log-path").textContent = data.logPath;
  const live = data.armed && p.schedulerEnabled;
  $("lease-dot").classList.toggle("live", live);
  $("lease-label").textContent = live ? "Armed" : "Disarmed";
  $("status-pill").textContent = live ? "PINGGPT ON" : "PINGGPT OFF";
  $("status-pill").style.color = live ? "var(--green)" : "var(--muted)";
  if (data.nextPing) {
    const next = new Date(data.nextPing);
    $("next-ping").textContent = next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("next-detail").textContent = next.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  } else {
    $("next-ping").textContent = "—";
    $("next-detail").textContent = "No schedule configured";
  }
  for (const agent of ["claude", "codex"]) {
    const found = data.agents[agent];
    $(`${agent}-path`).textContent = found || "Not found on PATH";
    $(`${agent}-badge`).textContent = found ? "READY" : "MISSING";
    $(`${agent}-badge`).classList.toggle("ok", Boolean(found));
  }
  renderAccounts(p.accounts);
  renderAutomationAccountTabs(p.accounts);
  renderTaskResumeSchedules(p.taskResumeSchedules || []);
  if (taskInventorySnapshot) renderTaskInventory(taskInventorySnapshot);
  const tasks = $("task-list");
  tasks.replaceChildren();
  if (!data.scheduler.length) tasks.innerHTML = '<p class="muted">No GUI scheduler tasks installed.</p>';
  data.scheduler.forEach((task) => {
    const row = document.createElement("div");
    row.className = "task";
    const copy = document.createElement("div");
    const time = document.createElement("strong");
    const name = document.createElement("small");
    time.textContent = task.time;
    name.textContent = task.name;
    copy.append(time, name);
    const badge = document.createElement("span");
    badge.className = `badge ${task.enabled ? "ok" : ""}`;
    badge.textContent = task.enabled ? "ENABLED" : task.installed ? "DISABLED" : "MISSING";
    row.append(copy, badge);
    tasks.append(row);
  });
}

function accountCard(account, saved = true) {
  const activeStore = activeStoreForProfile(account);
  const card = document.createElement("div");
  card.className = `account-card${account.enabled ? "" : " disabled"}`;
  card.dataset.accountId = account.id;
  card.dataset.storeId = activeStore?.id || "";
  card.dataset.codexHome = activeStore?.codexHome || "";
  card.dataset.saved = saved ? "true" : "false";
  card._accountProfile = structuredClone(account);

  const head = document.createElement("div");
  head.className = "account-head";

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Profile name (local label)";
  const nameInput = document.createElement("input");
  nameInput.className = "account-name";
  nameInput.type = "text";
  nameInput.maxLength = 80;
  nameInput.value = account.displayName;
  nameInput.oninput = () => refreshAutomationTabLabels();
  nameLabel.append(nameInput);

  const enableWrap = document.createElement("div");
  enableWrap.className = "account-enable";
  const enableText = document.createElement("span");
  enableText.textContent = "Enabled";
  const enableLabel = document.createElement("label");
  enableLabel.className = "switch";
  enableLabel.style.margin = "0";
  const enableInput = document.createElement("input");
  enableInput.className = "account-enabled";
  enableInput.type = "checkbox";
  enableInput.checked = account.enabled;
  const enableSlider = document.createElement("span");
  enableLabel.append(enableInput, enableSlider);
  enableWrap.append(enableText, enableLabel);

  const deleteButton = document.createElement("button");
  deleteButton.className = "remove small delete-account";
  deleteButton.textContent = "Delete";
  deleteButton.onclick = () => {
    const removedId = card.dataset.accountId;
    card.remove();
    if (automationAccountFilter === removedId) automationAccountFilter = "all";
    ensureEmptyAccountsMessage();
    refreshAutomationTabLabels();
    showBanner("Profile removed from the draft. Save changes to apply.");
  };
  head.append(nameLabel, enableWrap, deleteButton);

  const grid = document.createElement("div");
  grid.className = "account-grid";

  const agentLabel = document.createElement("label");
  agentLabel.textContent = "Agent";
  const agentSelect = document.createElement("select");
  agentSelect.className = "account-agent";
  for (const [value, label] of [["codex", "Codex / ChatGPT"], ["claude", "Claude"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    agentSelect.append(option);
  }
  agentSelect.value = account.agent;
  agentLabel.append(agentSelect);

  const catchupLabel = document.createElement("label");
  catchupLabel.textContent = "Catch-up window (minutes)";
  const catchupInput = document.createElement("input");
  catchupInput.className = "account-catchup";
  catchupInput.type = "number";
  catchupInput.min = "0";
  catchupInput.max = "180";
  catchupInput.value = String(activeStore?.catchupMinutes ?? snapshot?.config?.ping?.catchup_minutes ?? 30);
  catchupLabel.append(catchupInput);

  const wakeLabel = document.createElement("label");
  wakeLabel.textContent = "Sleep / lid-closed behavior";
  const wakeWrap = document.createElement("div");
  wakeWrap.className = "account-enable";
  wakeWrap.style.paddingBottom = "0";
  const wakeText = document.createElement("span");
  wakeText.textContent = "Wake on AC, then return to sleep";
  const wakeSwitch = document.createElement("label");
  wakeSwitch.className = "switch";
  wakeSwitch.style.margin = "0";
  const wakeInput = document.createElement("input");
  wakeInput.className = "account-wake";
  wakeInput.type = "checkbox";
  wakeInput.checked = activeStore?.wakePc === true;
  const wakeSlider = document.createElement("span");
  wakeSwitch.append(wakeInput, wakeSlider);
  wakeWrap.append(wakeText, wakeSwitch);
  wakeLabel.append(wakeWrap);
  grid.append(agentLabel, catchupLabel, wakeLabel);

  const auth = document.createElement("div");
  auth.className = "account-auth";
  const authCopy = document.createElement("div");
  authCopy.className = "auth-copy";
  const authTitle = document.createElement("strong");
  authTitle.className = "account-auth-identity";
  authTitle.textContent = activeStore?.lastKnownEmail || "Actual ChatGPT account";
  const authMeta = document.createElement("small");
  authMeta.className = "account-auth-meta";
  authMeta.textContent = saved ? "Reading active account identity from Codex…" : "Save this profile to manage its account";
  const authPath = document.createElement("small");
  authPath.className = "account-auth-path";
  authPath.textContent = activeStore?.codexHome || "No account store";
  const authStatus = document.createElement("span");
  authStatus.className = "auth-status";
  authStatus.textContent = saved ? "CHECKING" : "SAVE TO CONNECT";
  authCopy.append(authTitle, authMeta, authPath, authStatus);

  const manageButton = document.createElement("button");
  manageButton.className = "secondary small connect-account";
  manageButton.textContent = "Manage account";

  const manager = document.createElement("div");
  manager.className = "account-grid account-store-manager hidden";
  const storeLabel = document.createElement("label");
  storeLabel.textContent = "Use account";
  const storeSelect = document.createElement("select");
  storeSelect.className = "account-store-select";
  (account.stores || []).forEach((store, index) => {
    const option = document.createElement("option");
    option.value = store.id;
    const known = store.lastKnownEmail || (store.id === account.activeStoreId ? "Current account" : `Stored account ${index + 1}`);
    option.textContent = store.id === account.activeStoreId ? `${known} (current)` : known;
    storeSelect.append(option);
  });
  const addOption = document.createElement("option");
  addOption.value = "__new__";
  addOption.textContent = "Connect another account";
  storeSelect.append(addOption);
  storeSelect.value = account.activeStoreId || "__new__";
  storeLabel.append(storeSelect);

  const useButton = document.createElement("button");
  useButton.className = "secondary small";
  useButton.type = "button";
  useButton.textContent = "Continue";
  useButton.onclick = () => manageAccountSelection(card, storeSelect.value);
  manager.append(storeLabel, useButton);
  manageButton.onclick = () => manager.classList.toggle("hidden");
  auth.append(authCopy, manageButton);

  const messageLabel = document.createElement("label");
  messageLabel.className = "account-message";
  messageLabel.textContent = "Ping message";
  const messageInput = document.createElement("textarea");
  messageInput.className = "account-message-input";
  messageInput.maxLength = 2000;
  messageInput.rows = 2;
  messageInput.value = activeStore?.message || snapshot?.config?.ping?.message || "hi";
  messageLabel.append(messageInput);

  const timesWrap = document.createElement("div");
  timesWrap.className = "account-times-wrap";
  const timesHead = document.createElement("div");
  timesHead.className = "account-times-head";
  const timesTitle = document.createElement("strong");
  timesTitle.textContent = "Daily ping times";
  const addTime = document.createElement("button");
  addTime.className = "secondary small add-account-time";
  addTime.textContent = "+ Add time";
  const times = document.createElement("div");
  times.className = "account-times";
  addTime.onclick = () => addTimeRow(times, "09:00");
  timesHead.append(timesTitle, addTime);
  timesWrap.append(timesHead, times);
  (activeStore?.schedules || []).forEach((time) => addTimeRow(times, time));

  const updateVisibility = () => {
    card.classList.toggle("disabled", !enableInput.checked);
    auth.classList.toggle("hidden", agentSelect.value !== "codex");
    manager.classList.toggle("hidden", agentSelect.value !== "codex" || manager.classList.contains("hidden"));
  };
  enableInput.onchange = updateVisibility;
  agentSelect.onchange = updateVisibility;

  card.append(head, grid, auth, manager, messageLabel, timesWrap);
  card.classList.toggle("disabled", !enableInput.checked);
  auth.classList.toggle("hidden", agentSelect.value !== "codex");
  return card;
}

function addTimeRow(root, value) {
  const row = document.createElement("div");
  row.className = "account-time-row";
  const input = document.createElement("input");
  input.type = "time";
  input.className = "account-time";
  input.value = value;
  const remove = document.createElement("button");
  remove.className = "remove small";
  remove.textContent = "Remove";
  remove.onclick = () => row.remove();
  row.append(input, remove);
  root.append(row);
}

function ensureEmptyAccountsMessage() {
  const root = $("account-list");
  const cards = root.querySelectorAll(".account-card");
  const existing = root.querySelector(".empty-accounts");
  if (cards.length === 0 && !existing) {
    const empty = document.createElement("div");
    empty.className = "empty-accounts";
    empty.textContent = "No ping accounts configured. Add an account to create a schedule target.";
    root.append(empty);
  } else if (cards.length > 0 && existing) {
    existing.remove();
  }
}

function renderAccounts(accounts) {
  const root = $("account-list");
  root.replaceChildren();
  accounts.forEach((account) => root.append(accountCard(account, true)));
  ensureEmptyAccountsMessage();
  accounts.filter((account) => account.agent === "codex").forEach((account) => {
    const store = activeStoreForProfile(account);
    if (!store) return;
    refreshAuthStatus(account.id, store.id).then(async (status) => {
      if (
        status?.state === "connected"
        && status.identityVerified === true
        && store.bindingState !== "ready"
      ) {
        const result = await window.automode.activateAccountStore(account.id, store.id);
        applyAuthStatus(result.status);
        if (result.ok) {
          render(result.snapshot);
          await refreshTasks({ source: "migration", quiet: true });
        }
      }
    });
  });
}

function automationProfileName(account) {
  return String(account?.displayName || account?.id || "Profile");
}

function applyAutomationAccountFilter() {
  const cards = [...$("account-list").querySelectorAll(".account-card")];
  for (const card of cards) {
    const visible = automationAccountFilter === "all" || card.dataset.accountId === automationAccountFilter;
    card.classList.toggle("account-filter-hidden", !visible);
  }
}

function renderAutomationAccountTabs(accounts = snapshot?.preferences?.accounts || []) {
  const root = $("automation-account-tabs");
  if (!root) return;

  const valid = new Set(["all", ...accounts.map((account) => account.id)]);
  if (!valid.has(automationAccountFilter)) automationAccountFilter = "all";

  root.replaceChildren();

  const addTab = (id, label, count = null) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-account-tab" + (automationAccountFilter === id ? " active" : "");
    button.dataset.automationFilter = id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", automationAccountFilter === id ? "true" : "false");

    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);

    if (count !== null) {
      const badge = document.createElement("span");
      badge.className = "count";
      badge.textContent = String(count);
      button.append(badge);
    }

    button.onclick = () => {
      automationAccountFilter = id;
      renderAutomationAccountTabs(readAccounts());
      applyAutomationAccountFilter();
    };
    root.append(button);
  };

  addTab("all", "All", accounts.length);
  for (const account of accounts) addTab(account.id, automationProfileName(account));

  applyAutomationAccountFilter();
}

function refreshAutomationTabLabels() {
  renderAutomationAccountTabs(readAccounts());
}

function readAccounts() {
  return [...$("account-list").querySelectorAll(".account-card")].map((card, index) => {
    const profile = structuredClone(card._accountProfile || {});
    profile.id = card.dataset.accountId;
    profile.displayName = card.querySelector(".account-name").value.trim() || `Profile ${index + 1}`;
    profile.enabled = card.querySelector(".account-enabled").checked;
    profile.agent = card.querySelector(".account-agent").value;
    profile.stores = Array.isArray(profile.stores) ? profile.stores : [];
    const storeId = profile.activeStoreId || card.dataset.storeId;
    const store = profile.stores.find((entry) => entry.id === storeId) || profile.stores[0];
    if (store) {
      profile.activeStoreId = store.id;
      store.message = card.querySelector(".account-message-input").value;
      store.schedules = [...card.querySelectorAll(".account-time")].map((input) => input.value).filter(Boolean);
      store.catchupMinutes = clampNumber(card.querySelector(".account-catchup").value, 0, 180, 30);
      store.wakePc = card.querySelector(".account-wake").checked;
    }
    return profile;
  });
}

async function saveChanges(showSuccess = true) {
  const config = structuredClone(snapshot.config);
  const preferences = structuredClone(snapshot.preferences);
  config.auto_continue = $("auto-continue").checked;
  config.continue_message = $("continue-message").value.trim() || "continue";
  config.grace_seconds = Number($("grace").value);
  config.idle_guard_seconds = Number($("idle-guard").value);
  const accounts = readAccounts();
  preferences.schedulerEnabled = $("auto-ping").checked;
  preferences.accounts = accounts;
  config.ping.enabled = preferences.schedulerEnabled;
  const primary = accounts.find((account) => account.enabled) || accounts[0];
  const primaryStore = activeStoreForProfile(primary);
  if (primary && primaryStore) {
    config.ping.agent = primary.agent;
    config.ping.message = primaryStore.message;
    config.ping.times = [...primaryStore.schedules];
    config.ping.catchup_minutes = primaryStore.catchupMinutes;
  }
  const result = await window.automode.save({ config, preferences });
  render(result);
  if (showSuccess) showBanner("Settings saved.");
  return result;
}

function authStatusElement(accountId) {
  const card = [...$("account-list").querySelectorAll(".account-card")]
    .find((entry) => entry.dataset.accountId === accountId);
  return card?.querySelector(".auth-status") || null;
}

function formatPlanType(value) {
  if (!value) return "";
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function applyAuthStatus(status) {
  const el = authStatusElement(status.accountId);
  if (!el) return;
  el.classList.remove("ok", "bad");
  const card = [...$("account-list").querySelectorAll(".account-card")]
    .find((entry) => entry.dataset.accountId === status.accountId);
  const button = card?.querySelector(".connect-account");
  const identity = card?.querySelector(".account-auth-identity");
  const meta = card?.querySelector(".account-auth-meta");
  if (button) button.textContent = "Manage account";

  if (status.state === "connected") {
    el.textContent = status.bindingState && status.bindingState !== "ready"
      ? "CONNECTED · VERIFYING"
      : status.identityVerified === false ? "CONNECTED · IDENTITY UNKNOWN" : "CONNECTED";
    el.classList.add("ok");
    if (identity) identity.textContent = status.email || "Actual ChatGPT account";
    if (meta) {
      const plan = formatPlanType(status.planType);
      if (status.identityVerified === true) {
        meta.textContent = status.email
          ? [plan, "Identity verified by Codex"].filter(Boolean).join(" · ")
          : [plan, "Email not provided by Codex"].filter(Boolean).join(" · ");
      } else {
        meta.textContent = "Login verified, but Codex account identity is unavailable";
      }
    }
  } else if (status.state === "login_started") {
    el.textContent = "WAITING FOR LOGIN";
    if (identity) {
      identity.textContent = status.loginCode
        ? `Device code: ${status.loginCode}`
        : "Actual ChatGPT account";
    }
    if (meta) {
      meta.textContent = status.loginCode
        ? "Code copied to clipboard. Paste it into the browser page."
        : "Waiting for device login to complete…";
    }
  } else if (status.state === "migration_review") {
    el.textContent = "MIGRATION REVIEW";
    el.classList.add("bad");
    if (meta) meta.textContent = status.detail;
  } else if (status.state === "account_mismatch") {
    el.textContent = "ACCOUNT MISMATCH";
    el.classList.add("bad");
    if (meta) meta.textContent = status.detail;
  } else if (status.state === "account_unverified") {
    el.textContent = "ACCOUNT UNVERIFIED";
    el.classList.add("bad");
    if (meta) meta.textContent = status.detail;
  } else if (status.state === "wrong_auth") {
    el.textContent = "NOT CHATGPT AUTH";
    el.classList.add("bad");
    if (identity) identity.textContent = "Actual ChatGPT account";
    if (meta) meta.textContent = "Codex is authenticated with a non-ChatGPT credential";
  } else if (status.state === "not_codex") {
    el.textContent = "NOT CODEX";
  } else if (status.state === "cli_missing") {
    el.textContent = "CODEX CLI MISSING";
    el.classList.add("bad");
  } else if (status.state === "profile_missing") {
    el.textContent = "SAVE REQUIRED";
    el.classList.add("bad");
  } else {
    el.textContent = "NOT CONNECTED";
    el.classList.add("bad");
    if (identity) identity.textContent = "Actual ChatGPT account";
    if (meta) meta.textContent = "No ChatGPT login is active for this profile";
  }
}

async function refreshAuthStatus(accountId, storeId = null) {
  try {
    const status = await window.automode.getAccountAuthStatus(accountId, storeId);
    applyAuthStatus(status);
    return status;
  } catch {
    const el = authStatusElement(accountId);
    if (el) {
      el.textContent = "STATUS ERROR";
      el.classList.add("bad");
    }
    return null;
  }
}

async function pollAuthStatus(accountId, storeId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await refreshAuthStatus(accountId, storeId);
    if (!status || status.state === "cli_missing") return;
    if (status.state === "connected" && status.identityVerified === true) {
      const activation = await window.automode.activateAccountStore(accountId, storeId);
      applyAuthStatus(activation.status);
      if (activation.ok) {
        render(activation.snapshot);
        await refreshTasks({ source: "account-change", quiet: true });
        showBanner("Account verified and activated.");
      } else {
        showBanner(activation.status.detail, true);
      }
      return;
    }
    if (status.state === "connected" && attempt >= 4) return;
  }
}

async function startStoreLogin(accountId, storeId) {
  const status = await window.automode.connectAccount(accountId, storeId);
  applyAuthStatus(status);
  showBanner(
    status.state === "login_started" && status.loginCode
      ? `Choose the intended ChatGPT account in the browser and enter code ${status.loginCode}.`
      : status.detail,
    ["cli_missing", "not_connected", "profile_missing", "store_missing"].includes(status.state),
  );
  if (status.state !== "login_started") return;
  if (status.loginUrl && status.loginCode) {
    const opened = await window.automode.openExternalLogin(status.loginUrl, status.loginCode);
    if (opened) showBanner(`Device code ${status.loginCode} copied to clipboard. Paste it into the browser.`);
    else showBanner("Could not open the Codex device login page or copy its code.", true);
  }
  pollAuthStatus(accountId, storeId);
}

async function manageAccountSelection(card, selectedStoreId) {
  const accountId = card.dataset.accountId;
  const button = card.querySelector(".connect-account");
  button.disabled = true;
  try {
    await saveChanges(false);
    let storeId = selectedStoreId;
    if (storeId === "__new__") {
      const store = await window.automode.newAccountStore(accountId);
      storeId = store.id;
    }

    const activation = await window.automode.activateAccountStore(accountId, storeId);
    applyAuthStatus(activation.status);
    if (activation.ok) {
      render(activation.snapshot);
      await refreshTasks({ source: "account-change", quiet: true });
      showBanner("Account activated.");
      return;
    }

    if (activation.status.storeId && activation.status.storeId !== storeId) {
      render(activation.snapshot);
      showBanner(activation.status.detail, true);
      return;
    }

    if (["not_connected", "wrong_auth", "account_mismatch", "migration_review"].includes(activation.status.state)) {
      await startStoreLogin(accountId, storeId);
      return;
    }
    showBanner(activation.status.detail, true);
  } catch (error) {
    showBanner(`Could not manage account: ${error.message || error}`, true);
  } finally {
    const current = [...$("account-list").querySelectorAll(".account-card")]
      .find((entry) => entry.dataset.accountId === accountId);
    const currentButton = current?.querySelector(".connect-account");
    if (currentButton) currentButton.disabled = false;
  }
}

function formatTaskTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Unknown time";
  return new Date(seconds * 1000).toLocaleString();
}

function defaultTaskScheduleValue() {
  const date = new Date(Date.now() + 5 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function taskTimestamp(item) {
  const value = item?.recencyAt ?? item?.updatedAt ?? item?.createdAt;
  return Number.isFinite(value) ? Number(value) : 0;
}

function taskFilterOptions(data) {
  const counts = new Map();
  for (const item of data.items || []) {
    if (item.source === 'account' && item.accountId) {
      counts.set(item.accountId, (counts.get(item.accountId) || 0) + 1);
    }
  }

  const accountStates = new Map((data.accounts || []).map((state) => [state.accountId, state]));
  const configured = (snapshot?.preferences?.accounts || [])
    .filter((account) => account.agent === 'codex' && account.enabled !== false)
    .map((account) => {
      return {
        id: account.id,
        label: account.displayName || account.id,
        count: counts.get(account.id) || 0,
      };
    });

  for (const item of data.items || []) {
    if (item.source !== 'account' || !item.accountId) continue;
    if (configured.some((account) => account.id === item.accountId)) continue;
    configured.push({
      id: item.accountId,
      label: item.accountLabel || item.accountId,
      count: counts.get(item.accountId) || 0,
    });
  }

  return {
    accounts: configured,
    legacyCount: (data.items || []).filter((item) => item.source === 'legacy_global').length,
    total: (data.items || []).length,
  };
}

function renderTaskAccountTabs(data) {
  const root = $('task-account-tabs');
  if (!root) return;
  const options = taskFilterOptions(data);
  const validFilters = new Set(['all', 'legacy', ...options.accounts.map((account) => account.id)]);
  if (!validFilters.has(taskAccountFilter)) taskAccountFilter = 'all';

  root.replaceChildren();

  const addTab = (id, label, count, legacy = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'task-account-tab'
      + (legacy ? ' legacy-tab' : '')
      + (taskAccountFilter === id ? ' active' : '');
    button.dataset.taskFilter = id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', taskAccountFilter === id ? 'true' : 'false');

    const text = document.createElement('span');
    text.textContent = label;
    const badge = document.createElement('span');
    badge.className = 'count';
    badge.textContent = String(count);
    button.append(text, badge);

    button.onclick = () => {
      taskAccountFilter = id;
      renderTaskInventory(taskInventorySnapshot || data);
      renderTaskResumeSchedules(snapshot?.preferences?.taskResumeSchedules || []);
    };
    root.append(button);
  };

  addTab('all', 'All', options.total);
  options.accounts.forEach((account) => addTab(account.id, account.label, account.count));
  addTab('legacy', 'Legacy', options.legacyCount, true);
}

function taskMatchesFilter(item) {
  if (taskAccountFilter === 'legacy') return item.source === 'legacy_global';
  if (taskAccountFilter !== 'all') return item.source === 'account' && item.accountId === taskAccountFilter;
  return true;
}

function inventoryAccountState(accountId) {
  if (!accountId) return null;
  return (taskInventorySnapshot?.accounts || []).find((state) => state.accountId === accountId) || null;
}

function taskMatchesSearch(item) {
  const query = taskSearchQuery.trim().toLowerCase();
  if (!query) return true;
  const accountState = inventoryAccountState(item.accountId);
  return [
    item.title,
    item.preview,
    item.cwd,
    item.accountLabel,
    accountState?.connectedEmail,
    item.model,
    item.sessionSource,
    item.ownershipStatus,
  ].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
}

function activeTaskSchedule(item) {
  if (!item?.accountId) return null;
  return (snapshot?.preferences?.taskResumeSchedules || []).find((schedule) =>
    schedule.enabled
    && schedule.profileId === item.accountId
    && schedule.storeId === item.storeId
    && schedule.threadId === item.id
  ) || null;
}

function taskState(item) {
  if (item.source === 'legacy_global') return { label: 'LEGACY', className: '' };
  if (item.ownershipStatus === 'mismatch') {
    return {
      label: 'ACCOUNT MISMATCH',
      className: 'mismatch',
      title: 'This task was created by a different ChatGPT account than the account currently connected to this PingGPT profile.',
    };
  }
  if (item.ownershipStatus !== 'matched') {
    return {
      label: 'OWNERSHIP UNVERIFIED',
      className: 'unverified',
      title: 'PingGPT could not verify that the connected ChatGPT account created this task.',
    };
  }
  const scheduled = activeTaskSchedule(item);
  if (scheduled) {
    return {
      label: 'SCHEDULED',
      className: 'scheduled',
      title: new Date(scheduled.runAt).toLocaleString(),
    };
  }
  const status = String(item.status || '').toLowerCase();
  if (status.includes('active') || status.includes('running') || status.includes('inprogress')) {
    return { label: 'RUNNING', className: 'running' };
  }
  return { label: 'READY', className: 'ready' };
}

function syncAccountFilterHeader(page) {
  const taskTabs = $('task-account-tabs');
  const automationTabs = $('automation-account-tabs');
  if (taskTabs) taskTabs.classList.toggle('hidden', page !== 'tasks');
  if (automationTabs) automationTabs.classList.toggle('hidden', page !== 'automation');
}

function renderTaskResumeSchedules(schedules) {
  const root = $('task-resume-schedule-list');
  if (!root) return;
  root.replaceChildren();

  const filtered = (schedules || []).filter((schedule) => {
    if (taskAccountFilter === 'legacy') return false;
    const profile = (snapshot?.preferences?.accounts || [])
      .find((entry) => entry.id === schedule.profileId);
    if (!profile || profile.activeStoreId !== schedule.storeId) return false;
    if (taskAccountFilter === 'all') return true;
    return schedule.profileId === taskAccountFilter;
  });

  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = taskAccountFilter === 'all'
      ? 'No task resumes are scheduled.'
      : 'No task resumes are scheduled for this account filter.';
    root.append(empty);
    return;
  }

  filtered
    .slice()
    .sort((a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime())
    .forEach((schedule) => {
      const row = document.createElement('div');
      row.className = 'task-resume-schedule';

      const copy = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = schedule.title || 'Codex task';
      const meta = document.createElement('small');
      const account = snapshot?.preferences?.accounts?.find((entry) => entry.id === schedule.accountId);
      meta.textContent = [
        account?.displayName || schedule.accountId,
        new Date(schedule.runAt).toLocaleString(),
      ].join(' · ');
      copy.append(title, meta);

      const actions = document.createElement('div');
      actions.className = 'task-resume-schedule-actions';
      const state = document.createElement('span');
      state.className = 'badge ' + (schedule.enabled ? 'scheduled' : 'finished');
      state.textContent = schedule.enabled
        ? 'SCHEDULED'
        : String(schedule.lastStatus || 'FINISHED').toUpperCase();

      const cancel = document.createElement('button');
      cancel.className = 'remove small';
      cancel.textContent = schedule.enabled ? 'Cancel' : 'Remove';
      cancel.onclick = async () => {
        cancel.disabled = true;
        try {
          render(await window.automode.cancelTaskResumeSchedule(schedule.id));
          showBanner('Task resume schedule removed.');
        } catch (error) {
          showBanner('Could not remove task resume schedule: ' + (error.message || error), true);
          cancel.disabled = false;
        }
      };

      actions.append(state, cancel);
      row.append(copy, actions);
      root.append(row);
    });
}

async function resumeTaskNow(item, button) {
  if (!item.accountId || !item.storeId) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Running…";
  try {
    const result = await window.automode.resumeTask(item.accountId, item.storeId, item.id, item.updatedAt);
    const ok = ["completed", "already_running"].includes(result.status);
    showBanner(`${result.status}: ${result.detail}`, !ok);
    await refreshTasks();
  } catch (error) {
    showBanner(`Could not resume task: ${error.message || error}`, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function scheduleTaskAt(item, dateValue) {
  if (!item.accountId || !item.storeId) return;
  const when = new Date(dateValue);
  if (!Number.isFinite(when.getTime())) {
    showBanner("Choose a valid resume date and time.", true);
    return;
  }
  try {
    render(await window.automode.scheduleTaskResume(
      item.accountId,
      item.storeId,
      item.id,
      item.title,
      when.toISOString(),
      item.updatedAt,
    ));
    showBanner(`Task resume scheduled for ${when.toLocaleString()}.`);
  } catch (error) {
    showBanner(`Could not schedule task resume: ${error.message || error}`, true);
  }
}

async function scheduleTaskAtReset(item, button) {
  if (!item.accountId || !item.storeId) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Checking…";
  try {
    const limits = await window.automode.getAccountRateLimitStatus(item.accountId, item.storeId);
    if (!Number.isFinite(limits.suggestedResetAt)) {
      throw new Error("Codex did not provide a future reset timestamp.");
    }
    const graceSeconds = Number(snapshot?.config?.grace_seconds ?? 60);
    const when = new Date(limits.suggestedResetAt * 1000 + Math.max(0, graceSeconds) * 1000);
    render(await window.automode.scheduleTaskResume(
      item.accountId,
      item.storeId,
      item.id,
      item.title,
      when.toISOString(),
      item.updatedAt,
    ));
    showBanner(`Task resume scheduled for limit reset + grace: ${when.toLocaleString()}.`);
  } catch (error) {
    showBanner(`Could not schedule at reset: ${error.message || error}`, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function renderTaskInventory(data) {
  taskInventorySnapshot = data;
  renderTaskAccountTabs(data);

  const root = $('codex-task-list');
  const summary = $('task-inventory-summary');
  root.replaceChildren();

  const accountCount = data.items.filter((item) => item.source === 'account').length;
  const legacyCount = data.items.filter((item) => item.source === 'legacy_global').length;
  const errorCount = data.errors.length;
  const filteredItems = data.items
    .filter(taskMatchesFilter)
    .filter(taskMatchesSearch)
    .slice()
    .sort((a, b) => taskTimestamp(b) - taskTimestamp(a));

  let filterLabel = null;
  if (taskAccountFilter === 'legacy') {
    filterLabel = 'Legacy';
  } else if (taskAccountFilter !== 'all') {
    filterLabel = (snapshot?.preferences?.accounts || [])
      .find((account) => account.id === taskAccountFilter)?.displayName || taskAccountFilter;
  }

  summary.textContent = [
    accountCount + ' account task' + (accountCount === 1 ? '' : 's'),
    legacyCount + ' legacy task' + (legacyCount === 1 ? '' : 's'),
    filterLabel
      ? 'showing ' + filteredItems.length + ' for ' + filterLabel
      : (taskSearchQuery ? 'showing ' + filteredItems.length + ' matches' : null),
    errorCount ? errorCount + ' source error' + (errorCount === 1 ? '' : 's') : null,
  ].filter(Boolean).join(' · ');

  if (!filteredItems.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = data.items.length
      ? 'No tasks match the current account filter or search.'
      : errorCount
        ? 'No tasks could be loaded from the available Codex stores.'
        : 'No Codex tasks were found.';
    root.append(empty);
  }

  filteredItems.forEach((item) => {
    const row = document.createElement('div');
    const ownershipClass = item.source === 'legacy_global'
      ? 'legacy'
      : item.ownershipStatus === 'mismatch'
        ? 'mismatch'
        : item.ownershipStatus === 'matched'
          ? 'owned'
          : 'unverified';
    row.className = 'codex-task-row ' + ownershipClass;

    const copy = document.createElement('div');
    copy.className = 'codex-task-copy';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const meta = document.createElement('small');
    const accountState = inventoryAccountState(item.accountId);
    const connectedLabel = item.source === 'account'
      ? (accountState?.connectedEmail
        || (accountState?.identityVerified ? 'Connected account verified' : 'Connected identity unavailable'))
      : null;
    meta.textContent = [
      item.source === 'account' ? 'Stored in ' + item.accountLabel : item.accountLabel,
      connectedLabel ? 'Connected: ' + connectedLabel : null,
      item.model,
      item.sessionSource,
      formatTaskTime(taskTimestamp(item)),
    ].filter(Boolean).join(' · ');
    const cwd = document.createElement('small');
    cwd.className = 'codex-task-cwd';
    cwd.textContent = item.cwd || 'Working directory unavailable';
    copy.append(title, meta, cwd);

    const actions = document.createElement('div');
    actions.className = 'codex-task-actions';

    const ownership = document.createElement('span');
    ownership.className = 'badge ' + (item.source === 'account' ? 'profile' : '');
    ownership.textContent = item.source === 'account' ? 'PROFILE TASK' : 'LEGACY / GLOBAL';

    const operational = taskState(item);
    const operationalBadge = document.createElement('span');
    operationalBadge.className = 'badge ' + operational.className;
    operationalBadge.textContent = operational.label;
    if (operational.title) operationalBadge.title = operational.title;

    actions.append(ownership, operationalBadge);

    if (item.resumeEligibility === 'same_profile_candidate' && item.accountId) {
      const resume = document.createElement('button');
      resume.className = 'secondary small';
      resume.textContent = 'Resume now';
      resume.onclick = () => resumeTaskNow(item, resume);

      const scheduleWrap = document.createElement('div');
      scheduleWrap.className = 'task-resume-controls';
      const when = document.createElement('input');
      when.type = 'datetime-local';
      when.className = 'task-resume-time';
      when.value = defaultTaskScheduleValue();

      const schedule = document.createElement('button');
      schedule.className = 'secondary small';
      schedule.textContent = 'Schedule';
      schedule.onclick = () => scheduleTaskAt(item, when.value);

      const reset = document.createElement('button');
      reset.className = 'secondary small';
      reset.textContent = 'At reset';
      reset.title = 'Use the selected account current Codex rate-limit reset time plus the configured grace period.';
      reset.onclick = () => scheduleTaskAtReset(item, reset);

      scheduleWrap.append(when, schedule, reset);
      actions.append(resume, scheduleWrap);
    } else {
      const disabled = document.createElement('button');
      disabled.className = 'secondary small';
      disabled.disabled = true;
      if (item.resumeEligibility === 'account_mismatch') {
        disabled.textContent = 'Reconnect matching account';
        disabled.title = 'The task creator does not match the ChatGPT account currently connected to this PingGPT profile.';
      } else if (item.resumeEligibility === 'ownership_unverified') {
        disabled.textContent = 'Ownership unverified';
        disabled.title = 'PingGPT could not verify task ownership, so resume and scheduling are disabled.';
      } else {
        disabled.textContent = 'Cross-account unavailable';
        disabled.title = 'Legacy / Global tasks cannot be resumed through an isolated account store.';
      }
      actions.append(disabled);
    }

    row.append(copy, actions);
    root.append(row);
  });

  data.errors
    .filter((entry) => taskAccountFilter === 'all'
      || (taskAccountFilter === 'legacy' && entry.source === 'legacy_global')
      || entry.accountId === taskAccountFilter)
    .forEach((entry) => {
      const error = document.createElement('div');
      error.className = 'task-source-error';
      const title = document.createElement('strong');
      title.textContent = entry.accountLabel;
      const detail = document.createElement('small');
      detail.textContent = entry.detail;
      error.append(title, detail);
      root.append(error);
    });

  renderTaskResumeSchedules(snapshot?.preferences?.taskResumeSchedules || []);
}

async function refreshTasks(options = {}) {
  const button = $("refresh-tasks");
  const summary = $("task-inventory-summary");
  const quiet = options.quiet === true;
  if (button) button.disabled = true;
  if (summary) summary.textContent = "Reading fresh Codex task and account state…";
  try {
    const data = await window.automode.getTaskInventory();
    renderTaskInventory(data);
    renderTaskResumeSchedules(snapshot?.preferences?.taskResumeSchedules || []);
    if (!quiet && options.source === "manual") {
      showBanner("Tasks and connected account state refreshed.");
    }
    return data;
  } catch (error) {
    $("codex-task-list").replaceChildren();
    if (summary) summary.textContent = "Task inventory failed.";
    if (!quiet) showBanner(`Could not load tasks: ${error.message || error}`, true);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

document.querySelectorAll('.nav').forEach((button) => button.onclick = () => {
  document.querySelectorAll('.nav,.page').forEach((el) => el.classList.remove('active'));
  button.classList.add('active');
  $('page-' + button.dataset.page).classList.add('active');
  $('page-title').textContent = button.textContent;
  syncAccountFilterHeader(button.dataset.page);
  if (button.dataset.page === 'logs') refreshLog();
  if (button.dataset.page === 'tasks') refreshTasks({ source: "page-open", quiet: true });
  if (button.dataset.page === 'automation') renderAutomationAccountTabs(readAccounts());
});

$("add-account").onclick = async () => {
  const button = $("add-account");
  button.disabled = true;
  try {
    const account = await window.automode.newAccountProfile();
    const currentCount = $("account-list").querySelectorAll(".account-card").length;
    account.displayName = `GPT Account ${currentCount + 1}`;
    $("account-list").append(accountCard(account, false));
    ensureEmptyAccountsMessage();
    renderAutomationAccountTabs(readAccounts());
    showBanner("Account profile added. Save changes or press Connect to save and start login.");
  } catch (error) {
    showBanner(`Could not add account: ${error.message || error}`, true);
  } finally {
    button.disabled = false;
  }
};

$("save").onclick = async () => {
  try { await saveChanges(true); }
  catch (error) { showBanner(`Could not save: ${error.message || error}`, true); }
};
$("auto-ping").onchange = () => showBanner("Save changes to apply the scheduler state.");
$("run-at-login").onchange = async (event) => {
  try { render(await window.automode.setRunAtLogin(event.target.checked)); showBanner("Startup setting updated."); }
  catch (error) { showBanner(String(error), true); }
};
$("exit").addEventListener("click", () => {
  window.automode.rendererEvent("EXIT_GUI_01_RENDERER_CLICK");
  window.automode.quit();
});
$("run-doctor").onclick = async () => {
  const results = await window.automode.doctor();
  const root = $("doctor-results");
  root.replaceChildren();
  results.forEach((check) => {
    const row = document.createElement("div");
    row.className = "check";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    title.textContent = check.name;
    detail.textContent = check.detail;
    copy.append(title, detail);
    const state = document.createElement("span");
    state.className = check.ok ? "ok" : "bad";
    state.textContent = check.ok ? "PASS" : "CHECK";
    row.append(copy, state);
    root.append(row);
  });
};
$("export-diagnostic").onclick = async () => {
  const button = $("export-diagnostic");
  const resultText = $("diagnostic-result");
  button.disabled = true;
  button.textContent = "진단 로그 저장 중...";
  resultText.textContent = "";
  try {
    const result = await window.automode.exportDiagnostic();
    if (result.ok) {
      const partial = result.status === "PARTIAL" ? " (일부 항목 수집 불가)" : "";
      resultText.textContent = `진단 로그 저장 완료${partial}\n${result.path}`;
      showBanner(`진단 로그 저장 완료${partial}`);
    } else {
      resultText.textContent = `진단 로그 저장 실패\n${result.error || "알 수 없는 오류"}`;
      showBanner("진단 로그 저장 실패", true);
    }
  } catch (error) {
    resultText.textContent = `진단 로그 저장 실패\n${error.message || error}`;
    showBanner("진단 로그 저장 실패", true);
  } finally {
    button.disabled = false;
    button.textContent = "진단 로그 저장";
  }
};
$("refresh-tasks").onclick = () => refreshTasks({ source: "manual" });
$("task-search").oninput = (event) => {
  taskSearchQuery = String(event.target.value || '');
  if (taskInventorySnapshot) renderTaskInventory(taskInventorySnapshot);
};

async function refreshLog() { $("log-content").textContent = await window.automode.readLog(); }
$("refresh-log").onclick = refreshLog;
$("open-log").onclick = () => window.automode.openLogFolder();

window.addEventListener("error", () => window.automode.rendererEvent("RENDERER_ERROR"));
window.addEventListener("unhandledrejection", () => window.automode.rendererEvent("RENDERER_UNHANDLED_REJECTION"));
syncAccountFilterHeader(document.querySelector('.nav.active')?.dataset.page || 'overview');
window.automode.getSnapshot().then(render).catch((error) => showBanner('Startup failed: ' + (error.message || error), true));
window.automode.rendererReady();
