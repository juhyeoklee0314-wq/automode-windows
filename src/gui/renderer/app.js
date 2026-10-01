const $ = (id) => document.getElementById(id);
let snapshot;

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
  const card = document.createElement("div");
  card.className = `account-card${account.enabled ? "" : " disabled"}`;
  card.dataset.accountId = account.id;
  card.dataset.codexHome = account.codexHome || "";
  card.dataset.saved = saved ? "true" : "false";

  const head = document.createElement("div");
  head.className = "account-head";

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Profile name";
  const nameInput = document.createElement("input");
  nameInput.className = "account-name";
  nameInput.type = "text";
  nameInput.maxLength = 80;
  nameInput.value = account.displayName;
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
    card.remove();
    ensureEmptyAccountsMessage();
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
  catchupInput.value = String(account.catchupMinutes ?? snapshot?.config?.ping?.catchup_minutes ?? 30);
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
  wakeInput.checked = account.wakePc === true;
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
  authTitle.textContent = "ChatGPT account";
  const authPath = document.createElement("small");
  authPath.className = "account-auth-path";
  authPath.textContent = account.codexHome || "Default Codex profile (existing CLI login)";
  const authStatus = document.createElement("span");
  authStatus.className = "auth-status";
  authStatus.textContent = saved ? "CHECKING" : "SAVE TO CONNECT";
  authCopy.append(authTitle, authPath, authStatus);
  const connectButton = document.createElement("button");
  connectButton.className = "secondary small connect-account";
  connectButton.textContent = "Connect";
  connectButton.onclick = () => connectAccount(card);
  auth.append(authCopy, connectButton);

  const messageLabel = document.createElement("label");
  messageLabel.className = "account-message";
  messageLabel.textContent = "Ping message";
  const messageInput = document.createElement("textarea");
  messageInput.className = "account-message-input";
  messageInput.maxLength = 2000;
  messageInput.rows = 2;
  messageInput.value = account.message;
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
  (account.schedules || []).forEach((time) => addTimeRow(times, time));

  const updateVisibility = () => {
    card.classList.toggle("disabled", !enableInput.checked);
    auth.classList.toggle("hidden", agentSelect.value !== "codex");
  };
  enableInput.onchange = updateVisibility;
  agentSelect.onchange = updateVisibility;

  card.append(head, grid, auth, messageLabel, timesWrap);
  updateVisibility();
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
    refreshAuthStatus(account.id);
  });
}

function readAccounts() {
  return [...$("account-list").querySelectorAll(".account-card")].map((card, index) => {
    const schedules = [...card.querySelectorAll(".account-time")].map((input) => input.value).filter(Boolean);
    const displayName = card.querySelector(".account-name").value.trim() || `Profile ${index + 1}`;
    const codexHome = card.dataset.codexHome || undefined;
    return {
      id: card.dataset.accountId,
      displayName,
      enabled: card.querySelector(".account-enabled").checked,
      codexHome,
      message: card.querySelector(".account-message-input").value,
      schedules,
      agent: card.querySelector(".account-agent").value,
      catchupMinutes: clampNumber(card.querySelector(".account-catchup").value, 0, 180, 30),
      wakePc: card.querySelector(".account-wake").checked,
    };
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
  if (primary) {
    config.ping.agent = primary.agent;
    config.ping.message = primary.message;
    config.ping.times = [...primary.schedules];
    config.ping.catchup_minutes = primary.catchupMinutes;
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

function applyAuthStatus(status) {
  const el = authStatusElement(status.accountId);
  if (!el) return;
  el.classList.remove("ok", "bad");
  const card = [...$("account-list").querySelectorAll(".account-card")]
    .find((entry) => entry.dataset.accountId === status.accountId);
  const button = card?.querySelector(".connect-account");
  if (button) button.textContent = status.state === "connected" ? "Reconnect" : "Connect";
  if (status.state === "connected") {
    el.textContent = "CONNECTED";
    el.classList.add("ok");
  } else if (status.state === "login_started") {
    el.textContent = "LOGIN STARTED";
  } else if (status.state === "wrong_auth") {
    el.textContent = "NOT CHATGPT AUTH";
    el.classList.add("bad");
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
  }
}

async function refreshAuthStatus(accountId) {
  try {
    const status = await window.automode.getAccountAuthStatus(accountId);
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

async function pollAuthStatus(accountId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await refreshAuthStatus(accountId);
    if (!status || status.state === "connected" || status.state === "cli_missing") return;
  }
}

async function connectAccount(card) {
  const accountId = card.dataset.accountId;
  const button = card.querySelector(".connect-account");
  button.disabled = true;
  try {
    await saveChanges(false);
    const status = await window.automode.connectAccount(accountId);
    applyAuthStatus(status);
    showBanner(status.detail, ["cli_missing", "not_connected", "profile_missing"].includes(status.state));
    if (status.state === "login_started") pollAuthStatus(accountId);
  } catch (error) {
    showBanner(`Could not start account login: ${error.message || error}`, true);
  } finally {
    const current = [...$("account-list").querySelectorAll(".account-card")]
      .find((entry) => entry.dataset.accountId === accountId);
    const currentButton = current?.querySelector(".connect-account");
    if (currentButton) currentButton.disabled = false;
  }
}

document.querySelectorAll(".nav").forEach((button) => button.onclick = () => {
  document.querySelectorAll(".nav,.page").forEach((el) => el.classList.remove("active"));
  button.classList.add("active");
  $(`page-${button.dataset.page}`).classList.add("active");
  $("page-title").textContent = button.textContent;
  if (button.dataset.page === "logs") refreshLog();
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
async function refreshLog() { $("log-content").textContent = await window.automode.readLog(); }
$("refresh-log").onclick = refreshLog;
$("open-log").onclick = () => window.automode.openLogFolder();

window.addEventListener("error", () => window.automode.rendererEvent("RENDERER_ERROR"));
window.addEventListener("unhandledrejection", () => window.automode.rendererEvent("RENDERER_UNHANDLED_REJECTION"));
window.automode.getSnapshot().then(render).catch((error) => showBanner(`Startup failed: ${error.message || error}`, true));
window.automode.rendererReady();
