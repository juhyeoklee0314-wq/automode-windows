const $ = (id) => document.getElementById(id);
let snapshot;

function showBanner(message, error = false) {
  const el = $("banner");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 5000);
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
  $("ping-agent").value = c.ping.agent;
  $("ping-message").value = c.ping.message;
  $("catchup").value = c.ping.catchup_minutes;
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
  } else { $("next-ping").textContent = "—"; $("next-detail").textContent = "No schedule configured"; }
  for (const agent of ["claude", "codex"]) {
    const found = data.agents[agent];
    $(`${agent}-path`).textContent = found || "Not found on PATH";
    $(`${agent}-badge`).textContent = found ? "READY" : "MISSING";
    $(`${agent}-badge`).classList.toggle("ok", Boolean(found));
  }
  renderTimes(c.ping.times);
  const tasks = $("task-list");
  tasks.replaceChildren();
  if (!data.scheduler.length) tasks.innerHTML = '<p class="muted">No GUI scheduler tasks installed.</p>';
  data.scheduler.forEach((task) => {
    const row = document.createElement("div"); row.className = "task";
    row.innerHTML = `<div><strong>${escapeHtml(task.time)}</strong><small>${escapeHtml(task.name)}</small></div><span class="badge ${task.enabled ? "ok" : ""}">${task.enabled ? "ENABLED" : task.installed ? "DISABLED" : "MISSING"}</span>`;
    tasks.append(row);
  });
}

function escapeHtml(value) { const div = document.createElement("div"); div.textContent = String(value); return div.innerHTML; }
function renderTimes(times) {
  const root = $("times"); root.replaceChildren();
  times.forEach((time, index) => {
    const row = document.createElement("div"); row.className = "time-row";
    const input = document.createElement("input"); input.type = "time"; input.value = time; input.dataset.index = String(index);
    const remove = document.createElement("button"); remove.className = "remove"; remove.textContent = "Remove";
    remove.onclick = () => { const values = readTimes(); values.splice(index, 1); renderTimes(values); };
    row.append(input, remove); root.append(row);
  });
}
function readTimes() { return [...$("times").querySelectorAll('input[type="time"]')].map((input) => input.value).filter(Boolean); }

async function save() {
  const config = structuredClone(snapshot.config);
  const preferences = structuredClone(snapshot.preferences);
  config.auto_continue = $("auto-continue").checked;
  config.continue_message = $("continue-message").value.trim() || "continue";
  config.grace_seconds = Number($("grace").value);
  config.idle_guard_seconds = Number($("idle-guard").value);
  config.ping.enabled = $("auto-ping").checked;
  config.ping.agent = $("ping-agent").value;
  config.ping.message = $("ping-message").value;
  config.ping.catchup_minutes = Number($("catchup").value);
  config.ping.times = readTimes();
  preferences.schedulerEnabled = $("auto-ping").checked;
  const defaultAccount = preferences.accounts.find((account) => account.id === "default") || preferences.accounts[0];
  if (defaultAccount) { defaultAccount.agent = config.ping.agent; defaultAccount.message = config.ping.message; defaultAccount.schedules = [...config.ping.times]; }
  try { render(await window.automode.save({ config, preferences })); showBanner("Settings saved."); }
  catch (error) { showBanner(`Could not save: ${error.message || error}`, true); }
}

document.querySelectorAll(".nav").forEach((button) => button.onclick = () => {
  document.querySelectorAll(".nav,.page").forEach((el) => el.classList.remove("active"));
  button.classList.add("active");
  $(`page-${button.dataset.page}`).classList.add("active");
  $("page-title").textContent = button.textContent;
  if (button.dataset.page === "logs") refreshLog();
});
$("add-time").onclick = () => renderTimes([...readTimes(), "09:00"]);
$("save").onclick = save;
$("auto-ping").onchange = () => showBanner("Save changes to apply the scheduler state.");
$("run-at-login").onchange = async (event) => { try { render(await window.automode.setRunAtLogin(event.target.checked)); showBanner("Startup setting updated."); } catch (error) { showBanner(String(error), true); } };
$("exit").addEventListener("click", () => {
  window.automode.rendererEvent("EXIT_GUI_01_RENDERER_CLICK");
  window.automode.quit();
});
$("run-doctor").onclick = async () => {
  const results = await window.automode.doctor(); const root = $("doctor-results"); root.replaceChildren();
  results.forEach((check) => { const row = document.createElement("div"); row.className = "check"; row.innerHTML = `<div><strong>${escapeHtml(check.name)}</strong><small>${escapeHtml(check.detail)}</small></div><span class="${check.ok ? "ok" : "bad"}">${check.ok ? "PASS" : "CHECK"}</span>`; root.append(row); });
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
