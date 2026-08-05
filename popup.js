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
  if (!response?.ok) throw new Error(response?.error || "요청을 처리하지 못했습니다.");
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
  startButton.textContent = recoverable ? "복구 파일 저장" : "녹음 시작";
  pauseButton.textContent = state === "paused" ? "녹음 재개" : "일시정지";
  stopButton.textContent = recoverable ? "복구본 삭제" : "종료·저장";
  recordingTab.textContent = (active || recoverable) && currentStatus.tabTitle
    ? `${recoverable ? "복구 대상" : "대상"}: ${currentStatus.tabTitle}`
    : "";

  statusDot.className = "status-dot";
  if (state === "recording") {
    statusDot.classList.add("recording");
    statusLabel.textContent = "녹음 중";
  } else if (state === "paused") {
    statusDot.classList.add("paused");
    statusLabel.textContent = "일시정지";
  } else if (state === "stopping") {
    statusDot.classList.add("paused");
    statusLabel.textContent = "저장 중";
  } else if (state === "recovering") {
    statusDot.classList.add("paused");
    statusLabel.textContent = "복구 저장 중";
  } else if (state === "recoverable") {
    statusDot.classList.add("paused");
    statusLabel.textContent = "복구 가능";
  } else if (state === "starting") {
    statusDot.classList.add("paused");
    statusLabel.textContent = "시작 중";
  } else {
    statusDot.classList.add("idle");
    statusLabel.textContent = "대기 중";
  }
}

async function loadTabs() {
  const previousValue = tabSelect.value;
  const { tabs } = await send("GET_TABS");
  tabSelect.replaceChildren();

  if (!tabs.length) {
    const option = new Option("녹음 가능한 탭이 없습니다", "");
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
    if (!confirm("복구 가능한 녹음 데이터를 완전히 삭제할까요?")) return;
    perform(() => send("DISCARD_RECOVERY"));
  } else {
    perform(() => send("STOP_RECORDING"));
  }
});

async function initialize() {
  await Promise.all([loadTabs(), refreshStatus()]);
  pollingTimer = setInterval(refreshStatus, 1000);
}

window.addEventListener("unload", () => clearInterval(pollingTimer));
initialize().catch((error) => { message.textContent = error.message; });
