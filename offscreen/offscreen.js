/**
 * Offscreen document — media pipeline host.
 *
 * Owns the AudioContext, MediaRecorder, and IndexedDB writes for each
 * recording session. All media objects live here because MV3 service
 * workers cannot use getUserMedia, AudioContext, or MediaRecorder.
 *
 * Communication: chrome.runtime.onMessage (SW → offscreen and back).
 * Messages destined for offscreen include { target: 'offscreen' }.
 */

import { AudioMixer } from '../lib/audio-mixer.js';

// ─── Limits ───────────────────────────────────────────────────────────────────
// Production: 5 hours (18 000 s) and 10 GB.
// For quick manual testing, uncomment the DEBUG lines and comment the PROD lines,
// then reload the extension. The test plan references these constant names.
//
// DEBUG — uncomment to trigger limits in ~10 seconds / ~1 KB:
// const TIME_LIMIT_SECONDS = 10;
// const SIZE_LIMIT_BYTES   = 1024;
//
// PROD — comment out when using debug values above:
const TIME_LIMIT_SECONDS = 18000;
const SIZE_LIMIT_BYTES   = 10_737_418_240;
// ─────────────────────────────────────────────────────────────────────────────

// ─── Session state ────────────────────────────────────────────────────────────
let recorder      = null;
let mixer         = null;
let chunks        = [];
let totalBytes    = 0;
let startTime     = null;
let intervalId    = null;
let suggestedName = '';
let tabStream     = null;
let micStream     = null;
let monitorAudio  = null;  // <audio> element that plays tab audio to speakers

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

async function dbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tab-recorder-blobs', 'readwrite');
    tx.objectStore('tab-recorder-blobs').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror    = (e) => reject(e.target.error);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendToSW(message) {
  chrome.runtime.sendMessage({ target: 'sw', ...message }).catch(() => {
    // SW may be sleeping; message delivery is best-effort for non-critical signals.
  });
}

function sendMicDiagnostic(message, details) {
  sendToSW({
    type: 'MIC_DIAGNOSTIC',
    source: 'offscreen',
    message,
    details,
  });
}

function generateUUID() {
  // crypto.randomUUID is available in extension contexts (Chrome 92+)
  return crypto.randomUUID();
}

function stopInterval() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function startInterval() {
  stopInterval();
  intervalId = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

    sendToSW({
      type: 'STATE_UPDATE',
      state: 'RECORDING',
      elapsedSeconds,
      totalBytes,
    });

    // Check limits — whichever threshold is hit first wins
    if (elapsedSeconds >= TIME_LIMIT_SECONDS) {
      triggerLimit('time');
    } else if (totalBytes >= SIZE_LIMIT_BYTES) {
      triggerLimit('size');
    }
  }, 1000);
}

function triggerLimit(reason) {
  stopInterval();
  if (recorder && recorder.state === 'recording') {
    recorder.pause();
  }
  sendToSW({ type: 'LIMIT_REACHED', reason });
}

function startMonitor() {
  if (monitorAudio || !tabStream) return;
  const audioTracks = tabStream.getAudioTracks();
  if (audioTracks.length === 0) return;
  monitorAudio = new Audio();
  monitorAudio.srcObject = new MediaStream(audioTracks);
  monitorAudio.play().catch((err) => {
    console.warn('[offscreen] monitor play error:', err);
  });
}

function stopMonitor() {
  if (!monitorAudio) return;
  monitorAudio.pause();
  monitorAudio.srcObject = null;
  monitorAudio = null;
}

function stopAllTracks() {
  if (tabStream) {
    tabStream.getTracks().forEach((t) => t.stop());
    tabStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

function resetSession() {
  stopInterval();
  stopMonitor();
  recorder      = null;
  mixer         = null;
  chunks        = [];
  totalBytes    = 0;
  startTime     = null;
  suggestedName = '';
  stopAllTracks();
}

// ─── Finalize recording: assemble blob → IndexedDB → notify SW ───────────────

function finalizeRecording() {
  return new Promise((resolve) => {
    if (!recorder) {
      resolve();
      return;
    }

    recorder.onstop = async () => {
      try {
        const blob    = new Blob(chunks, { type: 'video/webm' });
        const blobKey = generateUUID();

        await dbPut(blobKey, blob);

        sendToSW({ type: 'BLOB_READY', blobKey, suggestedName });
      } catch (err) {
        console.error('[offscreen] Failed to finalize recording:', err);
        sendToSW({ type: 'BLOB_READY_ERROR', error: err.message });
      } finally {
        if (mixer) {
          mixer.destroy();
        }
        stopAllTracks();
        chunks = [];
        resolve();
      }
    };

    try {
      recorder.stop();
    } catch (err) {
      console.error('[offscreen] recorder.stop() threw:', err);
      resolve();
    }
  });
}

// ─── START_MEDIA handler ──────────────────────────────────────────────────────

async function handleStartMedia({ streamId, includeMic, forceMic, micDeviceId, suggestedName: name }) {
  console.log('[offscreen] START_MEDIA received. streamId:', streamId, 'includeMic:', includeMic, 'forceMic:', forceMic);
  sendMicDiagnostic('START_MEDIA received', {
    includeMic: Boolean(includeMic),
    forceMic: Boolean(forceMic),
    micDeviceId: micDeviceId || null,
  });

  // Clean up any previous session defensively
  resetSession();
  suggestedName = name || 'recording';

  // 1. Acquire tab stream.
  //    The `mandatory` wrapper is required for chromeMediaSource in offscreen
  //    documents. The flat constraint format (without mandatory) causes Chrome
  //    to treat the request as a regular camera/mic getUserMedia, which triggers
  //    a permission prompt that auto-dismisses — AND partially consumes the
  //    stream ID, making any subsequent attempt produce an empty stream.
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    });
  } catch (err) {
    console.error('[offscreen] getUserMedia failed:', err.name, err.message);
    sendToSW({ type: 'CAPTURE_ERROR', error: `${err.name}: ${err.message}` });
    return;
  }

  // Validate that we actually got usable tracks
  const videoTracks = tabStream.getVideoTracks();
  const audioTracks = tabStream.getAudioTracks();
  console.log('[offscreen] Tab stream acquired.'
    + ` video tracks: ${videoTracks.length}`
    + ` (state: ${videoTracks[0]?.readyState ?? 'n/a'})`
    + ` audio tracks: ${audioTracks.length}`
    + ` (state: ${audioTracks[0]?.readyState ?? 'n/a'})`
  );

  if (videoTracks.length === 0 && audioTracks.length === 0) {
    const msg = 'Tab stream has no video or audio tracks.';
    console.error('[offscreen]', msg);
    sendToSW({ type: 'CAPTURE_ERROR', error: msg });
    return;
  }

  // Log if a track ends unexpectedly during recording
  videoTracks.forEach(t => { t.onended = () => console.warn('[offscreen] Video track ended.'); });
  audioTracks.forEach(t => { t.onended = () => console.warn('[offscreen] Audio track ended.'); });

  // 2. Optionally acquire mic stream
  if (includeMic) {
    const micConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (typeof micDeviceId === 'string' && micDeviceId) {
      micConstraints.deviceId = { exact: micDeviceId };
    } else {
      micConstraints.deviceId = { ideal: 'default' };
    }
    sendMicDiagnostic('Requesting microphone stream', { micConstraints });

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints,
        video: false,
      });
      console.log('[offscreen] Mic stream acquired. tracks:', micStream.getAudioTracks().length);

      const micTrack = micStream.getAudioTracks()[0] || null;
      if (micTrack) {
        sendMicDiagnostic('Mic stream acquired', {
          label: micTrack.label || '',
          enabled: micTrack.enabled,
          muted: micTrack.muted,
          readyState: micTrack.readyState,
          settings: micTrack.getSettings?.() || {},
          constraints: micTrack.getConstraints?.() || {},
        });

        micTrack.onmute = () => {
          sendMicDiagnostic('Mic track muted', {
            enabled: micTrack.enabled,
            muted: micTrack.muted,
            readyState: micTrack.readyState,
          });
        };
        micTrack.onunmute = () => {
          sendMicDiagnostic('Mic track unmuted', {
            enabled: micTrack.enabled,
            muted: micTrack.muted,
            readyState: micTrack.readyState,
          });
        };
        micTrack.onended = () => {
          sendMicDiagnostic('Mic track ended', {
            enabled: micTrack.enabled,
            muted: micTrack.muted,
            readyState: micTrack.readyState,
          });
        };
      } else {
        sendMicDiagnostic('Mic stream acquired but audio track missing');
      }
    } catch (err) {
      sendMicDiagnostic('Microphone getUserMedia failed', {
        errorName: err.name || 'Error',
        errorMessage: err.message || 'unknown',
      });
      if (forceMic) {
        const errText = `Microphone is required but unavailable: ${err.name}: ${err.message}`;
        console.error('[offscreen]', errText);
        sendToSW({ type: 'CAPTURE_ERROR', error: errText });
        stopAllTracks();
        return;
      }

      // Mic failure is non-fatal when mic was optional.
      console.warn('[offscreen] Mic unavailable, falling back to tab audio:', err.name, err.message);
      sendToSW({ type: 'MIC_UNAVAILABLE' });
      micStream = null;
    }
  } else {
    sendMicDiagnostic('Mic capture disabled for this session');
  }

  // 3. Determine codec
  const preferredMime = 'video/webm;codecs=vp9,opus';
  const fallbackMime  = 'video/webm';
  let mimeType;

  if (MediaRecorder.isTypeSupported(preferredMime)) {
    mimeType = preferredMime;
  } else {
    mimeType = fallbackMime;
    sendToSW({ type: 'CODEC_FALLBACK' });
    console.warn('[offscreen] VP9+Opus not supported, using plain WebM fallback');
  }
  console.log('[offscreen] Using mimeType:', mimeType);

  // 4. Build the stream that MediaRecorder will consume.
  //    Offscreen documents have no user gesture, so new AudioContext() starts
  //    in 'suspended' state. A suspended AudioContext's MediaStreamDestination
  //    produces silent/empty tracks → MediaRecorder writes 0-byte chunks.
  //    When mic mixing is needed we explicitly resume() the context.
  //    When no mic is needed we skip AudioContext entirely and pass tabStream
  //    directly to MediaRecorder — no clock issues, no empty chunks.
  let combinedStream;
  if (micStream) {
    const audioContext = new AudioContext();
    await audioContext.resume(); // required — offscreen has no user gesture
    sendMicDiagnostic('AudioContext resumed for mixing', { state: audioContext.state });
    mixer = new AudioMixer(audioContext);
    combinedStream = mixer.mix(tabStream, micStream);
  } else {
    combinedStream = tabStream; // direct pass-through, no AudioContext needed
    sendMicDiagnostic('Using tabStream directly (no mic mixing)');
  }
  console.log('[offscreen] Combined stream tracks:', combinedStream.getTracks().length);
  sendMicDiagnostic('Combined stream ready', {
    totalTracks: combinedStream.getTracks().length,
    audioTracks: combinedStream.getAudioTracks().length,
    videoTracks: combinedStream.getVideoTracks().length,
  });

  // 5. Build MediaRecorder
  recorder = new MediaRecorder(combinedStream, { mimeType });

  // 6. Accumulate chunks and track size
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
      totalBytes += event.data.size;
    }
  };

  recorder.onerror = (event) => {
    console.error('[offscreen] MediaRecorder error:', event.error);
    sendToSW({ type: 'RECORDER_ERROR', error: event.error?.message ?? 'Unknown error' });
  };

  // 7. Start recording with 1-second timeslice
  recorder.start(1000);
  console.log('[offscreen] MediaRecorder started. state:', recorder.state);
  sendMicDiagnostic('MediaRecorder started', {
    recorderState: recorder.state,
    mimeType,
  });

  // 8. Track wall-clock start time and begin broadcasting STATE_UPDATE
  startTime = Date.now();
  startInterval();

  // 9. Start monitoring — play captured audio to speakers by default.
  startMonitor();
}

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Only process messages addressed to this offscreen document
  if (message.target !== 'offscreen') {
    return false;
  }

  switch (message.type) {
    case 'START_MEDIA':
      handleStartMedia(message).catch((err) => {
        console.error('[offscreen] handleStartMedia error:', err);
      });
      break;

    case 'CONFIRM_CONTINUE':
      // Reset limit counters and resume recording
      startTime  = Date.now();
      totalBytes = 0;
      if (recorder && recorder.state === 'paused') {
        recorder.resume();
      }
      startInterval();
      break;

    case 'MONITOR_ON':
      startMonitor();
      break;

    case 'MONITOR_OFF':
      stopMonitor();
      break;

    case 'STOP_MEDIA':
    case 'CONFIRM_STOP_AT_LIMIT':
    case 'TAB_CLOSED_INTERRUPT':
      stopInterval();
      finalizeRecording().catch((err) => {
        console.error('[offscreen] finalizeRecording error:', err);
      });
      break;

    default:
      console.warn('[offscreen] Unknown message type:', message.type);
  }

  // Return false — we respond asynchronously via sendToSW, not sendResponse
  return false;
});
