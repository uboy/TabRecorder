/**
 * Service Worker — coordinator and state machine.
 *
 * Does not touch any media APIs. Owns the canonical extension state,
 * routes messages between popup ↔ offscreen ↔ content script, and
 * monitors tab lifecycle.
 *
 * State machine:
 *   IDLE → CONFIRMING_MIC → RECORDING → PAUSED → RECORDING
 *                        ↘ LIMIT_PAUSED ↗
 *                        ↘ (no mic)  ↗
 */

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {'IDLE'|'CONFIRMING_MIC'|'RECORDING'|'PAUSED'|'LIMIT_PAUSED'|'SAVING'} */
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
let pendingForceMic = false;
let pendingShowPointer = false;
let pendingLockInteractions = false;
let awaitingMicPermission = false;

// Blob that finished while the popup was closed — delivered on next popup open
let pendingBlobKey       = null;
let pendingSuggestedName = '';

// Current options reflected by popup controls.
let currentForceMicOption = false;
let currentShowPointerOption = false;
let currentInteractionLockOption = false;

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
      handleStartRecording(message.tabId, message.tabTitle, {
        forceMic: message.forceMic,
        showPointer: message.showPointer,
        lockInteractions: message.lockInteractions,
        micDeviceId: message.micDeviceId,
      });
      break;

    case 'MIC_PERMISSION_STATE':
      handleMicPermissionState(message.state);
      break;

    case 'MIC_ANSWER':
      handleMicAnswer(message.include);
      break;

    case 'STOP_RECORDING':
      if (state === 'RECORDING' || state === 'PAUSED' || state === 'LIMIT_PAUSED') {
        disableInteractionLock();
        sendToOffscreen({ type: 'STOP_MEDIA', target: 'offscreen' });
        setState('SAVING');
      }
      break;

    case 'CANCEL_RECORDING':
      if (state === 'CONFIRMING_MIC') {
        disablePointerOverlayForTab(pendingTabId);
        disableInteractionLockForTab(pendingTabId);
        resetPendingStartContext();
        setState('IDLE');
      } else if (state === 'RECORDING' || state === 'PAUSED' || state === 'LIMIT_PAUSED') {
        disablePointerOverlay();
        disableInteractionLock();
        sendToOffscreen({ type: 'CANCEL_MEDIA', target: 'offscreen' });
        recordingTabId = null;
        recordingTabTitle = '';
        resetPendingStartContext();
        setState('IDLE');
        sendToPopup({ type: 'STATE_UPDATE', state: 'IDLE', elapsedSeconds: 0, totalBytes: 0 });
      }
      break;

    case 'PAUSE_RECORDING':
      if (state === 'RECORDING') {
        sendToOffscreen({ type: 'PAUSE_MEDIA', target: 'offscreen' });
        setState('PAUSED');
        sendToPopup({
          type: 'STATE_UPDATE',
          state: 'PAUSED',
          elapsedSeconds: cachedElapsedSeconds,
          totalBytes: cachedTotalBytes,
        });
      }
      break;

    case 'RESUME_RECORDING':
      if (state === 'PAUSED') {
        sendToOffscreen({ type: 'RESUME_MEDIA', target: 'offscreen' });
        setState('RECORDING');
        sendToPopup({
          type: 'STATE_UPDATE',
          state: 'RECORDING',
          elapsedSeconds: cachedElapsedSeconds,
          totalBytes: cachedTotalBytes,
        });
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
        forceMic:            currentForceMicOption,
        showPointer:         currentShowPointerOption,
        lockInteractions:    currentInteractionLockOption,
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
        disableInteractionLock();
        sendToOffscreen({ type: 'CONFIRM_STOP_AT_LIMIT', target: 'offscreen' });
        setState('SAVING');
      }
      break;

    case 'TOGGLE_MONITOR':
      sendToOffscreen({ type: message.on ? 'MONITOR_ON' : 'MONITOR_OFF', target: 'offscreen' });
      break;

    case 'SET_FORCE_MIC_OPTION':
      currentForceMicOption = Boolean(message.on);
      break;

    case 'TOGGLE_POINTER':
      currentShowPointerOption = Boolean(message.on);
      if ((state === 'RECORDING' || state === 'PAUSED' || state === 'LIMIT_PAUSED') && recordingTabId !== null) {
        setPointerOverlay(recordingTabId, currentShowPointerOption).then((ok) => {
          if (!ok) {
            currentShowPointerOption = false;
            sendToPopup({ type: 'POINTER_UNAVAILABLE' });
          }
        });
      }
      break;

    case 'TOGGLE_INTERACTION_LOCK':
      currentInteractionLockOption = Boolean(message.on);
      if (state === 'CONFIRMING_MIC') {
        pendingLockInteractions = currentInteractionLockOption;
        if (pendingTabId !== null) {
          setInteractionLock(pendingTabId, currentInteractionLockOption).then((ok) => {
            if (!ok) {
              pendingLockInteractions = false;
              currentInteractionLockOption = false;
              sendToPopup({ type: 'INTERACTION_LOCK_UNAVAILABLE' });
            }
          });
        }
      } else if ((state === 'RECORDING' || state === 'PAUSED' || state === 'LIMIT_PAUSED') && recordingTabId !== null) {
        setInteractionLock(recordingTabId, currentInteractionLockOption).then((ok) => {
          if (!ok) {
            currentInteractionLockOption = false;
            sendToPopup({ type: 'INTERACTION_LOCK_UNAVAILABLE' });
          }
        });
      }
      break;

    default:
      console.warn('[SW] Unknown message type:', message.type);
  }

  return false;
});

// ─── Tab removal detection ────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== recordingTabId) return;
  if (state !== 'RECORDING' && state !== 'PAUSED' && state !== 'LIMIT_PAUSED') return;

  console.log('[SW] Recorded tab closed; interrupting recording.');
  sendToOffscreen({ type: 'TAB_CLOSED_INTERRUPT', target: 'offscreen' });
  sendToPopup({ type: 'TAB_CLOSED' });
  setState('SAVING');
});

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleStartRecording(tabId, tabTitle, options = {}) {
  pendingTabId    = tabId;
  pendingTabTitle = tabTitle;
  pendingForceMic = Boolean(options.forceMic);
  pendingShowPointer = Boolean(options.showPointer);
  pendingLockInteractions = Boolean(options.lockInteractions);
  const pendingMicDeviceId = typeof options.micDeviceId === 'string' ? options.micDeviceId : null;

  currentForceMicOption = pendingForceMic;
  currentShowPointerOption = pendingShowPointer;
  currentInteractionLockOption = pendingLockInteractions;
  awaitingMicPermission = !pendingForceMic;
  sendMicDiagnostic('sw', 'handleStartRecording', {
    tabId,
    forceMic: pendingForceMic,
    showPointer: pendingShowPointer,
    lockInteractions: pendingLockInteractions,
    micDeviceId: pendingMicDeviceId || null,
  });

  try {
    await ensureContentScriptInjected(tabId);
  } catch (err) {
    console.warn('[SW] Could not inject content script:', err.message);
    if (pendingLockInteractions) {
      pendingLockInteractions = false;
      currentInteractionLockOption = false;
      sendToPopup({ type: 'INTERACTION_LOCK_UNAVAILABLE' });
    }

    if (pendingForceMic) {
      awaitingMicPermission = false;
      startCapture(
        pendingTabId,
        pendingTabTitle,
        true,
        pendingShowPointer,
        pendingLockInteractions,
        { forceMic: true, micDeviceId: pendingMicDeviceId }
      );
    } else {
      // Cannot inject into chrome:// pages or other restricted origins.
      // Send a synthetic 'denied' state so recording falls back to tab-only.
      handleMicPermissionState('denied');
    }
    return;
  }

  if (pendingShowPointer) {
    const pointerEnabled = await setPointerOverlay(tabId, true);
    if (!pointerEnabled) {
      currentShowPointerOption = false;
      pendingShowPointer = false;
      sendToPopup({ type: 'POINTER_UNAVAILABLE' });
    }
  }

  if (pendingLockInteractions) {
    const lockEnabled = await setInteractionLock(tabId, true);
    if (!lockEnabled) {
      pendingLockInteractions = false;
      currentInteractionLockOption = false;
      sendToPopup({ type: 'INTERACTION_LOCK_UNAVAILABLE' });
    }
  }

  if (pendingForceMic) {
    awaitingMicPermission = false;
    sendMicDiagnostic('sw', 'Force mic path selected, skipping MIC_PERMISSION_STATE confirmation');
    startCapture(
      pendingTabId,
      pendingTabTitle,
      true,
      pendingShowPointer,
      pendingLockInteractions,
      { forceMic: true, micDeviceId: pendingMicDeviceId }
    );
    return;
  }

  const micRequested = await requestMicPermissionState(tabId);
  if (!micRequested) {
    sendMicDiagnostic('sw', 'MIC_PERMISSION_STATE request failed, falling back to tab-only recording');
    handleMicPermissionState('denied');
  }
}

function handleMicPermissionState(permState) {
  if (!awaitingMicPermission) {
    return;
  }
  awaitingMicPermission = false;
  sendMicDiagnostic('sw', 'MIC_PERMISSION_STATE received', { permState });

  if (permState === 'granted') {
    setState('CONFIRMING_MIC');
    sendToPopup({ type: 'CONFIRM_MIC' });
  } else {
    // Skip mic dialog — proceed directly to capture
    startCapture(pendingTabId, pendingTabTitle, false, pendingShowPointer, pendingLockInteractions);
  }
}

function handleMicAnswer(include) {
  if (state !== 'CONFIRMING_MIC') {
    return;
  }
  sendMicDiagnostic('sw', 'MIC_ANSWER received', { include });
  startCapture(pendingTabId, pendingTabTitle, include, pendingShowPointer, pendingLockInteractions, {
    forceMic: false,
    micDeviceId: null,
  });
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
      disablePointerOverlay();
      disableInteractionLock();
      resetPendingStartContext();
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

    case 'RECORDING_CANCELLED':
      disablePointerOverlay();
      disableInteractionLock();
      resetPendingStartContext();
      setState('IDLE');
      recordingTabId    = null;
      recordingTabTitle = '';
      sendToPopup({ type: 'STATE_UPDATE', state: 'IDLE', elapsedSeconds: 0, totalBytes: 0 });
      break;

    case 'MIC_UNAVAILABLE':
    case 'CODEC_FALLBACK':
      sendToPopup(message);
      break;

    case 'MIC_DIAGNOSTIC':
      sendToPopup(message);
      break;

    case 'CAPTURE_ERROR':
    case 'RECORDER_ERROR':
    case 'BLOB_READY_ERROR':
      console.error('[SW] Offscreen error:', message.type, message.error);
      disablePointerOverlay();
      disableInteractionLock();
      resetPendingStartContext();
      setState('IDLE');
      recordingTabId    = null;
      recordingTabTitle = '';
      sendToPopup({ type: 'RECORDING_ERROR', error: message.error });
      break;

    default:
      console.warn('[SW] Unhandled offscreen message:', message.type);
  }
}

// ─── startCapture ─────────────────────────────────────────────────────────────

async function startCapture(tabId, tabTitle, includeMic, showPointer, lockInteractions, micOptions = {}) {
  recordingTabId    = tabId;
  recordingTabTitle = tabTitle;
  pendingShowPointer = Boolean(showPointer);
  pendingLockInteractions = Boolean(lockInteractions);
  currentShowPointerOption = pendingShowPointer;
  currentInteractionLockOption = pendingLockInteractions;
  sendMicDiagnostic('sw', 'startCapture called', {
    tabId,
    includeMic: Boolean(includeMic),
    forceMic: Boolean(micOptions.forceMic),
    micDeviceId: typeof micOptions.micDeviceId === 'string' ? micOptions.micDeviceId : null,
    showPointer: pendingShowPointer,
    lockInteractions: pendingLockInteractions,
  });

  // Ensure the offscreen document is READY before calling getMediaStreamId.
  // Stream IDs have a short validity window — minimising the delay between
  // getMediaStreamId() and the getUserMedia() call inside the offscreen doc
  // is critical. Creating the document first means it is already listening
  // by the time the stream ID arrives.
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    console.error('[SW] Failed to create offscreen document:', err);
    disablePointerOverlay();
    disableInteractionLock();
    setState('IDLE');
    sendToPopup({ type: 'RECORDING_ERROR', error: err.message });
    return;
  }

  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      const errMsg = chrome.runtime.lastError?.message ?? 'getMediaStreamId failed';
      console.error('[SW] tabCapture.getMediaStreamId error:', errMsg);
      disablePointerOverlay();
      disableInteractionLock();
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
      forceMic: Boolean(micOptions.forceMic),
      micDeviceId: typeof micOptions.micDeviceId === 'string' ? micOptions.micDeviceId : null,
      showPointer: pendingShowPointer,
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

async function ensureContentScriptInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content-script.js'],
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        const errMsg = err.message || '';
        // Not a delivery failure: listener handled the message but sent no response.
        if (/The message port closed before a response was received/i.test(errMsg)) {
          resolve();
          return;
        }
        reject(new Error(errMsg));
        return;
      }
      resolve();
    });
  });
}

async function setPointerOverlay(tabId, enabled) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [enabled],
      func: (isEnabled) => {
        const STORE_KEY = '__tabRecorderPointerStore';
        const ID = '__tab-recorder-pointer-overlay';

        const getStore = () => {
          if (!window[STORE_KEY]) {
            window[STORE_KEY] = {
              enabled: false,
              pointerEl: null,
              rafPending: false,
              mouseX: -9999,
              mouseY: -9999,
            };
          }
          return window[STORE_KEY];
        };

        const ensurePointerElement = () => {
          const store = getStore();
          if (store.pointerEl && store.pointerEl.isConnected) return store.pointerEl;

          const existing = document.getElementById(ID);
          if (existing) {
            store.pointerEl = existing;
            return store.pointerEl;
          }

          const pointerEl = document.createElement('div');
          pointerEl.id = ID;
          pointerEl.style.position = 'fixed';
          pointerEl.style.left = '0';
          pointerEl.style.top = '0';
          pointerEl.style.width = '18px';
          pointerEl.style.height = '18px';
          pointerEl.style.marginLeft = '-9px';
          pointerEl.style.marginTop = '-9px';
          pointerEl.style.border = '2px solid #34d399';
          pointerEl.style.borderRadius = '999px';
          pointerEl.style.background =
            'radial-gradient(circle, rgba(52,211,153,0.95) 0 2px, rgba(16,185,129,0.2) 3px 100%)';
          pointerEl.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.45)';
          pointerEl.style.transform = 'translate3d(-9999px, -9999px, 0)';
          pointerEl.style.opacity = '0';
          pointerEl.style.zIndex = '2147483647';
          pointerEl.style.pointerEvents = 'none';
          pointerEl.style.transition = 'opacity 80ms linear';

          const host = document.documentElement || document.body;
          host.appendChild(pointerEl);
          store.pointerEl = pointerEl;
          return pointerEl;
        };

        const flushPosition = () => {
          const store = getStore();
          store.rafPending = false;
          const el = ensurePointerElement();
          el.style.transform = `translate3d(${store.mouseX}px, ${store.mouseY}px, 0)`;
          if (store.enabled) {
            el.style.opacity = '1';
          }
        };

        const onMouseMove = (event) => {
          const store = getStore();
          store.mouseX = event.clientX;
          store.mouseY = event.clientY;
          if (!store.rafPending) {
            store.rafPending = true;
            requestAnimationFrame(flushPosition);
          }
        };

        const onMouseLeave = () => {
          const store = getStore();
          if (!store.pointerEl) return;
          store.pointerEl.style.opacity = '0';
        };

        const onMouseEnter = () => {
          const store = getStore();
          if (!store.enabled || !store.pointerEl) return;
          store.pointerEl.style.opacity = '1';
        };

        const store = getStore();
        if (isEnabled) {
          if (!store.enabled) {
            store.enabled = true;
            ensurePointerElement();
            window.addEventListener('mousemove', onMouseMove, { passive: true, capture: true });
            window.addEventListener('mouseleave', onMouseLeave, { passive: true });
            window.addEventListener('mouseenter', onMouseEnter, { passive: true });
          }
        } else if (store.enabled) {
          store.enabled = false;
          window.removeEventListener('mousemove', onMouseMove, { capture: true });
          window.removeEventListener('mouseleave', onMouseLeave);
          window.removeEventListener('mouseenter', onMouseEnter);
          if (store.pointerEl) {
            store.pointerEl.remove();
            store.pointerEl = null;
          }
        }
      },
    });
    return true;
  } catch (err) {
    console.warn('[SW] Pointer overlay toggle failed:', err.message);
    return false;
  }
}

async function requestMicPermissionState(tabId) {
  try {
    await sendToTab(tabId, { type: 'REQUEST_MIC_PERMISSION_STATE' });
    sendMicDiagnostic('sw', 'Requested MIC_PERMISSION_STATE from content script');
    return true;
  } catch (err) {
    console.warn('[SW] Mic state request failed:', err.message);
    sendMicDiagnostic('sw', 'MIC_PERMISSION_STATE request failed', { error: err.message });
    return false;
  }
}

async function setInteractionLock(tabId, enabled) {
  try {
    await sendToTab(tabId, { type: 'SET_INTERACTION_LOCK', enabled });
    return true;
  } catch (err) {
    console.warn('[SW] Interaction lock toggle failed:', err.message);
    return false;
  }
}

function disablePointerOverlay() {
  if (!currentShowPointerOption || recordingTabId === null) return;
  setPointerOverlay(recordingTabId, false).catch(() => {
    // Best-effort teardown.
  });
}

function disablePointerOverlayForTab(tabId) {
  if (tabId === null || tabId === undefined) return;
  setPointerOverlay(tabId, false).catch(() => {
    // Best-effort teardown.
  });
}

function disableInteractionLock() {
  if (recordingTabId === null) return;
  setInteractionLock(recordingTabId, false).catch(() => {
    // Best-effort teardown.
  });
}

function disableInteractionLockForTab(tabId) {
  if (tabId === null || tabId === undefined) return;
  setInteractionLock(tabId, false).catch(() => {
    // Best-effort teardown.
  });
}

function resetPendingStartContext() {
  pendingTabId = null;
  pendingTabTitle = '';
  pendingForceMic = false;
  pendingShowPointer = false;
  pendingLockInteractions = false;
  awaitingMicPermission = false;
}

function sendMicDiagnostic(source, message, details) {
  const payload = { type: 'MIC_DIAGNOSTIC', source, message, details };
  sendToPopup(payload);
  console.log('[MIC_DIAG]', source, message, details || '');
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function setState(newState) {
  state = newState;
  const isActive = newState === 'RECORDING' || newState === 'PAUSED' || newState === 'LIMIT_PAUSED';
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
    'MIC_DIAGNOSTIC',
    'CODEC_FALLBACK',
    'CAPTURE_ERROR',
    'RECORDER_ERROR',
    'BLOB_READY_ERROR',
    'RECORDING_CANCELLED',
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
