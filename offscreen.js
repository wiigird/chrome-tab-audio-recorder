const DB_NAME = "ChromeTabAudioRecorder";
const DB_VERSION = 1;
const SESSION_STORE = "sessions";
const CHUNK_STORE = "chunks";
const CHUNK_INTERVAL_MS = 5000;

let mediaRecorder = null;
let capturedStream = null;
let audioContext = null;
let monitorSource = null;
let recorderState = "idle";
let recordingStartedAt = 0;
let pausedAt = 0;
let totalPausedMs = 0;
let stoppedAt = 0;
let recordedTabId = null;
let recordedTabTitle = "Chrome 탭";
let currentSessionId = null;
let currentMimeType = "audio/webm";
let nextChunkIndex = 0;
let writeChain = Promise.resolve();
let recoverySession = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        const store = database.createObjectStore(CHUNK_STORE, { keyPath: ["sessionId", "index"] });
        store.createIndex("bySession", "sessionId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const databasePromise = openDatabase();

async function runTransaction(storeNames, mode, operation) {
  const database = await databasePromise;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map((name) => [name, transaction.objectStore(name)]));
    let result;
    try {
      result = operation(stores, transaction);
    } catch (error) {
      transaction.abort();
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("로컬 저장 작업이 중단되었습니다."));
  });
}

async function putSession(session) {
  await runTransaction([SESSION_STORE], "readwrite", ({ sessions }) => sessions.put(session));
}

async function patchSession(sessionId, patch) {
  const database = await databasePromise;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([SESSION_STORE], "readwrite");
    const store = transaction.objectStore(SESSION_STORE);
    const request = store.get(sessionId);
    request.onsuccess = () => {
      if (!request.result) return;
      store.put({ ...request.result, ...patch, updatedAt: Date.now() });
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function putChunk(sessionId, index, blob) {
  await runTransaction([CHUNK_STORE], "readwrite", ({ chunks }) => {
    chunks.put({ sessionId, index, blob, size: blob.size });
  });
}

async function getAllSessions() {
  const database = await databasePromise;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([SESSION_STORE], "readonly");
    const request = transaction.objectStore(SESSION_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function getSessionChunks(sessionId) {
  const database = await databasePromise;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([CHUNK_STORE], "readonly");
    const index = transaction.objectStore(CHUNK_STORE).index("bySession");
    const request = index.getAll(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
      resolve((request.result || []).sort((a, b) => a.index - b.index));
    };
    request.onerror = () => reject(request.error);
  });
}

async function deleteSessionData(sessionId) {
  const database = await databasePromise;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([SESSION_STORE, CHUNK_STORE], "readwrite");
    transaction.objectStore(SESSION_STORE).delete(sessionId);
    const chunkStore = transaction.objectStore(CHUNK_STORE);
    const cursorRequest = chunkStore.index("bySession").openKeyCursor(IDBKeyRange.only(sessionId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      chunkStore.delete(cursor.primaryKey);
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function loadRecoverySession() {
  const sessions = await getAllSessions();
  if (!sessions.length) return null;
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  for (const session of sessions) {
    const chunks = await getSessionChunks(session.id);
    if (chunks.length) {
      const elapsed = session.elapsedMs || Math.max(0, (session.updatedAt || session.startedAt) - session.startedAt - (session.totalPausedMs || 0));
      recoverySession = { ...session, elapsedMs: elapsed, chunkCount: chunks.length };
      await patchSession(session.id, { status: "recoverable", elapsedMs: elapsed });
      return recoverySession;
    }
    await deleteSessionData(session.id);
  }
  return null;
}

const recoveryReady = loadRecoverySession().catch((error) => {
  console.error("복구 데이터 확인 실패", error);
  return null;
});

function sanitizeFilename(value) {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return sanitized || "Chrome 탭";
}

function timestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function elapsedMs() {
  if (!recordingStartedAt) return recoverySession?.elapsedMs || 0;
  const end = recorderState === "paused" ? pausedAt : recorderState === "stopping" ? stoppedAt : Date.now();
  return Math.max(0, end - recordingStartedAt - totalPausedMs);
}

function chooseMimeType() {
  return ["audio/webm;codecs=opus", "audio/webm"]
    .find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function acquireTabAudio(streamId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });
}

async function keepAudioAudible(stream) {
  audioContext = new AudioContext();
  monitorSource = audioContext.createMediaStreamSource(stream);
  monitorSource.connect(audioContext.destination);
  if (audioContext.state === "suspended") await audioContext.resume();
}

async function cleanUpMedia() {
  if (monitorSource) {
    try { monitorSource.disconnect(); } catch {}
    monitorSource = null;
  }
  if (audioContext) {
    try { await audioContext.close(); } catch {}
    audioContext = null;
  }
  if (capturedStream) {
    capturedStream.getTracks().forEach((track) => track.stop());
    capturedStream = null;
  }
}

function resetActiveState() {
  mediaRecorder = null;
  recorderState = "idle";
  recordingStartedAt = 0;
  pausedAt = 0;
  totalPausedMs = 0;
  stoppedAt = 0;
  recordedTabId = null;
  currentSessionId = null;
  currentMimeType = "audio/webm";
  nextChunkIndex = 0;
  writeChain = Promise.resolve();
}

async function reportError(error) {
  const sessionId = currentSessionId;
  const savedElapsed = elapsedMs();
  await writeChain.catch(() => {});
  await cleanUpMedia();
  resetActiveState();

  if (sessionId) {
    await patchSession(sessionId, {
      status: "recoverable",
      elapsedMs: savedElapsed,
      error: error?.message || String(error)
    }).catch(() => {});
    recoverySession = (await getAllSessions()).find((item) => item.id === sessionId) || null;
  }

  try {
    await chrome.runtime.sendMessage({
      target: "service-worker-event",
      type: "RECORDING_ERROR",
      error: `${error?.message || String(error)}${recoverySession ? " · 저장된 구간은 복구할 수 있습니다." : ""}`
    });
  } catch {}
}

async function downloadBlob(blob, title, createdAt) {
  const extension = blob.type.includes("webm") ? "webm" : "audio";
  const filename = `${timestampForFilename(new Date(createdAt))}_${sanitizeFilename(title)}.${extension}`;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const result = await chrome.runtime.sendMessage({
      target: "service-worker-event",
      type: "DOWNLOAD_RECORDING",
      url: objectUrl,
      filename
    });
    if (!result?.ok) throw new Error(result?.error || "다운로드를 시작하지 못했습니다.");
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  }
}

async function assembleAndDownload(session) {
  const records = await getSessionChunks(session.id);
  if (!records.length) throw new Error("복구할 오디오 조각이 없습니다.");
  const blob = new Blob(records.map((record) => record.blob), { type: session.mimeType || "audio/webm" });
  if (!blob.size) throw new Error("녹음된 오디오 데이터가 없습니다.");
  await downloadBlob(blob, session.tabTitle, session.createdAt);
  await deleteSessionData(session.id);
}

async function finishRecording() {
  const sessionId = currentSessionId;
  const finalElapsed = elapsedMs();
  await writeChain;
  await patchSession(sessionId, { status: "saving", elapsedMs: finalElapsed });
  const sessions = await getAllSessions();
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error("저장할 녹음 세션을 찾지 못했습니다.");

  await cleanUpMedia();
  try {
    await assembleAndDownload(session);
    recoverySession = null;
    resetActiveState();
  } catch (error) {
    await patchSession(sessionId, { status: "recoverable", elapsedMs: finalElapsed, error: error.message });
    recoverySession = { ...session, status: "recoverable", elapsedMs: finalElapsed };
    resetActiveState();
    throw error;
  }
}

async function startRecording(message) {
  await recoveryReady;
  if (recoverySession) throw new Error("먼저 이전 녹음을 복구하거나 삭제해 주세요.");
  if (recorderState !== "idle") throw new Error("이미 녹음 중입니다.");

  recorderState = "starting";
  recordedTabId = message.tabId;
  recordedTabTitle = message.tabTitle || "Chrome 탭";
  currentSessionId = crypto.randomUUID();
  nextChunkIndex = 0;
  writeChain = Promise.resolve();

  try {
    capturedStream = await acquireTabAudio(message.streamId);
    if (capturedStream.getAudioTracks().length === 0) {
      throw new Error("선택한 탭에서 오디오 스트림을 찾지 못했습니다.");
    }
    await keepAudioAudible(capturedStream);

    const options = { audioBitsPerSecond: 64000 };
    const mimeType = chooseMimeType();
    if (mimeType) options.mimeType = mimeType;
    mediaRecorder = new MediaRecorder(capturedStream, options);
    currentMimeType = mediaRecorder.mimeType || "audio/webm";
    recordingStartedAt = Date.now();
    pausedAt = 0;
    totalPausedMs = 0;
    stoppedAt = 0;

    await putSession({
      id: currentSessionId,
      status: "recording",
      tabId: recordedTabId,
      tabTitle: recordedTabTitle,
      mimeType: currentMimeType,
      createdAt: recordingStartedAt,
      startedAt: recordingStartedAt,
      updatedAt: recordingStartedAt,
      totalPausedMs: 0,
      elapsedMs: 0
    });

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (!event.data?.size || !currentSessionId) return;
      const sessionId = currentSessionId;
      const index = nextChunkIndex++;
      const blob = event.data;
      writeChain = writeChain
        .then(() => putChunk(sessionId, index, blob))
        .then(() => patchSession(sessionId, { status: recorderState, elapsedMs: elapsedMs(), totalPausedMs }))
        .catch((error) => setTimeout(() => reportError(error), 0));
    });
    mediaRecorder.addEventListener("stop", () => finishRecording().catch(reportError), { once: true });
    mediaRecorder.addEventListener("error", (event) => {
      reportError(event.error || new Error("MediaRecorder 오류가 발생했습니다."));
    }, { once: true });
    capturedStream.getAudioTracks()[0].addEventListener("ended", () => {
      if (["recording", "paused"].includes(recorderState)) stopRecording().catch(reportError);
    }, { once: true });

    mediaRecorder.start(CHUNK_INTERVAL_MS);
    recorderState = "recording";
  } catch (error) {
    await reportError(error);
    throw error;
  }
}

async function pauseRecording() {
  if (!mediaRecorder || recorderState !== "recording") throw new Error("일시정지할 녹음이 없습니다.");
  mediaRecorder.pause();
  pausedAt = Date.now();
  recorderState = "paused";
  await patchSession(currentSessionId, { status: "paused", elapsedMs: elapsedMs(), totalPausedMs });
}

async function resumeRecording() {
  if (!mediaRecorder || recorderState !== "paused") throw new Error("재개할 녹음이 없습니다.");
  totalPausedMs += Date.now() - pausedAt;
  pausedAt = 0;
  mediaRecorder.resume();
  recorderState = "recording";
  await patchSession(currentSessionId, { status: "recording", elapsedMs: elapsedMs(), totalPausedMs });
}

async function stopRecording() {
  if (!mediaRecorder || !["recording", "paused"].includes(recorderState)) {
    throw new Error("진행 중인 녹음이 없습니다.");
  }
  stoppedAt = Date.now();
  if (recorderState === "paused") {
    totalPausedMs += stoppedAt - pausedAt;
    pausedAt = 0;
  }
  recorderState = "stopping";
  await patchSession(currentSessionId, { status: "stopping", elapsedMs: elapsedMs(), totalPausedMs });
  mediaRecorder.stop();
}

async function recoverRecording() {
  await recoveryReady;
  if (!recoverySession) throw new Error("복구 가능한 녹음이 없습니다.");
  recorderState = "recovering";
  const session = recoverySession;
  await patchSession(session.id, { status: "recovering" });
  try {
    await assembleAndDownload(session);
    recoverySession = null;
    resetActiveState();
  } catch (error) {
    recorderState = "idle";
    await patchSession(session.id, { status: "recoverable", error: error.message });
    throw error;
  }
}

async function discardRecovery() {
  await recoveryReady;
  if (!recoverySession) throw new Error("삭제할 복구 데이터가 없습니다.");
  await deleteSessionData(recoverySession.id);
  recoverySession = null;
  resetActiveState();
}

async function getStatus() {
  await recoveryReady;
  if (recoverySession && recorderState === "idle") {
    return {
      recording: false,
      state: "recoverable",
      elapsedMs: recoverySession.elapsedMs || 0,
      tabId: recoverySession.tabId,
      tabTitle: recoverySession.tabTitle,
      chunkCount: recoverySession.chunkCount || 0
    };
  }
  return {
    recording: ["recording", "paused"].includes(recorderState),
    state: recorderState,
    elapsedMs: elapsedMs(),
    tabId: recordedTabId,
    tabTitle: recordedTabTitle
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  const actions = {
    GET_STATUS: () => getStatus(),
    START_RECORDING: () => startRecording(message).then(() => ({ ok: true })),
    PAUSE_RECORDING: () => pauseRecording().then(() => ({ ok: true })),
    RESUME_RECORDING: () => resumeRecording().then(() => ({ ok: true })),
    STOP_RECORDING: () => stopRecording().then(() => ({ ok: true })),
    RECOVER_RECORDING: () => recoverRecording().then(() => ({ ok: true })),
    DISCARD_RECOVERY: () => discardRecovery().then(() => ({ ok: true }))
  };
  const action = actions[message.type];
  if (!action) return false;

  Promise.resolve()
    .then(action)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
