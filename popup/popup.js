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
let activeTabUrl      = '';
let recordingTabTitle = '';     // title of the tab being recorded (from SW)
let monitorOn         = true;   // whether tab audio plays to speakers
let forceMicEnabled   = false;  // include microphone even without mic confirmation flow
let pointerEnabled    = false;  // draw pointer overlay in recorded tab
let interactionLockEnabled = false; // block interaction with recorded tab
let forcedMicDeviceId = null;   // concrete input device selected during forced mic access check
const MAX_DIAG_LINES  = 120;

// ─── DOM references ───────────────────────────────────────────────────────────

const elTabTitle     = document.getElementById('tab-title');
const elTimer        = document.getElementById('timer');
const elSizeDisplay  = document.getElementById('size-display');
const elPausedTimer  = document.getElementById('timer-paused');
const elPausedSizeDisplay = document.getElementById('size-display-paused');
const elLockIndicatorRecording = document.getElementById('lock-indicator-recording');
const elLockIndicatorPaused = document.getElementById('lock-indicator-paused');
const elLockIndicatorLimit = document.getElementById('lock-indicator-limit');
const elErrorText    = document.getElementById('error-text');
const elMicWarning   = document.getElementById('mic-warning');
const elCodecWarning = document.getElementById('codec-warning');
const elPointerWarn  = document.getElementById('pointer-warning');
const elInteractionLockWarn = document.getElementById('interaction-lock-warning');
const elMicPermStatus = document.getElementById('mic-perm-status');
const elDiagLog      = document.getElementById('diag-log');

const btnStart       = document.getElementById('btn-start');
const btnPause       = document.getElementById('btn-pause');
const btnResume      = document.getElementById('btn-resume');
const btnStop        = document.getElementById('btn-stop');
const btnStopPaused  = document.getElementById('btn-stop-paused');
const btnCancelConfirming = document.getElementById('btn-cancel-confirming');
const btnCancelRecording = document.getElementById('btn-cancel-recording');
const btnCancelPaused = document.getElementById('btn-cancel-paused');
const btnCancelLimit = document.getElementById('btn-cancel-limit');
const btnMonitor     = document.getElementById('btn-monitor');
const btnForceMic    = document.getElementById('btn-force-mic');
const btnForceMicRec = document.getElementById('btn-force-mic-recording');
const btnPointerIdle = document.getElementById('btn-pointer-idle');
const btnPointerRec  = document.getElementById('btn-pointer-recording');
const btnLockIdle    = document.getElementById('btn-lock-idle');
const btnLockRec     = document.getElementById('btn-lock-recording');
const btnLockPaused  = document.getElementById('btn-lock-paused');
const btnGrantMic    = document.getElementById('btn-grant-mic');
const btnContinue    = document.getElementById('btn-continue');
const btnStopLimit   = document.getElementById('btn-stop-limit');
const btnMicYes      = document.getElementById('btn-mic-yes');
const btnMicNo       = document.getElementById('btn-mic-no');
const btnSavePartial = document.getElementById('btn-save-partial');
const btnDiscard     = document.getElementById('btn-discard');
const btnDiagClear   = document.getElementById('btn-diag-clear');

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
      activeTabUrl   = tabs[0].url || '';
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
      if (typeof response.forceMic === 'boolean') {
        forceMicEnabled = response.forceMic;
      }
      if (typeof response.showPointer === 'boolean') {
        pointerEnabled = response.showPointer;
      }
      if (typeof response.lockInteractions === 'boolean') {
        interactionLockEnabled = response.lockInteractions;
      }
      updateForceMicButton();
      updatePointerButtons();
      updateInteractionLockButtons();
      updateInteractionLockIndicators();

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
  btnPause.addEventListener('click',       onPauseClick);
  btnResume.addEventListener('click',      onResumeClick);
  btnStop.addEventListener('click',        onStopClick);
  btnStopPaused.addEventListener('click',  onStopClick);
  btnCancelConfirming.addEventListener('click', onCancelRecordingClick);
  btnCancelRecording.addEventListener('click',  onCancelRecordingClick);
  btnCancelPaused.addEventListener('click',     onCancelRecordingClick);
  btnCancelLimit.addEventListener('click',      onCancelRecordingClick);
  btnMonitor.addEventListener('click',     onMonitorClick);
  btnForceMic.addEventListener('click',    onForceMicClick);
  btnForceMicRec.addEventListener('click', onForceMicClick);
  btnPointerIdle.addEventListener('click', onPointerClick);
  btnPointerRec.addEventListener('click',  onPointerClick);
  btnLockIdle.addEventListener('click',    onInteractionLockClick);
  btnLockRec.addEventListener('click',     onInteractionLockClick);
  btnLockPaused.addEventListener('click',  onInteractionLockClick);
  btnGrantMic.addEventListener('click',    onGrantMicClick);
  btnContinue.addEventListener('click',    onContinueClick);
  btnStopLimit.addEventListener('click',   onStopLimitClick);
  btnMicYes.addEventListener('click',      () => sendMsg({ type: 'MIC_ANSWER', include: true }));
  btnMicNo.addEventListener('click',       () => sendMsg({ type: 'MIC_ANSWER', include: false }));
  btnSavePartial.addEventListener('click', onSavePartialClick);
  btnDiscard.addEventListener('click',     onDiscardClick);
  btnDiagClear.addEventListener('click',   onDiagClearClick);

  updateForceMicButton();
  updatePointerButtons();
  updateInteractionLockButtons();
  updateInteractionLockIndicators();
  refreshMicPermissionStatus();
  addDiag('popup', 'Initialized popup');

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshMicPermissionStatus();
    }
  });
});

// ─── beforeunload guard ───────────────────────────────────────────────────────

window.addEventListener('beforeunload', (e) => {
  if (currentState === 'RECORDING' || currentState === 'PAUSED' || currentState === 'LIMIT_PAUSED') {
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
      addDiag('sw', 'MIC_UNAVAILABLE: recording continued without microphone');
      break;

    case 'CODEC_FALLBACK':
      elCodecWarning.hidden = false;
      break;

    case 'POINTER_UNAVAILABLE':
      pointerEnabled = false;
      updatePointerButtons();
      showBannerTemporarily(elPointerWarn, 4000);
      addDiag('sw', 'Pointer overlay unavailable');
      break;

    case 'INTERACTION_LOCK_UNAVAILABLE':
      interactionLockEnabled = false;
      updateInteractionLockButtons();
      updateInteractionLockIndicators();
      showBannerTemporarily(elInteractionLockWarn, 4000);
      addDiag('sw', 'Input lock unavailable');
      break;

    case 'MIC_DIAGNOSTIC':
      addDiag(message.source || 'mic', message.message || 'diagnostic', message.details);
      break;

    case 'RECORDING_ERROR':
      elErrorText.textContent =
        `Recording error: ${message.error || 'Unknown error'}`;
      renderState('ERROR');
      addDiag('sw', `RECORDING_ERROR: ${message.error || 'Unknown error'}`);
      break;

    default:
      console.warn('[popup] Unhandled port message:', message.type);
  }
}

// ─── Button handlers ──────────────────────────────────────────────────────────

async function onStartClick() {
  if (!activeTabId) {
    console.error('[popup] No active tab ID');
    return;
  }

  if (!isCapturablePage(activeTabUrl)) {
    addDiag('popup', 'Start blocked: current page cannot be captured', { activeTabUrl });
    window.alert(
      'This page cannot be captured. Open a regular website tab (https://...) and start recording from there.'
    );
    return;
  }

  if (forceMicEnabled) {
    addDiag('popup', 'Force Mic enabled, running microphone preflight');
    const micResult = await requestMicAccessFromDefaultDevice();
    const micReady = micResult.ok;
    if (!micReady) {
      addDiag('popup', 'Microphone preflight failed; start aborted');
      refreshMicPermissionStatus();
      return;
    }
    forcedMicDeviceId = micResult.deviceId;
    addDiag('popup', 'Microphone preflight succeeded', {
      selectedDeviceId: forcedMicDeviceId || '(none)',
    });
  } else {
    forcedMicDeviceId = null;
    addDiag('popup', 'Force Mic disabled; microphone will be optional');
  }

  // Save the recording tab title so Stop can use it for the filename.
  recordingTabTitle = activeTabTitle;
  sendMsg({
    type: 'START_RECORDING',
    tabId: activeTabId,
    tabTitle: activeTabTitle,
    forceMic: forceMicEnabled,
    showPointer: pointerEnabled,
    lockInteractions: interactionLockEnabled,
    micDeviceId: forcedMicDeviceId,
  });
  addDiag('popup', 'START_RECORDING sent', {
    forceMicEnabled,
    pointerEnabled,
    interactionLockEnabled,
    micDeviceId: forcedMicDeviceId || null,
  });
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

function onPauseClick() {
  sendMsg({ type: 'PAUSE_RECORDING' });
  renderState('PAUSED');
}

function onResumeClick() {
  sendMsg({ type: 'RESUME_RECORDING' });
  renderState('RECORDING');
}

function onCancelRecordingClick() {
  const confirmed = window.confirm('Cancel recording and discard captured data?');
  if (!confirmed) {
    return;
  }

  fileHandle = null;
  partialBlobKey = null;
  sendMsg({ type: 'CANCEL_RECORDING' });
  addDiag('popup', 'CANCEL_RECORDING sent');
  renderState('IDLE');
}

function onMonitorClick() {
  monitorOn = !monitorOn;
  updateMonitorButton();
  sendMsg({ type: 'TOGGLE_MONITOR', on: monitorOn });
}

function onForceMicClick() {
  const appliesNextRecording =
    currentState === 'RECORDING' || currentState === 'PAUSED' || currentState === 'LIMIT_PAUSED';

  forceMicEnabled = !forceMicEnabled;
  updateForceMicButton();
  sendMsg({ type: 'SET_FORCE_MIC_OPTION', on: forceMicEnabled });
  if (appliesNextRecording) {
    addDiag(
      'popup',
      `Force Mic toggled: ${forceMicEnabled ? 'ON' : 'OFF'} (will apply on next recording)`
    );
    window.alert(
      'Force Mic applies from the next recording. Stop current recording and start a new one to capture microphone audio.'
    );
  } else {
    addDiag('popup', `Force Mic toggled: ${forceMicEnabled ? 'ON' : 'OFF'}`);
  }
}

function onPointerClick() {
  pointerEnabled = !pointerEnabled;
  updatePointerButtons();
  addDiag('popup', `Pointer toggled: ${pointerEnabled ? 'ON' : 'OFF'}`);

  if (currentState === 'RECORDING' || currentState === 'PAUSED' || currentState === 'LIMIT_PAUSED') {
    sendMsg({ type: 'TOGGLE_POINTER', on: pointerEnabled });
    addDiag('popup', 'TOGGLE_POINTER sent during recording', { pointerEnabled });
  }
}

function onInteractionLockClick() {
  interactionLockEnabled = !interactionLockEnabled;
  updateInteractionLockButtons();
  updateInteractionLockIndicators();
  sendMsg({ type: 'TOGGLE_INTERACTION_LOCK', on: interactionLockEnabled });
  addDiag('popup', `Input Lock toggled: ${interactionLockEnabled ? 'ON' : 'OFF'}`);
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
  const wasActiveRecording = currentState === 'RECORDING' || currentState === 'PAUSED';
  currentState = state;
  document.body.dataset.state = state;

  // Reset monitor toggle when a fresh recording begins.
  if (state === 'RECORDING' && !wasActiveRecording) {
    monitorOn = true;
    updateMonitorButton();
  }

  if (elTimer) {
    elTimer.textContent = formatDuration(elapsedSeconds);
  }
  if (elSizeDisplay) {
    elSizeDisplay.textContent = formatBytes(totalBytes);
  }
  if (elPausedTimer) {
    elPausedTimer.textContent = formatDuration(elapsedSeconds);
  }
  if (elPausedSizeDisplay) {
    elPausedSizeDisplay.textContent = formatBytes(totalBytes);
  }
  updateInteractionLockIndicators();
}

function updateMonitorButton() {
  if (!btnMonitor) return;
  btnMonitor.textContent = monitorOn ? 'Tab audio: On' : 'Tab audio: Off';
  btnMonitor.classList.toggle('btn-monitor-on',  monitorOn);
  btnMonitor.classList.toggle('btn-monitor-off', !monitorOn);
}

function updateForceMicButton() {
  const label = forceMicEnabled ? 'Force Mic: On' : 'Force Mic: Off';

  if (btnForceMic) {
    btnForceMic.textContent = label;
    setToggleButtonState(btnForceMic, forceMicEnabled);
  }

  if (btnForceMicRec) {
    btnForceMicRec.textContent = label;
    setToggleButtonState(btnForceMicRec, forceMicEnabled);
  }
}

function updatePointerButtons() {
  const label = pointerEnabled ? 'Pointer: On' : 'Pointer: Off';

  if (btnPointerIdle) {
    btnPointerIdle.textContent = label;
    setToggleButtonState(btnPointerIdle, pointerEnabled);
  }

  if (btnPointerRec) {
    btnPointerRec.textContent = label;
    setToggleButtonState(btnPointerRec, pointerEnabled);
  }
}

function updateInteractionLockButtons() {
  const label = interactionLockEnabled ? 'Input Lock: On' : 'Input Lock: Off';

  if (btnLockIdle) {
    btnLockIdle.textContent = label;
    setToggleButtonState(btnLockIdle, interactionLockEnabled);
  }

  if (btnLockRec) {
    btnLockRec.textContent = label;
    setToggleButtonState(btnLockRec, interactionLockEnabled);
  }

  if (btnLockPaused) {
    btnLockPaused.textContent = label;
    setToggleButtonState(btnLockPaused, interactionLockEnabled);
  }
}

function updateInteractionLockIndicators() {
  const showInRecording = interactionLockEnabled && currentState === 'RECORDING';
  const showInPaused = interactionLockEnabled && currentState === 'PAUSED';
  const showInLimitPaused = interactionLockEnabled && currentState === 'LIMIT_PAUSED';

  if (elLockIndicatorRecording) {
    elLockIndicatorRecording.hidden = !showInRecording;
  }
  if (elLockIndicatorPaused) {
    elLockIndicatorPaused.hidden = !showInPaused;
  }
  if (elLockIndicatorLimit) {
    elLockIndicatorLimit.hidden = !showInLimitPaused;
  }
}

function setToggleButtonState(button, enabled) {
  button.classList.toggle('btn-toggle-on', enabled);
  button.classList.toggle('btn-toggle-off', !enabled);
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
    addDiag('popup', `sendMessage failed: ${err?.message || String(err)}`);
  });
}

async function requestMicAccessFromDefaultDevice() {
  const permissionBefore = await queryMicPermissionState();
  addDiag('popup', `Permission before getUserMedia: ${permissionBefore}`);

  const inputDevicesBefore = await listInputDevices();
  addDiag('popup', `Audio inputs visible before request: ${inputDevicesBefore.length}`, inputDevicesBefore);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { ideal: 'default' } },
      video: false,
    });
    const audioTrack = stream.getAudioTracks()[0] || null;
    const deviceId = audioTrack?.getSettings?.().deviceId || null;
    const trackInfo = audioTrack
      ? {
          label: audioTrack.label || '',
          enabled: audioTrack.enabled,
          muted: audioTrack.muted,
          readyState: audioTrack.readyState,
          settings: audioTrack.getSettings?.() || {},
          constraints: audioTrack.getConstraints?.() || {},
        }
      : null;

    addDiag('popup', 'getUserMedia(audio) succeeded', {
      selectedDeviceId: deviceId || null,
      track: trackInfo,
    });

    stream.getTracks().forEach((track) => track.stop());

    const permissionAfter = await queryMicPermissionState();
    addDiag('popup', `Permission after getUserMedia: ${permissionAfter}`);
    const inputDevicesAfter = await listInputDevices();
    addDiag('popup', `Audio inputs visible after request: ${inputDevicesAfter.length}`, inputDevicesAfter);

    return {
      ok: true,
      deviceId,
      trackInfo,
      errorName: null,
      errorMessage: null,
    };
  } catch (err) {
    console.warn('[popup] Forced mic request failed:', err);
    addDiag('popup', `getUserMedia(audio) failed: ${err?.name || 'Error'}: ${err?.message || 'unknown'}`);
    window.alert('Microphone access was denied or unavailable. Please allow microphone access for this extension.');
    return {
      ok: false,
      deviceId: null,
      errorName: err?.name || 'Error',
      errorMessage: err?.message || 'unknown',
    };
  }
}

function onDiagClearClick() {
  if (!elDiagLog) return;
  elDiagLog.textContent = '[diag] cleared';
}

function onGrantMicClick() {
  addDiag('popup', 'Grant Mic clicked');
  requestMicAccessFromDefaultDevice().then((result) => {
    if (result.ok) {
      addDiag('popup', 'Grant Mic succeeded');
    }
    refreshMicPermissionStatus();
  });
}

function addDiag(source, message, details) {
  if (!elDiagLog) return;
  const ts = new Date().toISOString().slice(11, 19);
  const parts = [`[${ts}] [${source}] ${message}`];
  if (details !== undefined) {
    parts.push(safeJson(details));
  }
  elDiagLog.textContent += `\n${parts.join(' | ')}`;
  trimDiag();
  elDiagLog.scrollTop = elDiagLog.scrollHeight;
}

function trimDiag() {
  if (!elDiagLog) return;
  const lines = elDiagLog.textContent.split('\n');
  if (lines.length <= MAX_DIAG_LINES) return;
  elDiagLog.textContent = lines.slice(lines.length - MAX_DIAG_LINES).join('\n');
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isCapturablePage(url) {
  if (!url) return true;
  return !/^(chrome|edge|about|chrome-extension):/i.test(url);
}

async function refreshMicPermissionStatus() {
  const state = await queryMicPermissionState();
  applyMicPermissionStatus(state);
  addDiag('popup', `Mic permission status: ${state}`);
}

function applyMicPermissionStatus(state) {
  if (!elMicPermStatus) return;

  elMicPermStatus.classList.remove('perm-granted', 'perm-prompt', 'perm-denied', 'perm-unknown');

  if (state === 'granted') {
    elMicPermStatus.classList.add('perm-granted');
    elMicPermStatus.textContent = 'Mic permission: Granted';
    return;
  }
  if (state === 'prompt') {
    elMicPermStatus.classList.add('perm-prompt');
    elMicPermStatus.textContent = 'Mic permission: Not granted yet (Prompt)';
    return;
  }
  if (state === 'denied') {
    elMicPermStatus.classList.add('perm-denied');
    elMicPermStatus.textContent = 'Mic permission: Denied';
    return;
  }

  elMicPermStatus.classList.add('perm-unknown');
  elMicPermStatus.textContent = `Mic permission: ${state}`;
}

async function queryMicPermissionState() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) {
      return 'permissions-api-unavailable';
    }
    const result = await navigator.permissions.query({ name: 'microphone' });
    return result.state;
  } catch (err) {
    return `permissions-query-error:${err?.name || 'Error'}`;
  }
}

async function listInputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ kind: d.kind, deviceId: d.deviceId, label: d.label || '' }));
  } catch (err) {
    addDiag('popup', `enumerateDevices failed: ${err?.name || 'Error'}: ${err?.message || 'unknown'}`);
    return [];
  }
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
