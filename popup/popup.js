/**
 * popup.js — extension popup controller.
 *
 * Responsibilities:
 * - Establish long-lived port to the service worker.
 * - Query the active tab's title; display it truncated.
 * - Show the correct UI panel based on extension state.
 * - Pre-open a FileSystemFileHandle via showSaveFilePicker on Start
 *   (while the click gesture is still active).
 * - Write the blob from IndexedDB into the pre-opened handle on BLOB_READY.
 * - Guard against accidental popup close during recording (beforeunload).
 */

'use strict';

// ─── Module-level state ───────────────────────────────────────────────────────

let port              = null;   // long-lived runtime port to SW
let currentState      = 'IDLE'; // mirrors SW state machine
let fileHandle        = null;   // FileSystemFileHandle opened at Stop time
let partialBlobKey    = null;   // stored when TAB_CLOSED arrives with a blob key
let activeTabId       = null;
let activeTabTitle    = '';
let recordingTabTitle = '';     // title of the tab being recorded (from SW)
let monitorOn         = true;   // whether tab audio plays to speakers

// ─── DOM references ───────────────────────────────────────────────────────────

const elTabTitle     = document.getElementById('tab-title');
const elTimer        = document.getElementById('timer');
const elSizeDisplay  = document.getElementById('size-display');
const elErrorText    = document.getElementById('error-text');
const elMicWarning   = document.getElementById('mic-warning');
const elCodecWarning = document.getElementById('codec-warning');

const btnStart       = document.getElementById('btn-start');
const btnStop        = document.getElementById('btn-stop');
const btnMonitor     = document.getElementById('btn-monitor');
const btnContinue    = document.getElementById('btn-continue');
const btnStopLimit   = document.getElementById('btn-stop-limit');
const btnMicYes      = document.getElementById('btn-mic-yes');
const btnMicNo       = document.getElementById('btn-mic-no');
const btnSavePartial = document.getElementById('btn-save-partial');
const btnDiscard     = document.getElementById('btn-discard');

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // 1. Connect long-lived port so SW can push STATE_UPDATE without polling
  port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener(handlePortMessage);

  // 2. Resolve the active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      activeTabId    = tabs[0].id;
      activeTabTitle = tabs[0].title || '';
      elTabTitle.textContent = truncate(activeTabTitle, 30);
      elTabTitle.title       = activeTabTitle;
    }
  });

  // 3. Fetch current state from SW (handles popup-reopen-mid-recording)
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (chrome.runtime.lastError) return; // SW may not yet be ready
    if (response) {
      // If recording is ongoing, show the recording tab title, not the current tab
      if (response.tabTitle && response.state !== 'IDLE') {
        elTabTitle.textContent = truncate(response.tabTitle, 30);
        elTabTitle.title       = response.tabTitle;
      }

      // Stash the recording tab title for use in filenames.
      if (response.tabTitle) recordingTabTitle = response.tabTitle;

      // A blob finished while popup was closed — recover via save dialog.
      if (response.pendingBlobKey) {
        handleBlobReady(response.pendingBlobKey, response.pendingSuggestedName);
        return;
      }

      renderState(response.state, response.elapsedSeconds, response.totalBytes);
    }
  });

  // 4. Wire up button handlers
  btnStart.addEventListener('click',       onStartClick);
  btnStop.addEventListener('click',        onStopClick);
  btnMonitor.addEventListener('click',     onMonitorClick);
  btnContinue.addEventListener('click',    onContinueClick);
  btnStopLimit.addEventListener('click',   onStopLimitClick);
  btnMicYes.addEventListener('click',      () => sendMsg({ type: 'MIC_ANSWER', include: true }));
  btnMicNo.addEventListener('click',       () => sendMsg({ type: 'MIC_ANSWER', include: false }));
  btnSavePartial.addEventListener('click', onSavePartialClick);
  btnDiscard.addEventListener('click',     onDiscardClick);
});

// ─── beforeunload guard ───────────────────────────────────────────────────────

window.addEventListener('beforeunload', (e) => {
  if (currentState === 'RECORDING' || currentState === 'LIMIT_PAUSED') {
    const msg = 'Recording is in progress. Stop recording before closing.';
    e.returnValue = msg;
    return msg;
  }
});

// ─── Port message handler ─────────────────────────────────────────────────────

function handlePortMessage(message) {
  switch (message.type) {
    case 'STATE_UPDATE':
      renderState(message.state, message.elapsedSeconds, message.totalBytes);
      break;

    case 'CONFIRM_MIC':
      renderState('CONFIRMING_MIC');
      break;

    case 'LIMIT_REACHED':
      renderState('LIMIT_PAUSED');
      break;

    case 'BLOB_READY':
      handleBlobReady(message.blobKey, message.suggestedName);
      break;

    case 'TAB_CLOSED':
      partialBlobKey = message.blobKey ?? null; // may be populated if SW sends it
      elErrorText.textContent =
        'The recorded tab was closed. Recording stopped.';
      renderState('ERROR');
      break;

    case 'MIC_UNAVAILABLE':
      showBannerTemporarily(elMicWarning, 4000);
      break;

    case 'CODEC_FALLBACK':
      elCodecWarning.hidden = false;
      break;

    case 'RECORDING_ERROR':
      elErrorText.textContent =
        `Recording error: ${message.error || 'Unknown error'}`;
      renderState('ERROR');
      break;

    default:
      console.warn('[popup] Unhandled port message:', message.type);
  }
}

// ─── Button handlers ──────────────────────────────────────────────────────────

function onStartClick() {
  if (!activeTabId) {
    console.error('[popup] No active tab ID');
    return;
  }
  // Save the recording tab title so Stop can use it for the filename.
  recordingTabTitle = activeTabTitle;
  sendMsg({ type: 'START_RECORDING', tabId: activeTabId, tabTitle: activeTabTitle });
}

async function onStopClick() {
  // Open the save picker during the Stop click (user gesture active).
  // The handle is stored; the blob arrives asynchronously and is written then.
  const suggestedName = buildFilename(recordingTabTitle || activeTabTitle, new Date());
  try {
    fileHandle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }],
    });
  } catch (err) {
    if (err.name === 'AbortError') return; // user cancelled — keep recording
    console.error('[popup] showSaveFilePicker error:', err);
    return;
  }
  sendMsg({ type: 'STOP_RECORDING' });
  renderState('SAVING');
}

function onMonitorClick() {
  monitorOn = !monitorOn;
  updateMonitorButton();
  sendMsg({ type: 'TOGGLE_MONITOR', on: monitorOn });
}

function onContinueClick() {
  sendMsg({ type: 'CONFIRM_CONTINUE' });
  renderState('RECORDING');
}

async function onStopLimitClick() {
  const suggestedName = buildFilename(recordingTabTitle || activeTabTitle, new Date());
  try {
    fileHandle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }],
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[popup] showSaveFilePicker error:', err);
    return;
  }
  sendMsg({ type: 'CONFIRM_STOP_AT_LIMIT' });
  renderState('SAVING');
}

async function onSavePartialClick() {
  // If we have a pre-opened handle, try to use it; otherwise open a new picker.
  if (!fileHandle) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: buildFilename('partial-recording', new Date()),
        types: [
          {
            description: 'WebM Video',
            accept: { 'video/webm': ['.webm'] },
          },
        ],
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[popup] showSaveFilePicker (partial) error:', err);
      return;
    }
  }

  if (partialBlobKey) {
    await handleBlobReady(partialBlobKey, buildFilename('partial-recording', new Date()));
    partialBlobKey = null;
  } else {
    // No blob key yet — the BLOB_READY message will arrive shortly and use fileHandle
    renderState('SAVING');
  }
}

async function onDiscardClick() {
  // Clean up any stored IndexedDB entry, then return to IDLE
  if (partialBlobKey) {
    try {
      await dbDelete(partialBlobKey);
    } catch {
      // Best-effort cleanup
    }
    partialBlobKey = null;
  }
  fileHandle = null;
  renderState('IDLE');
}

// ─── BLOB_READY handler ───────────────────────────────────────────────────────

async function handleBlobReady(blobKey, suggestedName) {
  renderState('SAVING');

  let blob;
  try {
    blob = await dbGet(blobKey);
    if (!blob) throw new Error('Blob not found in IndexedDB');
  } catch (err) {
    console.error('[popup] Failed to read blob from IndexedDB:', err);
    showRetryPrompt(blobKey, suggestedName);
    return;
  }

  // Write to the pre-opened file handle
  let success = false;
  if (fileHandle) {
    success = await writeToHandle(fileHandle, blob);
  }

  if (!success) {
    // fileHandle is gone or write failed — show retry prompt
    showRetryPrompt(blobKey, suggestedName);
    return;
  }

  // Clean up IndexedDB entry after successful write
  try {
    await dbDelete(blobKey);
  } catch (err) {
    console.warn('[popup] Failed to delete IndexedDB entry:', err);
  }

  fileHandle = null;
  renderState('IDLE');
}

/**
 * Write a Blob to a FileSystemFileHandle.
 * @returns {boolean} true on success, false on failure
 */
async function writeToHandle(handle, blob) {
  try {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    console.error('[popup] FileSystemFileHandle write failed:', err);
    return false;
  }
}

/**
 * Show a retry prompt when saving fails.
 * Lets the user pick a new location or give up.
 */
async function showRetryPrompt(blobKey, suggestedName) {
  const retry = window.confirm(
    'The recording was not saved. Would you like to try saving again?'
  );

  if (retry) {
    try {
      const newHandle = await window.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: 'WebM Video',
            accept: { 'video/webm': ['.webm'] },
          },
        ],
      });

      let blob;
      try {
        blob = await dbGet(blobKey);
        if (!blob) throw new Error('Blob not found');
      } catch (err) {
        console.error('[popup] Failed to re-read blob:', err);
        renderState('IDLE');
        return;
      }

      const success = await writeToHandle(newHandle, blob);
      if (success) {
        await dbDelete(blobKey).catch(() => {});
        fileHandle = null;
        renderState('IDLE');
      } else {
        alert('Recording was not saved.');
        await dbDelete(blobKey).catch(() => {});
        renderState('IDLE');
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[popup] Retry save picker error:', err);
      }
      // User cancelled picker — delete blob and return to IDLE
      await dbDelete(blobKey).catch(() => {});
      renderState('IDLE');
    }
  } else {
    // User declined retry
    window.alert('The recording was not saved.');
    await dbDelete(blobKey).catch(() => {});
    fileHandle = null;
    renderState('IDLE');
  }
}

// ─── State rendering ──────────────────────────────────────────────────────────

/**
 * Update the popup to reflect a state from the service worker state machine.
 *
 * @param {string} state
 * @param {number} [elapsedSeconds]
 * @param {number} [totalBytes]
 */
function renderState(state, elapsedSeconds = 0, totalBytes = 0) {
  const wasRecording = currentState === 'RECORDING';
  currentState = state;
  document.body.dataset.state = state;

  // Reset monitor toggle when a fresh recording begins.
  if (state === 'RECORDING' && !wasRecording) {
    monitorOn = true;
    updateMonitorButton();
  }

  if (elTimer) {
    elTimer.textContent = formatDuration(elapsedSeconds);
  }
  if (elSizeDisplay) {
    elSizeDisplay.textContent = formatBytes(totalBytes);
  }
}

function updateMonitorButton() {
  if (!btnMonitor) return;
  btnMonitor.textContent = monitorOn ? 'Tab audio: On' : 'Tab audio: Off';
  btnMonitor.classList.toggle('btn-monitor-on',  monitorOn);
  btnMonitor.classList.toggle('btn-monitor-off', !monitorOn);
}

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Format seconds into HH:MM:SS.
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/**
 * Format a byte count as a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Build a filesystem-safe filename from a tab title and a Date.
 * Mirrors the logic in service-worker.js (duplicated to avoid cross-context import).
 * @param {string} tabTitle
 * @param {Date}   date
 * @returns {string}
 */
function buildFilename(tabTitle, date) {
  const safe = (tabTitle || 'recording')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 60);
  const ts = date
    .toISOString()
    .slice(0, 19)
    .replace('T', '_')
    .replace(/:/g, '-');
  return `${safe}_${ts}.webm`;
}

/**
 * Truncate a string to `max` characters, appending '…' if needed.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + '…';
}

/**
 * Show a banner element for a given duration, then hide it again.
 * @param {HTMLElement} el
 * @param {number}      ms
 */
function showBannerTemporarily(el, ms) {
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, ms);
}

/**
 * Send a message to the service worker.
 * @param {object} message
 */
function sendMsg(message) {
  chrome.runtime.sendMessage(message).catch((err) => {
    console.warn('[popup] sendMessage error:', err);
  });
}

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tab-recorder-db', 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore('tab-recorder-blobs');
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('tab-recorder-blobs', 'readonly');
    const req = tx.objectStore('tab-recorder-blobs').get(key);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function dbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tab-recorder-blobs', 'readwrite');
    tx.objectStore('tab-recorder-blobs').delete(key);
    tx.oncomplete = resolve;
    tx.onerror    = (e) => reject(e.target.error);
  });
}
