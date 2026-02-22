/**
 * Content script — injected into the target tab on demand.
 *
 * Queries the Permissions API for microphone state and reports it
 * back to the service worker via chrome.runtime.sendMessage.
 *
 * Only 'granted' state triggers the mic confirmation dialog in the popup.
 * 'denied' and 'prompt' both result in recording without mic prompt.
 *
 * The double-injection guard prevents a duplicate message if the script
 * is somehow executed more than once in the same document.
 */
if (!window.__tabRecorderInjected) {
  window.__tabRecorderInjected = true;

  navigator.permissions
    .query({ name: 'microphone' })
    .then((result) => {
      chrome.runtime.sendMessage({
        type: 'MIC_PERMISSION_STATE',
        state: result.state,
      });
    })
    .catch(() => {
      // Permissions API unavailable or threw (e.g., chrome:// pages).
      // Treat as denied so recording proceeds without mic prompt.
      chrome.runtime.sendMessage({
        type: 'MIC_PERMISSION_STATE',
        state: 'denied',
      });
    });
}
