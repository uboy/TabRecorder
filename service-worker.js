/**
 * Service Worker — coordinator and state machine.
 *
 * Does not touch any media APIs. Owns the canonical extension state,
 * routes messages between popup ↔ offscreen ↔ content script, and
 * monitors tab lifecycle.
 *
 * State machine:
 *   IDLE → CONFIRMING_MIC → RECORDING → LIMIT_PAUSED → SAVING → IDLE
 *                        ↘ (no mic)  ↗
 */

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {'IDLE'|'CONFIRMING_MIC'|'RECORDING'|'LIMIT_PAUSED'|'SAVING'} */
let state = 'IDLE';

// Cached values from the last STATE_UPDATE (served to popup on GET_STATE)
let cachedElapsedSeconds = 0;
let cachedTotalBytes     = 0;

// Long-lived port to the popup (null when popup is closed)
let popupPort = null;

// The tab being recorded (for onRemoved detection)
let recordingTabId = null;

// The tab title (preserved for re-use if popup re-opens during recording)
let recordingTabTitle = '';

// Pending mic-answer state: we need to know tabId/tabTitle when MIC_ANSWER arrives
let pendingTabId    = null;
let pendingTabTitle = '';

// Blob that finished while the popup was closed — delivered on next popup open
let pendingBlobKey       = null;
let pendingSuggestedName = '';

// ─── Keepalive alarm ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
});

// The alarm fires to wake the service worker; no additional action needed.
chrome.alarms.onAlarm.addListener((_alarm) => {
  // intentional no-op: waking the SW is sufficient
});

// ─── Long-lived popup port ───────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;

  popupPort = port;

  // If a blob finished while the popup was closed, deliver it now.
  if (pendingBlobKey) {
    port.postMessage({ type: 'BLOB_READY', blobKey: pendingBlobKey, suggestedName: pendingSuggestedName });
    pendingBlobKey       = null;
    pendingSuggestedName = '';
  }

  port.onDisconnect.addListener(() => {
    popupPort = null;
    // Recording intentionally continues in the offscreen document after
    // the popup closes — the user can reopen the popup to stop it.
  });
});

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages from the offscreen document are routed to the popup
  if (message.target === 'sw' || isOffscreenMessage(message.type)) {
    handleOffscreenMessage(message);
    return false;
  }

  // All other messages originate from popup or content script
  switch (message.type) {
    case 'START_RECORDING':
      handleStartRecording(message.tabId, message.tabTitle);
      break;

    case 'MIC_PERMISSION_STATE':
      handleMicPermissionState(message.state);
      break;

    case 'MIC_ANSWER':
      handleMicAnswer(message.include);
      break;

    case 'STOP_RECORDING':
      if (state === 'RECORDING' || state === 'LIMIT_PAUSED') {
        sendToOffscreen({ type: 'STOP_MEDIA', target: 'offscreen' });
        setState('SAVING');
      }
      break;

    case 'GET_STATE':
      sendResponse({
        state,
        elapsedSeconds:      cachedElapsedSeconds,
        totalBytes:          cachedTotalBytes,
        tabTitle:            recordingTabTitle,
        pendingBlobKey,
        pendingSuggestedName,
      });
      return true; // keep sendResponse channel open

    case 'CONFIRM_CONTINUE':
      if (state === 'LIMIT_PAUSED') {
        sendToOffscreen({ type: 'CONFIRM_CONTINUE', target: 'offscreen' });
        setState('RECORDING');
      }
      break;

    case 'CONFIRM_STOP_AT_LIMIT':
      if (state === 'LIMIT_PAUSED') {
        sendToOffscreen({ type: 'CONFIRM_STOP_AT_LIMIT', target: 'offscreen' });
        setState('SAVING');
      }
      break;

    case 'TOGGLE_MONITOR':
      sendToOffscreen({ type: message.on ? 'MONITOR_ON' : 'MONITOR_OFF', target: 'offscreen' });
      break;

    default:
      console.warn('[SW] Unknown message type:', message.type);
  }

  return false;
});

// ─── Tab removal detection ────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== recordingTabId) return;
  if (state !== 'RECORDING' && state !== 'LIMIT_PAUSED') return;

  console.log('[SW] Recorded tab closed; interrupting recording.');
  sendToOffscreen({ type: 'TAB_CLOSED_INTERRUPT', target: 'offscreen' });
  sendToPopup({ type: 'TAB_CLOSED' });
  setState('SAVING');
});

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleStartRecording(tabId, tabTitle) {
  pendingTabId    = tabId;
  pendingTabTitle = tabTitle;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content-script.js'],
    });
  } catch (err) {
    // Cannot inject into chrome:// pages or other restricted origins.
    // Send a synthetic 'denied' state so recording falls back to tab-only.
    console.warn('[SW] Could not inject content script:', err.message);
    handleMicPermissionState('denied');
  }
}

function handleMicPermissionState(permState) {
  if (permState === 'granted') {
    setState('CONFIRMING_MIC');
    sendToPopup({ type: 'CONFIRM_MIC' });
  } else {
    // Skip mic dialog — proceed directly to capture
    startCapture(pendingTabId, pendingTabTitle, false);
  }
}

function handleMicAnswer(include) {
  startCapture(pendingTabId, pendingTabTitle, include);
}

function handleOffscreenMessage(message) {
  switch (message.type) {
    case 'STATE_UPDATE':
      cachedElapsedSeconds = message.elapsedSeconds;
      cachedTotalBytes     = message.totalBytes;
      sendToPopup(message);
      break;

    case 'LIMIT_REACHED':
      setState('LIMIT_PAUSED');
      sendToPopup(message);
      break;

    case 'BLOB_READY':
      setState('IDLE');
      recordingTabId    = null;
      recordingTabTitle = '';
      if (popupPort) {
        sendToPopup(message);
      } else {
        // Popup is closed — stash the key; deliver when popup next opens.
        pendingBlobKey       = message.blobKey;
        pendingSuggestedName = message.suggestedName || '';
      }
      break;

    case 'TAB_CLOSED':
      sendToPopup(message);
      break;

    case 'MIC_UNAVAILABLE':
    case 'CODEC_FALLBACK':
      sendToPopup(message);
      break;

    case 'CAPTURE_ERROR':
    case 'RECORDER_ERROR':
    case 'BLOB_READY_ERROR':
      console.error('[SW] Offscreen error:', message.type, message.error);
      setState('IDLE');
      sendToPopup({ type: 'RECORDING_ERROR', error: message.error });
      break;

    default:
      console.warn('[SW] Unhandled offscreen message:', message.type);
  }
}

// ─── startCapture ─────────────────────────────────────────────────────────────

async function startCapture(tabId, tabTitle, includeMic) {
  recordingTabId    = tabId;
  recordingTabTitle = tabTitle;

  // Ensure the offscreen document is READY before calling getMediaStreamId.
  // Stream IDs have a short validity window — minimising the delay between
  // getMediaStreamId() and the getUserMedia() call inside the offscreen doc
  // is critical. Creating the document first means it is already listening
  // by the time the stream ID arrives.
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    console.error('[SW] Failed to create offscreen document:', err);
    setState('IDLE');
    sendToPopup({ type: 'RECORDING_ERROR', error: err.message });
    return;
  }

  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      const errMsg = chrome.runtime.lastError?.message ?? 'getMediaStreamId failed';
      console.error('[SW] tabCapture.getMediaStreamId error:', errMsg);
      setState('IDLE');
      sendToPopup({ type: 'RECORDING_ERROR', error: errMsg });
      return;
    }

    console.log('[SW] Got stream ID, sending START_MEDIA to offscreen.');

    const suggestedName = buildFilename(tabTitle, new Date());

    sendToOffscreen({
      type: 'START_MEDIA',
      target: 'offscreen',
      streamId,
      includeMic,
      suggestedName,
    });

    setState('RECORDING');

    // Immediately notify the popup so it shows RECORDING state and the
    // Stop button without waiting for the first STATE_UPDATE tick (1 s).
    sendToPopup({ type: 'STATE_UPDATE', state: 'RECORDING', elapsedSeconds: 0, totalBytes: 0 });
  });
}

// ─── Offscreen document lifecycle ────────────────────────────────────────────

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Tab recording pipeline: getUserMedia, AudioContext, MediaRecorder',
    });
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function setState(newState) {
  state = newState;
  const isActive = newState === 'RECORDING' || newState === 'LIMIT_PAUSED';
  chrome.action.setBadgeText({ text: isActive ? '●' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  if (newState === 'IDLE') {
    cachedElapsedSeconds = 0;
    cachedTotalBytes     = 0;
  }
}

/**
 * Send a message to the popup.
 * Prefers the long-lived port; falls back to sendMessage for edge cases
 * (e.g., popup just opened and port not yet established).
 */
function sendToPopup(message) {
  if (popupPort) {
    try {
      popupPort.postMessage(message);
      return;
    } catch {
      // Port may have closed between the null-check and postMessage
      popupPort = null;
    }
  }
  // Fallback — popup must be listening with onMessage
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup not open; discard
  });
}

/**
 * Send a message to the offscreen document.
 * The `target: 'offscreen'` field lets the offscreen listener filter its own messages.
 */
function sendToOffscreen(message) {
  chrome.runtime.sendMessage(message).catch((err) => {
    console.error('[SW] sendToOffscreen failed:', err);
  });
}

/**
 * Determine if a message type originated from the offscreen document
 * (for messages that omit the `target` field).
 */
function isOffscreenMessage(type) {
  return [
    'STATE_UPDATE',
    'LIMIT_REACHED',
    'BLOB_READY',
    'MIC_UNAVAILABLE',
    'CODEC_FALLBACK',
    'CAPTURE_ERROR',
    'RECORDER_ERROR',
    'BLOB_READY_ERROR',
  ].includes(type);
}

/**
 * Build a filesystem-safe filename from a tab title and a Date.
 *
 * Illegal Windows/macOS filename characters (\ / : * ? " < > |) are
 * replaced with underscores. The title is truncated to 60 characters.
 * The timestamp is formatted as YYYY-MM-DD_HH-MM-SS.
 *
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
