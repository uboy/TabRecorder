/**
 * recorder.js — standalone Firefox recording page.
 *
 * Firefox has no tabCapture API and getDisplayMedia requires a user gesture
 * inside an extension page, so the whole capture lives here:
 *   getDisplayMedia(tab) -> optional getUserMedia(mic) -> AudioMixer ->
 *   MediaRecorder -> Blob -> showSaveFilePicker (fallback: a[download]).
 *
 * The window must stay open while recording; beforeunload guards against it.
 */

'use strict';

import { AudioMixer } from '../lib/audio-mixer.js';

// ─── DOM references ───────────────────────────────────────────────────────────

const elTarget  = document.getElementById('rec-target');
const elStatus  = document.getElementById('rec-status');
const elError   = document.getElementById('rec-error');
const elDiag    = document.getElementById('rec-diag');
const elTimer   = document.getElementById('rec-timer');
const elSize    = document.getElementById('rec-size');
const btnStart  = document.getElementById('btn-rec-start');
const btnStop   = document.getElementById('btn-rec-stop');
const micCheck  = document.getElementById('rec-mic-check');
const panelIdle = document.getElementById('panel-idle');
const panelRec  = document.getElementById('panel-recording');

// ─── Session state ────────────────────────────────────────────────────────────

let mediaRecorder   = null;
let chunks          = [];
let totalBytes      = 0;
let tabStream       = null;
let micStream       = null;
let combinedStream  = null;
let audioContext    = null;
let mixer           = null;
let timerInterval   = null;
let startedAt       = 0;
let mimeType        = '';
let saving          = false;
let discardRequested = false;

const options = {
  tabTitle: '',
  forceMic: false,
  micDeviceId: null,
  autostart: false,
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function diag(source, message) {
  const ts = new Date().toISOString().slice(11, 19);
  elDiag.textContent += `[${ts}] [${source}] ${message}\n`;
  elDiag.scrollTop = elDiag.scrollHeight;
}

function showError(message) {
  elError.textContent = message;
  elError.hidden = false;
}

function clearError() {
  elError.textContent = '';
  elError.hidden = true;
}

function setStatus(message) {
  elStatus.textContent = message;
}

function buildFilename(tabTitle, date) {
  const safe = (tabTitle || 'recording')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 60);
  const ts = date.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  return `${safe}_${ts}.webm`;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/** Broadcast recorder state to the popup (best-effort). */
function sendState(state, extra = {}) {
  try {
    chrome.runtime.sendMessage({
      type: 'REC_STATE',
      state,
      elapsedSeconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
      totalBytes,
      ...extra,
    });
  } catch {
    // Popup may be closed — that is fine.
  }
}

async function minimizeOwnWindow() {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.windows.update(win.id, { state: 'minimized' });
    diag('ui', 'window minimized during recording');
  } catch (err) {
    diag('ui', `minimize failed: ${err?.message || err}`);
  }
}

async function restoreOwnWindow() {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.windows.update(win.id, { state: 'normal' });
  } catch {
    // Best-effort.
  }
}

// ─── Capture flow ─────────────────────────────────────────────────────────────

async function onStartClick() {
  clearError();
  btnStart.disabled = true;
  setStatus('Requesting tab capture…');

  // 1. Tab stream (user gesture active — picker shows here).
  try {
    tabStream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: true,
    });
  } catch (err) {
    diag('capture', `getDisplayMedia failed: ${err.name}: ${err.message}`);
    if (options.autostart) {
      diag('capture', 'autostart rejected (no user activation in fresh window)');
      setStatus('Click "Start recording" to begin.');
      resetToIdle();
      return;
    }
    showError(`Capture cancelled or failed: ${err.name}: ${err.message}`);
    resetToIdle();
    return;
  }

  const videoTracks = tabStream.getVideoTracks();
  const audioTracks = tabStream.getAudioTracks();
  diag('capture', `tab stream: video=${videoTracks.length} audio=${audioTracks.length}`);

  if (audioTracks.length === 0) {
    setStatus('Tab did not provide audio — recording video only.');
    diag('capture', 'WARNING: no tab audio track returned by getDisplayMedia');
  }

  // Stop everything if the user presses the browser's "Stop sharing" bar.
  videoTracks.forEach((t) => { t.onended = () => onSharingEnded(); });

  // 2. Optional microphone.
  if (micCheck.checked) {
    setStatus('Requesting microphone…');
    const micConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (options.micDeviceId) micConstraints.deviceId = { exact: options.micDeviceId };
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });
      diag('mic', `mic acquired: ${micStream.getAudioTracks().length} track(s)`);
    } catch (err) {
      diag('mic', `getUserMedia failed: ${err.name}: ${err.message}`);
      releaseStreams();
      showError(`Microphone request failed: ${err.name}: ${err.message}`);
      sendState('ERROR', { error: `Microphone request failed: ${err.name}` });
      resetToIdle();
      return;
    }
  }

  // 3. Mix tab + mic into one stream via shared AudioMixer module.
  mimeType = pickMimeType();
  diag('rec', `MediaRecorder mime: ${mimeType || '(browser default)'}`);
  try {
    audioContext = new AudioContext();
    mixer = new AudioMixer(audioContext);
    combinedStream = mixer.mix(tabStream, micStream);
  } catch (err) {
    diag('mix', `mixer failed: ${err?.message || err}`);
    releaseStreams();
    showError(`Audio mixing failed: ${err?.message || err}`);
    resetToIdle();
    return;
  }

  // 4. Record.
  chunks = [];
  totalBytes = 0;
  try {
    mediaRecorder = new MediaRecorder(combinedStream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    diag('rec', `MediaRecorder ctor failed: ${err?.message || err}`);
    releaseStreams();
    showError(`MediaRecorder failed: ${err?.message || err}`);
    resetToIdle();
    return;
  }
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
      totalBytes += e.data.size;
      elSize.textContent = formatBytes(totalBytes);
    }
  };
  mediaRecorder.onstop = () => finalizeRecording();

  mediaRecorder.start(1000); // 1s timeslice → live size counter
  startedAt = Date.now();
  discardRequested = false;
  panelIdle.hidden = true;
  panelRec.hidden = false;
  timerInterval = setInterval(tickTimer, 500);
  setStatus('Recording… you can use the popup to stop; this window is minimized.');
  sendState('RECORDING');
  diag('rec', 'recording started');
  await minimizeOwnWindow();
}

function tickTimer() {
  const elapsed = (Date.now() - startedAt) / 1000;
  elTimer.textContent = formatDuration(elapsed);
  sendState('RECORDING');
}

function onSharingEnded() {
  diag('rec', 'sharing ended by browser (track onended)');
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  }
}

async function onStopClick() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  stopRecording();
}

function stopRecording() {
  clearInterval(timerInterval);
  timerInterval = null;
  panelRec.hidden = true;
  setStatus('Finalizing…');
  try {
    mediaRecorder.stop(); // onstop -> finalizeRecording
  } catch (err) {
    diag('rec', `stop() threw: ${err?.message || err}`);
    finalizeRecording();
  }
}

async function finalizeRecording() {
  if (saving) return;
  saving = true;
  sendState('SAVING');

  const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
  chunks = [];
  const suggestedName = buildFilename(options.tabTitle, new Date());
  diag('save', `blob ready: ${formatBytes(blob.size)}, name=${suggestedName}`);

  releaseStreams();
  mixer = null;
  mediaRecorder = null;

  if (discardRequested) {
    diag('save', 'discard requested — blob dropped');
    discardRequested = false;
    saving = false;
    setStatus('Recording cancelled, nothing saved.');
    sendState('IDLE');
    resetToIdle();
    return;
  }

  // The save dialog needs a visible window.
  await restoreOwnWindow();
  const savedName = await saveBlob(blob, suggestedName);
  if (savedName) {
    setStatus(`Saved: ${savedName} (${formatBytes(blob.size)})`);
  } else {
    setStatus('Not saved.');
  }
  saving = false;
  sendState('IDLE');
  resetToIdle();
}

/**
 * Save via File System Access when available; otherwise fall back to an
 * automatic a[download] download. Returns the file name or null.
 */
async function saveBlob(blob, suggestedName) {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      diag('save', 'written via showSaveFilePicker');
      return handle.name || suggestedName;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        diag('save', 'picker cancelled; falling back to direct download');
      } else {
        diag('save', `picker failed: ${err?.name}: ${err?.message}; falling back`);
      }
    }
  }
  // Fallback: straight to Downloads.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  diag('save', 'written via a[download]');
  return suggestedName;
}

// ─── Lifecycle helpers ────────────────────────────────────────────────────────

function releaseStreams() {
  if (combinedStream) combinedStream.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (tabStream) tabStream.getTracks().forEach((t) => t.stop());
  if (mixer) mixer.destroy();
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
  }
  combinedStream = null;
  micStream = null;
  tabStream = null;
}

function resetToIdle() {
  clearInterval(timerInterval);
  timerInterval = null;
  panelRec.hidden = true;
  panelIdle.hidden = false;
  btnStart.disabled = false;
  elTimer.textContent = '00:00:00';
  elSize.textContent = '0 B';
}

window.addEventListener('beforeunload', (e) => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    const msg = 'Recording is in progress. Stop it before closing this window.';
    e.returnValue = msg;
    return msg;
  }
});

// Popup remote control: Stop saves, Cancel discards.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'REC_STOP' && mediaRecorder && mediaRecorder.state === 'recording') {
    diag('ctl', 'REC_STOP from popup');
    stopRecording();
  }
  if (msg.type === 'REC_CANCEL') {
    diag('ctl', 'REC_CANCEL from popup');
    cancelRecording();
  }
});

function cancelRecording() {
  discardRequested = true;
  clearInterval(timerInterval);
  timerInterval = null;
  panelRec.hidden = true;
  setStatus('Cancelling…');
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop(); // onstop -> finalize (discard path)
      return;
    } catch (err) {
      diag('ctl', `stop() threw on cancel: ${err?.message || err}`);
    }
  }
  releaseStreams();
  saving = false;
  discardRequested = false;
  setStatus('Cancelled.');
  sendState('IDLE');
  resetToIdle();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  options.tabTitle    = params.get('tabTitle') || '';
  options.forceMic    = params.get('forceMic') === 'true';
  options.micDeviceId = params.get('micDeviceId') || null;
  options.autostart   = params.get('autostart') === '1';

  elTarget.textContent = options.tabTitle
    ? `Recording target: ${options.tabTitle}`
    : 'Tab Recorder (Firefox)';
  micCheck.checked = options.forceMic;

  const envOk =
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function' &&
    typeof MediaRecorder !== 'undefined';

  if (!envOk) {
    setStatus('getDisplayMedia/MediaRecorder unavailable in this context.');
    showError('Open the popup again to relaunch the recorder.');
    diag('env', 'required APIs missing');
    return;
  }

  btnStart.disabled = false;
  setStatus(
    'Ready. Pick "Browser Tab" in the sharing dialog; enable its audio checkbox for sound.'
  );
  diag('env', `initialized; forceMic=${options.forceMic}; autostart=${options.autostart}`);

  btnStart.addEventListener('click', onStartClick);
  btnStop.addEventListener('click', onStopClick);

  if (options.autostart) {
    // Attempt to jump straight into the picker. A freshly opened window has
    // no user activation, so Firefox may reject the call — then we just fall
    // back to the manual button (already wired above).
    onStartClick();
  }
});
