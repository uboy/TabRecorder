'use strict';

const logEl = document.getElementById('log');
const btnGrant = document.getElementById('btn-grant');
const btnClose = document.getElementById('btn-close');

btnGrant.addEventListener('click', onGrantClick);
btnClose.addEventListener('click', () => window.close());

async function onGrantClick() {
  appendLog('Requesting microphone permission...');
  const permissionBefore = await queryPermission();
  appendLog(`permission(before): ${permissionBefore}`);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { ideal: 'default' } },
      video: false,
    });

    const track = stream.getAudioTracks()[0] || null;
    appendLog('getUserMedia success');
    appendLog(
      safeJson({
        trackLabel: track?.label || '',
        settings: track?.getSettings?.() || {},
        constraints: track?.getConstraints?.() || {},
        readyState: track?.readyState || '',
      })
    );

    stream.getTracks().forEach((t) => t.stop());

    const permissionAfter = await queryPermission();
    appendLog(`permission(after): ${permissionAfter}`);
    appendLog('Done. You can close this tab and start recording from extension popup.');
  } catch (err) {
    appendLog(`getUserMedia failed: ${err?.name || 'Error'}: ${err?.message || 'unknown'}`);
    appendLog('If blocked, open the lock icon in address bar -> Site settings -> Microphone -> Allow.');
  }
}

async function queryPermission() {
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

function appendLog(text) {
  const ts = new Date().toISOString().slice(11, 19);
  logEl.textContent += `\n[${ts}] ${text}`;
  logEl.scrollTop = logEl.scrollHeight;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
