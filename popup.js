const tabSelect = document.querySelector("#tabSelect");
const refreshTabsButton = document.querySelector("#refreshTabs");
const startButton = document.querySelector("#startButton");
const pauseButton = document.querySelector("#pauseButton");
const stopButton = document.querySelector("#stopButton");
const statusDot = document.querySelector("#statusDot");
const statusLabel = document.querySelector("#statusLabel");
const timer = document.querySelector("#timer");
const recordingTab = document.querySelector("#recordingTab");
const message = document.querySelector("#message");

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function localizeStaticText() {
  document.documentElement.lang = chrome.i18n.getMessage("@@ui_locale") || "ko";
  document.title = t("extName");
  document.querySelector("#heading").textContent = t("popupTitle");
  refreshTabsButton.title = t("refreshTabs");
  document.querySelector("#tabSelectLabel").textContent = t("tabLabel");
  document.querySelector("#tabHint").textContent = t("tabHint");
  document.querySelector("#saveLocation").textContent = t("saveLocation");
}

let currentStatus = { state: "idle", elapsedMs: 0 };
let pollingTimer = null;

function formatTime(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ target: "service-worker", type, ...extra });
  if (!response?.ok) throw new Error(response?.error || t("requestFailed"));
  return response;
}

function renderStatus(status) {
  currentStatus = status || { state: "idle", elapsedMs: 0 };
  const state = currentStatus.state;
  const active = ["recording", "paused", "starting", "stopping", "recovering"].includes(state);
  const recoverable = state === "recoverable";

  timer.textContent = formatTime(currentStatus.elapsedMs || 0);
  tabSelect.disabled = active || recoverable;
  refreshTabsButton.disabled = active || recoverable;
  startButton.disabled = active || (!recoverable && !tabSelect.value);
  pauseButton.disabled = !["recording", "paused"].includes(state);
  stopButton.disabled = !["recording", "paused", "recoverable"].includes(state);
  startButton.textContent = recoverable ? t("recoverSave") : t("startRecording");
  pauseButton.textContent = state === "paused" ? t("resumeRecording") : t("pauseRecording");
  stopButton.textContent = recoverable ? t("discardRecovery") : t("stopAndSave");
  recordingTab.textContent = (active || recoverable) && currentStatus.tabTitle
    ? `${recoverable ? t("recoveryTarget") : t("recordingTarget")}: ${currentStatus.tabTitle}`
    : "";

  statusDot.className = "status-dot";
  if (state === "recording") {
    statusDot.classList.add("recording");
    statusLabel.textContent = t("statusRecording");
  } else if (state === "paused") {
    statusDot.classList.add("paused");
    statusLabel.textContent = t("statusPaused");
  } else if (state === "stopping") {
    statusDot.classList.add("paused");
    statusLabel.textContent = t("statusSaving");
  } else if (state === "recovering") {
    statusDot.classList.add("paused");
    statusLabel.textContent = t("statusRecovering");
  } else if (state === "recoverable") {
    statusDot.classList.add("paused");
    statusLabel.textContent = t("statusRecoverable");
  } else if (state === "starting") {
    statusDot.classList.add("paused");
    statusLabel.textContent = t("statusStarting");
  } else {
    statusDot.classList.add("idle");
    statusLabel.textContent = t("statusIdle");
  }
}

async function loadTabs() {
  const previousValue = tabSelect.value;
  const { tabs } = await send("GET_TABS");
  tabSelect.replaceChildren();

  if (!tabs.length) {
    const option = new Option(t("noCapturableTabs"), "");
    tabSelect.add(option);
    startButton.disabled = true;
    return;
  }

  for (const tab of tabs) {
    const prefix = tab.audible ? "🔊 " : tab.active ? "● " : "";
    const option = new Option(`${prefix}${tab.title}`, String(tab.id));
    option.title = tab.url;
    tabSelect.add(option);
  }

  const stillExists = [...tabSelect.options].some((option) => option.value === previousValue);
  if (stillExists) tabSelect.value = previousValue;
}

async function refreshStatus() {
  try {
    const { status } = await send("GET_STATUS");
    renderStatus(status);
    message.textContent = "";
  } catch (error) {
    message.textContent = error.message;
  }
}

async function perform(action) {
  try {
    message.textContent = "";
    const response = await action();
    if (response?.status) renderStatus(response.status);
  } catch (error) {
    message.textContent = error.message;
  }
}

refreshTabsButton.addEventListener("click", () => perform(loadTabs));
tabSelect.addEventListener("change", () => renderStatus(currentStatus));
startButton.addEventListener("click", () => perform(() => send(
  currentStatus.state === "recoverable" ? "RECOVER_RECORDING" : "START_RECORDING",
  { tabId: tabSelect.value }
)));
pauseButton.addEventListener("click", () => perform(() => send(currentStatus.state === "paused" ? "RESUME_RECORDING" : "PAUSE_RECORDING")));
stopButton.addEventListener("click", () => {
  if (currentStatus.state === "recoverable") {
    if (!confirm(t("discardRecoveryConfirm"))) return;
    perform(() => send("DISCARD_RECOVERY"));
  } else {
    perform(() => send("STOP_RECORDING"));
  }
});

async function initialize() {
  localizeStaticText();
  await Promise.all([loadTabs(), refreshStatus()]);
  pollingTimer = setInterval(refreshStatus, 1000);
}

window.addEventListener("unload", () => clearInterval(pollingTimer));
initialize().catch((error) => { message.textContent = error.message; });
