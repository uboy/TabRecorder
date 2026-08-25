/**
 * recorder.js — standalone Firefox recording page.
 *
 * Phase 1 skeleton: parses startup options, verifies environment,
 * enables the Start button. Capture/encode/save arrives in phase 2.
 */

'use strict';

const elTarget = document.getElementById('rec-target');
const elStatus = document.getElementById('rec-status');
const elError  = document.getElementById('rec-error');
const elDiag   = document.getElementById('rec-diag');
const btnStart = document.getElementById('btn-rec-start');

const options = {
  tabTitle: '',
  forceMic: false,
  micDeviceId: null,
};

function diag(source, message) {
  const ts = new Date().toISOString().slice(11, 19);
  elDiag.textContent += `[${ts}] [${source}] ${message}\n`;
  elDiag.scrollTop = elDiag.scrollHeight;
}

function showError(message) {
  elError.textContent = message;
  elError.hidden = false;
}

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  options.tabTitle  = params.get('tabTitle') || '';
  options.forceMic  = params.get('forceMic') === 'true';
  options.micDeviceId = params.get('micDeviceId') || null;

  elTarget.textContent = options.tabTitle
    ? `Recording target: ${options.tabTitle}`
    : 'Tab Recorder (Firefox)';

  const envOk =
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function';

  if (!envOk) {
    elStatus.textContent = 'getDisplayMedia unavailable in this context.';
    showError('This page cannot access getDisplayMedia. Open the popup again.');
    diag('env', 'getDisplayMedia missing');
    return;
  }

  elStatus.textContent = `Ready. forceMic=${options.forceMic}` +
    (options.micDeviceId ? `, micDeviceId set` : '');
  btnStart.disabled = false;
  diag('env', 'Recorder page initialized (phase 1 skeleton)');
});
