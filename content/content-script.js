/**
 * Content script — injected into the target tab on demand.
 *
 * Queries the Permissions API for microphone state and reports it
 * back to the service worker via chrome.runtime.sendMessage.
 * Also owns an optional pointer overlay that can be toggled from the popup.
 *
 * The double-injection guard prevents a duplicate message if the script
 * is somehow executed more than once in the same document.
 */
if (!window.__tabRecorderInjected) {
  window.__tabRecorderInjected = true;

  const POINTER_ID = '__tab-recorder-pointer-overlay';
  const INTERACTION_LOCK_ID = '__tab-recorder-interaction-lock';
  const LOCK_OVERLAY_Z_INDEX = '2147483646';
  const LOCK_OVERLAY_EVENTS = [
    'pointerdown',
    'pointerup',
    'pointermove',
    'pointercancel',
    'pointerover',
    'pointerout',
    'pointerenter',
    'pointerleave',
    'mousedown',
    'mouseup',
    'mousemove',
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'wheel',
    'touchstart',
    'touchmove',
    'touchend',
    'touchcancel',
    'dragstart',
    'drop',
  ];
  const LOCK_WINDOW_EVENTS = [
    'keydown',
    'keyup',
    'keypress',
    'beforeinput',
    'input',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'paste',
    'copy',
    'cut',
    'focus',
    'blur',
  ];
  const LOCK_DOCUMENT_EVENTS = [
    'visibilitychange',
    'focusin',
    'focusout',
  ];

  let pointerEnabled = false;
  let pointerEl = null;
  let rafPending = false;
  let mouseX = -9999;
  let mouseY = -9999;
  let interactionLockEnabled = false;
  let interactionLockEl = null;
  let lockBodyHadInertAttr = false;
  let lockBodyInert = false;
  let lockDocHadInertAttr = false;
  let lockDocInert = false;

  function reportMicPermissionState() {
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

  function ensurePointerElement() {
    if (pointerEl && pointerEl.isConnected) return pointerEl;

    const existing = document.getElementById(POINTER_ID);
    if (existing) {
      pointerEl = existing;
      return pointerEl;
    }

    pointerEl = document.createElement('div');
    pointerEl.id = POINTER_ID;
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

    const host = document.documentElement || document.body;
    host.appendChild(pointerEl);
    return pointerEl;
  }

  function flushPointerPosition() {
    rafPending = false;
    const el = ensurePointerElement();
    el.style.transform = `translate3d(${mouseX}px, ${mouseY}px, 0)`;
    el.style.opacity = '1';
  }

  function onMouseMove(event) {
    mouseX = event.clientX;
    mouseY = event.clientY;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(flushPointerPosition);
    }
  }

  function onMouseLeave() {
    if (!pointerEl) return;
    pointerEl.style.opacity = '0';
  }

  function onMouseEnter() {
    if (!pointerEnabled || !pointerEl) return;
    pointerEl.style.opacity = '1';
  }

  function enablePointerOverlay() {
    if (pointerEnabled) return;
    pointerEnabled = true;
    ensurePointerElement();
    window.addEventListener('mousemove', onMouseMove, { passive: true, capture: true });
    window.addEventListener('mouseleave', onMouseLeave, { passive: true });
    window.addEventListener('mouseenter', onMouseEnter, { passive: true });
  }

  function disablePointerOverlay() {
    if (!pointerEnabled) return;
    pointerEnabled = false;
    window.removeEventListener('mousemove', onMouseMove, { capture: true });
    window.removeEventListener('mouseleave', onMouseLeave);
    window.removeEventListener('mouseenter', onMouseEnter);
    if (pointerEl) {
      pointerEl.remove();
      pointerEl = null;
    }
  }

  function blockInteractionEvent(event) {
    if (!interactionLockEnabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function addInteractionLockGlobalListeners() {
    LOCK_WINDOW_EVENTS.forEach((eventType) => {
      window.addEventListener(eventType, blockInteractionEvent, { capture: true, passive: false });
    });
    LOCK_DOCUMENT_EVENTS.forEach((eventType) => {
      document.addEventListener(eventType, blockInteractionEvent, { capture: true, passive: false });
    });
  }

  function removeInteractionLockGlobalListeners() {
    LOCK_WINDOW_EVENTS.forEach((eventType) => {
      window.removeEventListener(eventType, blockInteractionEvent, { capture: true });
    });
    LOCK_DOCUMENT_EVENTS.forEach((eventType) => {
      document.removeEventListener(eventType, blockInteractionEvent, { capture: true });
    });
  }

  function rememberInertState() {
    const docEl = document.documentElement;
    const body = document.body;
    lockDocHadInertAttr = docEl.hasAttribute('inert');
    lockDocInert = Boolean(docEl.inert);
    if (body) {
      lockBodyHadInertAttr = body.hasAttribute('inert');
      lockBodyInert = Boolean(body.inert);
    } else {
      lockBodyHadInertAttr = false;
      lockBodyInert = false;
    }
  }

  function applyInertState() {
    const docEl = document.documentElement;
    const body = document.body;
    docEl.inert = true;
    if (body) {
      body.inert = true;
    }
  }

  function restoreInertState() {
    const docEl = document.documentElement;
    const body = document.body;

    docEl.inert = lockDocInert;
    if (!lockDocHadInertAttr) {
      docEl.removeAttribute('inert');
    }

    if (!body) return;
    body.inert = lockBodyInert;
    if (!lockBodyHadInertAttr) {
      body.removeAttribute('inert');
    }
  }

  function ensureInteractionLockElement() {
    if (interactionLockEl && interactionLockEl.isConnected) return interactionLockEl;

    const existing = document.getElementById(INTERACTION_LOCK_ID);
    if (existing) {
      interactionLockEl = existing;
      return interactionLockEl;
    }

    interactionLockEl = document.createElement('div');
    interactionLockEl.id = INTERACTION_LOCK_ID;
    interactionLockEl.tabIndex = 0;
    interactionLockEl.setAttribute('aria-hidden', 'true');
    interactionLockEl.style.position = 'fixed';
    interactionLockEl.style.left = '0';
    interactionLockEl.style.top = '0';
    interactionLockEl.style.width = '100vw';
    interactionLockEl.style.height = '100vh';
    interactionLockEl.style.background = 'transparent';
    interactionLockEl.style.zIndex = LOCK_OVERLAY_Z_INDEX;
    interactionLockEl.style.pointerEvents = 'auto';
    interactionLockEl.style.touchAction = 'none';
    interactionLockEl.style.userSelect = 'none';
    interactionLockEl.style.webkitUserSelect = 'none';
    interactionLockEl.style.cursor = 'default';

    LOCK_OVERLAY_EVENTS.forEach((eventType) => {
      interactionLockEl.addEventListener(eventType, blockInteractionEvent, {
        capture: true,
        passive: false,
      });
    });

    const host = document.documentElement || document.body;
    host.appendChild(interactionLockEl);
    return interactionLockEl;
  }

  function destroyInteractionLockElement() {
    if (!interactionLockEl) return;

    LOCK_OVERLAY_EVENTS.forEach((eventType) => {
      interactionLockEl.removeEventListener(eventType, blockInteractionEvent, { capture: true });
    });

    if (interactionLockEl.isConnected) {
      interactionLockEl.remove();
    }
    interactionLockEl = null;
  }

  function enableInteractionLock() {
    if (interactionLockEnabled) return;
    interactionLockEnabled = true;

    rememberInertState();
    applyInertState();
    addInteractionLockGlobalListeners();

    const blocker = ensureInteractionLockElement();

    const activeEl = document.activeElement;
    if (activeEl && typeof activeEl.blur === 'function') {
      activeEl.blur();
    }

    try {
      blocker.focus({ preventScroll: true });
    } catch {
      // Best effort only.
    }
  }

  function disableInteractionLock() {
    if (!interactionLockEnabled) return;
    interactionLockEnabled = false;
    removeInteractionLockGlobalListeners();
    destroyInteractionLockElement();
    restoreInertState();
  }

  reportMicPermissionState();

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) {
      return false;
    }

    if (message.type === 'REQUEST_MIC_PERMISSION_STATE') {
      reportMicPermissionState();
      return false;
    }

    if (message.type === 'SET_INTERACTION_LOCK') {
      if (message.enabled) {
        enableInteractionLock();
      } else {
        disableInteractionLock();
      }
      return false;
    }

    if (message.type === 'SET_POINTER_OVERLAY') {
      if (message.enabled) {
        enablePointerOverlay();
      } else {
        disablePointerOverlay();
      }
    }

    return false;
  });

  window.addEventListener('pagehide', () => {
    disablePointerOverlay();
    disableInteractionLock();
  });
}
