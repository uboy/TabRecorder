'use strict';

const DB_VERSION = 2;
const BLOB_STORE = 'tab-recorder-blobs';

const params = new URLSearchParams(window.location.search);
const blobKey = params.get('blobKey') || '';
const suggestedName = params.get('suggestedName') || 'recording.webm';
const recoveryReason = params.get('reason') || 'unknown';

const elStatus = document.getElementById('status');
const elLog = document.getElementById('log');
const btnRetryDownload = document.getElementById('btn-retry-download');
const btnManualDownload = document.getElementById('btn-manual-download');
const btnCleanup = document.getElementById('btn-cleanup');

let currentBlob = null;
let currentObjectUrl = null;
let recoveryCompleted = false;

function log(message, details) {
  const now = new Date();
  const ts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join(':');
  const parts = [`[${ts}] ${message}`];
  if (details !== undefined) {
    try {
      parts.push(JSON.stringify(details));
    } catch {
      parts.push(String(details));
    }
  }
  elLog.textContent += `\n${parts.join(' | ')}`;
  elLog.scrollTop = elLog.scrollHeight;
}

function setStatus(text, variant = '') {
  elStatus.textContent = text;
  elStatus.className = `status${variant ? ` ${variant}` : ''}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tab-recorder-db', DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE);
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, 'readonly');
    const req = tx.objectStore(BLOB_STORE).get(key);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, 'readwrite');
    tx.objectStore(BLOB_STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
}

function ensureObjectUrl(blob) {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }
  currentObjectUrl = URL.createObjectURL(blob);
  btnManualDownload.href = currentObjectUrl;
  btnManualDownload.download = suggestedName;
  btnManualDownload.hidden = false;
}

async function loadBlob() {
  if (!blobKey) {
    throw new Error('Missing blobKey');
  }
  currentBlob = await dbGet(blobKey);
  if (!currentBlob) {
    throw new Error('Recording blob not found in IndexedDB');
  }
  ensureObjectUrl(currentBlob);
  log('Blob loaded for recovery', {
    blobKey,
    suggestedName,
    sizeBytes: currentBlob.size,
    reason: recoveryReason,
  });
}

async function finalizeSuccess(details = {}) {
  await dbDelete(blobKey).catch(() => {});
  recoveryCompleted = true;
  chrome.runtime.sendMessage({
    type: 'RECOVERY_SAVE_FINISHED',
    blobKey,
    details,
  }).catch(() => {});
  setStatus('Recovery download completed.', 'ok');
  log('Recovery completed', details);
}

function notifyFailure(error) {
  chrome.runtime.sendMessage({
    type: 'RECOVERY_SAVE_FAILED',
    blobKey,
    error,
  }).catch(() => {});
}

async function startEmergencyDownload() {
  if (!currentBlob) {
    await loadBlob();
  }

  setStatus('Trying emergency browser download...', 'warn');
  log('Starting emergency browser download', {
    blobKey,
    suggestedName,
  });

  if (!chrome.downloads || !chrome.downloads.download) {
    const message = 'chrome.downloads API is unavailable';
    log(message);
    notifyFailure(message);
    setStatus('Automatic recovery download is unavailable. Use manual download below.', 'warn');
    return;
  }

  chrome.downloads.download({
    url: currentObjectUrl,
    filename: suggestedName,
    saveAs: false,
    conflictAction: 'uniquify',
  }, (downloadId) => {
    const lastError = chrome.runtime.lastError;
    if (lastError || !downloadId) {
      const errorText = lastError?.message || 'Download API did not return an id';
      log('Emergency browser download failed to start', { error: errorText });
      notifyFailure(errorText);
      setStatus('Automatic recovery download failed to start. Use manual download below.', 'warn');
      return;
    }

    log('Emergency browser download started', { downloadId });
    setStatus('Emergency browser download started...', 'warn');

    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) {
        return;
      }

      if (delta.state.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        finalizeSuccess({ downloadId }).catch((err) => {
          log('Recovery cleanup failed after completed download', {
            error: err?.message || String(err),
          });
        });
      } else if (delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        const errorText = delta.error?.current || 'download interrupted';
        log('Emergency browser download interrupted', { downloadId, error: errorText });
        notifyFailure(errorText);
        setStatus('Automatic recovery download was interrupted. Use manual download below.', 'warn');
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function cleanupAfterManualSave() {
  await dbDelete(blobKey).catch(() => {});
  chrome.runtime.sendMessage({
    type: 'RECOVERY_SAVE_FINISHED',
    blobKey,
    details: { manual: true },
  }).catch(() => {});
  setStatus('Cleanup completed. You can close this tab.', 'ok');
  log('Manual save cleanup completed', { blobKey });
}

btnRetryDownload.addEventListener('click', () => {
  startEmergencyDownload().catch((err) => {
    log('Retry emergency download failed', {
      error: err?.message || String(err),
    });
    setStatus('Emergency download retry failed. Use manual download below.', 'warn');
  });
});

btnCleanup.addEventListener('click', () => {
  cleanupAfterManualSave().catch((err) => {
    log('Cleanup failed', { error: err?.message || String(err) });
    setStatus('Cleanup failed. The blob is still preserved.', 'warn');
  });
});

window.addEventListener('beforeunload', () => {
  if (!recoveryCompleted && blobKey) {
    chrome.runtime.sendMessage({
      type: 'RECOVERY_SAVE_FAILED',
      blobKey,
      error: 'recovery-page-closed',
    }).catch(() => {});
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }
});

(async () => {
  try {
    await loadBlob();
    setStatus('Recovery blob loaded. Starting emergency download...', 'warn');
    await startEmergencyDownload();
  } catch (err) {
    log('Recovery bootstrap failed', {
      error: err?.message || String(err),
      blobKey,
      suggestedName,
      reason: recoveryReason,
    });
    notifyFailure(err?.message || String(err));
    setStatus('Recovery bootstrap failed. Manual save is unavailable because the blob was not loaded.', 'warn');
  }
})();
