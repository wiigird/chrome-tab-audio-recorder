const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const DEFAULT_TITLE = "탭 오디오 녹음기";
const PROJECT_URL = "https://github.com/wiigird/chrome-tab-audio-recorder";
let creatingOffscreenDocument = null;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA", "BLOBS"],
      justification: "선택한 탭의 오디오를 녹음하고 WebM 파일로 저장"
    });
  }

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function getRecorderStatus() {
  await ensureOffscreenDocument();
  try {
    return await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "GET_STATUS"
    });
  } catch {
    return { recording: false, state: "idle", elapsedMs: 0 };
  }
}

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

function waitForDownloadCompletion(downloadId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(listener);
      error ? reject(error) : resolve();
    };
    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") {
        finish();
      } else if (delta.state.current === "interrupted") {
        finish(new Error(delta.error?.current || "다운로드가 중단되었습니다."));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id: downloadId }).then((items) => {
      const item = items[0];
      if (item?.state === "complete") finish();
      if (item?.state === "interrupted") finish(new Error(item.error || "다운로드가 중단되었습니다."));
    }).catch(finish);
  });
}

function isCapturableTab(tab) {
  return Boolean(
    tab.id &&
    tab.url &&
    /^(https?|file):/i.test(tab.url)
  );
}

async function getCapturableTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter(isCapturableTab)
    .map((tab) => ({
      id: tab.id,
      title: tab.title || "제목 없는 탭",
      url: tab.url,
      audible: Boolean(tab.audible),
      active: Boolean(tab.active),
      windowId: tab.windowId
    }))
    .sort((a, b) => Number(b.audible) - Number(a.audible) || Number(b.active) - Number(a.active));
}

async function startRecording(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isCapturableTab(tab)) throw new Error("이 탭은 녹음할 수 없습니다.");

  const status = await getRecorderStatus();
  if (status.state !== "idle") throw new Error("이미 다른 탭을 녹음 중입니다.");

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  const result = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "START_RECORDING",
    streamId,
    tabId: tab.id,
    tabTitle: tab.title || "Chrome 탭"
  });

  if (!result?.ok) throw new Error(result?.error || "녹음을 시작하지 못했습니다.");
  await setBadge("REC", "#d93025", `녹음 중: ${tab.title || "Chrome 탭"}`);
  return getRecorderStatus();
}

async function controlRecording(type) {
  if (type === "RECOVER_RECORDING") {
    await setBadge("복구", "#1a73e8", "복구 녹음 파일 저장 중");
  }
  const result = await chrome.runtime.sendMessage({ target: "offscreen", type });
  if (!result?.ok) throw new Error(result?.error || "녹음 상태를 변경하지 못했습니다.");

  if (type === "PAUSE_RECORDING") {
    await setBadge("PAU", "#f9ab00", "녹음 일시정지됨");
  } else if (type === "RESUME_RECORDING") {
    await setBadge("REC", "#d93025", "녹음 중");
  } else if (type === "STOP_RECORDING") {
    await setBadge("저장", "#1a73e8", "녹음 파일 저장 중");
  } else if (type === "RECOVER_RECORDING") {
    await setBadge("", null, DEFAULT_TITLE);
  } else if (type === "DISCARD_RECOVERY") {
    await setBadge("", null, DEFAULT_TITLE);
  }
  return getRecorderStatus();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "service-worker") return false;

  (async () => {
    switch (message.type) {
      case "GET_TABS":
        return { ok: true, tabs: await getCapturableTabs() };
      case "GET_STATUS":
        return { ok: true, status: await getRecorderStatus() };
      case "START_RECORDING":
        return { ok: true, status: await startRecording(Number(message.tabId)) };
      case "PAUSE_RECORDING":
      case "RESUME_RECORDING":
      case "STOP_RECORDING":
      case "RECOVER_RECORDING":
      case "DISCARD_RECOVERY":
        return { ok: true, status: await controlRecording(message.type) };
      default:
        return { ok: false, error: "알 수 없는 요청입니다." };
    }
  })()
    .then(sendResponse)
    .catch((error) => {
      console.error(error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "service-worker-event") return false;

  if (message.type === "DOWNLOAD_RECORDING") {
    (async () => {
      try {
        const downloadId = await chrome.downloads.download({
          url: message.url,
          filename: `ZEP_Recordings/${message.filename}`,
          conflictAction: "uniquify",
          saveAs: false
        });
        await waitForDownloadCompletion(downloadId);
        await setBadge("", null, DEFAULT_TITLE);
        sendResponse({ ok: true, downloadId });
      } catch (error) {
        await setBadge("ERR", "#d93025", `저장 오류: ${error.message}`);
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === "RECORDING_ERROR") {
    setBadge("ERR", "#d93025", `녹음 오류: ${message.error || "알 수 없는 오류"}`);
    sendResponse({ ok: true });
  }
  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  setBadge("", null, DEFAULT_TITLE);

  if (details.reason === "install") {
    chrome.tabs.create({ url: PROJECT_URL });
  }
});
