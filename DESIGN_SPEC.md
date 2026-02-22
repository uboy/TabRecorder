# Design Specification: Browser Tab Recorder — Chrome Extension

**Version:** 0.3
**Date:** 2026-02-22
**Status:** Approved for implementation

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 0.1 | 2026-02-22 | Initial draft |
| 0.2 | 2026-02-22 | Resolved open questions: keepalive strategy, recording limits, mic detection UX |
| 0.3 | 2026-02-22 | Architectural corrections from lead-dev review: offscreen document for media pipeline, IndexedDB for Blob transfer, getMediaStreamId for tab capture, wall-clock elapsed tracking, alarms keepalive, showSaveFilePicker pre-open pattern, filename sanitization |

---

## 1. Overview

A Chrome extension (Manifest V3) that captures the full audio/video output of any browser tab. Tab audio is always included. Microphone audio is optionally included when the target tab is detected to be actively using the microphone and the user explicitly consents. Recording continues uninterrupted even when the user navigates to another tab. The popup must remain open during recording. The finished recording is saved via the browser's native Save As dialog.

At 5 hours elapsed **or** 10 GB accumulated, the user is prompted to either continue or stop and save.

---

## 2. Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-01 | User can start a recording of any tab from the extension popup |
| FR-02 | Recorded content includes everything rendered in the tab: video playback, animation, DOM changes, canvas |
| FR-03 | Recorded audio includes only the tab's audio output (no system audio, no other tabs) |
| FR-04 | Before starting, the extension detects whether the target tab has microphone permission granted |
| FR-05 | If mic permission is detected, the user is prompted: "This tab may be using the microphone. Include microphone in recording?" |
| FR-06 | If the user confirms, microphone audio is mixed with tab audio in the output |
| FR-07 | Recording continues when the user switches to another tab; the popup must stay open |
| FR-08 | User can stop the recording from the popup at any time |
| FR-09 | On stop, the browser presents a native Save As dialog; default filename: `<tab-title>_<YYYY-MM-DD_HH-MM-SS>.webm` (illegal filesystem characters replaced with `_`) |
| FR-10 | Output format: WebM (VP9 video + Opus audio; falls back to plain WebM if VP9+Opus is not supported) |
| FR-11 | The popup displays: current state (Idle / Recording), elapsed time (HH:MM:SS), accumulated file size |
| FR-12 | When elapsed time reaches **5 hours** OR accumulated size reaches **10 GB**, recording pauses and a modal prompt appears: "Recording limit reached. Continue recording or stop and save?" |
| FR-13 | If the user chooses Continue at the limit prompt, recording resumes seamlessly and limit counters reset to zero |
| FR-14 | If the user chooses Stop at the limit prompt, the file save flow is triggered (same as FR-09) |
| FR-15 | The popup cannot be closed while recording is active; closing it triggers a browser warning: "Recording in progress. Stop recording before closing." |
| FR-16 | If the mic stream cannot be acquired (user denies browser mic prompt), recording falls back silently to tab-audio-only; the popup displays a brief warning |
| FR-17 | If the recorded tab is closed mid-recording, recording stops, partial data is offered for save, and the popup displays an error |
| FR-18 | If the user cancels the Save As dialog, a retry prompt is shown; declining the retry shows a "recording was not saved" warning before returning to Idle |

---

## 3. Technical Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Chrome Extension (MV3)                                         │
│                                                                 │
│  ┌──────────────┐  long-lived port  ┌──────────────────────┐   │
│  │  popup.html  │◄─────────────────►│  service-worker.js   │   │
│  │  popup.js    │                   │  (coordinator)       │   │
│  └──────────────┘                   │                      │   │
│                                     │  - state machine     │   │
│  ┌──────────────┐     messages      │  - routes messages   │   │
│  │content-script│◄─────────────────►│  - tab monitoring    │   │
│  │  .js         │                   └──────────┬───────────┘   │
│  │(per tab)     │                              │               │
│  └──────────────┘                              │ messages      │
│                                                ▼               │
│                                   ┌────────────────────────┐   │
│                                   │  offscreen.html        │   │
│                                   │  offscreen.js          │   │
│                                   │                        │   │
│                                   │  - owns AudioContext   │   │
│                                   │  - owns MediaRecorder  │   │
│                                   │  - tracks size/time    │   │
│                                   │  - writes IndexedDB    │   │
│                                   └────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
          │                      │
          │ getMediaStreamId     │ getUserMedia (mic)
          ▼                      ▼
    Tab MediaStream (via      Microphone MediaStream
    chromeMediaSource)
          │                      │
          └────────┬─────────────┘
                   ▼
            Web Audio API (AudioContext)
            MediaStreamAudioSourceNode ×2
            GainNode ×2
                   ▼
            MediaStreamDestinationNode (mixed)
                   ▼
            Combined MediaStream
            (tab video + mixed audio)
                   ▼
            MediaRecorder → Blob chunks
                   ▼
            IndexedDB (assembled Blob stored by key)
                   ▼
            popup: showSaveFilePicker (pre-opened handle)
            → FileSystemWritableFileStream.write(blob)
```

### Why an Offscreen Document?

MV3 service workers cannot use `navigator.mediaDevices.getUserMedia`, `AudioContext`, or `MediaRecorder` — these are Window/Worklet APIs unavailable in service worker scope. The `chrome.offscreen` API (Chrome 109+) provides a persistent hidden document that runs in a full renderer process and has access to all media APIs. All stream acquisition, audio mixing, and recording runs inside this document. The service worker acts purely as a coordinator and message router.

---

## 4. Components

### 4.1 Service Worker (`service-worker.js`)

The coordinator. Owns the canonical state machine. Does not touch any media APIs.

**Responsibilities:**
- Long-lived port connection to popup via `chrome.runtime.connect`; uses `chrome.alarms` (every 20 s) as an additional keepalive safeguard
- Receives messages from popup: `START_RECORDING`, `STOP_RECORDING`, `GET_STATE`, `MIC_ANSWER`, `CONFIRM_CONTINUE`, `CONFIRM_STOP_AT_LIMIT`
- Injects content script into target tab via `chrome.scripting.executeScript`
- Receives `MIC_PERMISSION_STATE` from content script; conditionally sends `CONFIRM_MIC` to popup
- Calls `chrome.tabCapture.getMediaStreamId({ targetTabId })` to obtain a stream ID (does not touch the stream itself)
- Creates the offscreen document via `chrome.offscreen.createDocument()` (checks `chrome.offscreen.hasDocument()` first)
- Forwards commands to the offscreen document: `START_MEDIA`, `STOP_MEDIA`, `CONFIRM_CONTINUE`, `CONFIRM_STOP_AT_LIMIT`
- Relays offscreen-originated events to popup: `STATE_UPDATE`, `LIMIT_REACHED`, `BLOB_READY`, `TAB_CLOSED`, `MIC_UNAVAILABLE`, `CODEC_FALLBACK`
- Caches last `STATE_UPDATE` payload to respond to `GET_STATE` immediately on popup (re)open
- Registers `chrome.tabs.onRemoved` to detect target tab closure
- Registers `chrome.alarms.onAlarm` for keepalive ping (alarm name: `"keepalive"`)

**State machine:**

```
IDLE ──[START_RECORDING]──► CONFIRMING_MIC ──[MIC_ANSWER yes|no]──► RECORDING
                                                                         │
                                                              [LIMIT_REACHED]
                                                                         │
                                                                    LIMIT_PAUSED
                                                                    │         │
                                                          [CONFIRM_CONTINUE] [CONFIRM_STOP]
                                                                    │         │
                                                                RECORDING   SAVING
                                                                              │
                                              [STOP_RECORDING or TAB_CLOSED]──┤
                                                                              ▼
                                                                           SAVING
                                                                              │
                                                                    [BLOB_READY → save done]
                                                                              │
                                                                           IDLE
```

> Note: `CONFIRMING_MIC` is skipped entirely when the content script reports mic permission is not `granted`; the state transitions directly from IDLE to RECORDING setup.

### 4.2 Offscreen Document (`offscreen/offscreen.html` + `offscreen/offscreen.js`)

The media host. Runs in a persistent hidden renderer process. Owns all media objects for the lifetime of a recording session.

**Responsibilities:**
- On `START_MEDIA { streamId, includeMic }`:
  1. Acquire tab stream via `getUserMedia({ audio: true, video: true, mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } })`
  2. If `includeMic`: acquire mic stream via `getUserMedia({ audio: true, video: false })`; on failure, send `MIC_UNAVAILABLE` and proceed without mic
  3. Mix audio via `AudioMixer` (see §8)
  4. Check codec support; use VP9+Opus or fall back to plain WebM; send `CODEC_FALLBACK` if fallback used
  5. Create `MediaRecorder`; call `recorder.start(1000)`
  6. Start wall-clock timer (`startTime = Date.now()`)
  7. Start `setInterval` (1 s) broadcasting `STATE_UPDATE` to service worker
- On each `ondataavailable`: push chunk to `chunks[]`, increment `totalBytes`
- On each timer tick: compute `elapsedSeconds = Math.floor((Date.now() - startTime) / 1000)`; check limits; if limit hit: `recorder.pause()`, send `LIMIT_REACHED { reason }`
- On `CONFIRM_CONTINUE`: reset `startTime = Date.now()`, reset `totalBytes = 0`, `recorder.resume()`
- On `STOP_MEDIA` or `CONFIRM_STOP_AT_LIMIT`:
  1. `recorder.stop()`
  2. In `onstop`: assemble `new Blob(chunks, { type: 'video/webm' })`
  3. Write Blob to IndexedDB under a UUID key
  4. Send `BLOB_READY { blobKey, suggestedName }` to service worker
  5. Call `AudioMixer.destroy()`, stop all stream tracks, clear `chunks[]`
- On `TAB_CLOSED_INTERRUPT`: treat identically to `STOP_MEDIA`

### 4.3 Popup (`popup/popup.html` + `popup/popup.js`)

**UI states and elements:**

```
┌──────────────────────────────────┐  width: 320px
│  Tab Recorder                    │
├──────────────────────────────────┤
│  Tab: "Google Meet – Daily St…"  │  ← max 30 chars, ellipsis
│                                  │
│  ── IDLE ──                      │
│  ○  Ready to record              │
│  [ Start Recording ]             │
│                                  │
│  ── CONFIRMING_MIC ──            │
│  This tab may be using the       │
│  microphone. Include it?         │
│  [ Yes ]  [ No ]                 │
│                                  │
│  ── RECORDING ──                 │
│  ●  Recording   01:23:45         │  ← animated red dot, HH:MM:SS
│  Size: 2.3 GB                    │
│  [ Stop & Save ]                 │
│                                  │
│  ── LIMIT_PAUSED ──              │
│  ⚠  Limit reached. Paused.      │
│  [ Continue ]  [ Stop & Save ]   │
│                                  │
│  ── SAVING ──                    │
│  Saving…                         │
│                                  │
│  ── ERROR (TAB_CLOSED) ──        │
│  Tab was closed. Recording       │
│  stopped.                        │
│  [ Save partial ]  [ Discard ]   │
└──────────────────────────────────┘
```

**Popup behaviors:**
- On `DOMContentLoaded`: establish long-lived port via `chrome.runtime.connect`; send `GET_STATE`; query active tab title
- On `GET_STATE` response: render state from cached `{ state, elapsedSeconds, totalBytes }`
- Start button: opens `showSaveFilePicker()` immediately (pre-opens the file handle while gesture is active), stores the `FileSystemFileHandle`; sends `START_RECORDING { tabId, tabTitle }`
- Stop button: sends `STOP_RECORDING`
- On `CONFIRM_MIC`: render mic confirmation panel
- On `MIC_ANSWER`: send to service worker
- On `STATE_UPDATE`: update timer (HH:MM:SS) and size display
- On `MIC_UNAVAILABLE`: show transient warning banner "Mic unavailable — recording tab audio only"
- On `LIMIT_REACHED`: render LIMIT_PAUSED panel
- Continue button: sends `CONFIRM_CONTINUE`
- Stop & Save (limit): sends `CONFIRM_STOP_AT_LIMIT`
- On `BLOB_READY { blobKey, suggestedName }`: read Blob from IndexedDB by key; write to the pre-opened `FileSystemFileHandle`; on `AbortError` (user cancelled), show retry prompt; on retry decline, show "Recording not saved" and return to Idle; delete IndexedDB entry after write or discard
- On `TAB_CLOSED`: render TAB_CLOSED error; "Save partial" triggers save flow; "Discard" returns to Idle
- `window.onbeforeunload`: return warning string when state is RECORDING or LIMIT_PAUSED

> **Why pre-open the file handle on Start?** `showSaveFilePicker()` requires a transient user activation (the click gesture). By the time `BLOB_READY` arrives (potentially minutes later), the gesture has long expired. Pre-opening on Start (which is a click) captures the activation. The file is written when the Blob is ready.

### 4.4 Content Script (`content/content-script.js`)

Injected into the target tab on demand. Executes once and sends a single message.

```js
// Guard against double-injection
if (!window.__tabRecorderInjected) {
  window.__tabRecorderInjected = true;
  navigator.permissions
    .query({ name: 'microphone' })
    .then(r => chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_STATE', state: r.state }))
    .catch(() => chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_STATE', state: 'denied' }));
}
```

Only `'granted'` triggers the mic confirmation dialog in the popup. `'denied'` and `'prompt'` skip it.

---

## 5. Data Flow — Recording Lifecycle

```
User clicks [Start]
      │
      ├─ popup opens showSaveFilePicker() → stores fileHandle
      │
popup.js ──MSG(START_RECORDING, { tabId, tabTitle })──► service-worker.js
                                                               │
                                               chrome.scripting.executeScript
                                               → inject content-script.js
                                                               │
                                               content-script: Permissions API query
                                               ──MSG(MIC_PERMISSION_STATE)──► SW
                                                               │
                                                   ┌───────────┴────────────┐
                                                   │  state === 'granted'?  │
                                                   └───┬───────────────┬────┘
                                                      YES              NO
                                                       │                │
                                             MSG(CONFIRM_MIC)──►popup   │
                                             user: [Yes] or [No]        │
                                             MSG(MIC_ANSWER)──►SW       │
                                                       │                │
                                                       └────────┬───────┘
                                                                │
                                           chrome.tabCapture.getMediaStreamId(tabId)
                                           → streamId
                                                                │
                                           chrome.offscreen.createDocument()
                                                                │
                                           MSG(START_MEDIA, { streamId, includeMic })
                                           ──► offscreen.js
                                                                │
                                           offscreen:
                                           getUserMedia(tab stream via streamId)
                                           [if includeMic] getUserMedia(mic)
                                           → on failure: MSG(MIC_UNAVAILABLE) ──► SW ──► popup
                                           AudioMixer.mix(tabStream, micStream?)
                                           new MediaRecorder(combinedStream)
                                           recorder.start(1000)
                                           startTime = Date.now()
                                                                │
                                           state ─► RECORDING
                                           MSG(STATE_UPDATE) ──► SW ──► popup  [every 1s]

                           ┌────────────────────────────────────────┐
                           │  ondataavailable (every ~1s):           │
                           │  chunks.push(event.data)                │
                           │  totalBytes += event.data.size          │
                           │                                         │
                           │  setInterval tick:                      │
                           │  elapsedSeconds =                       │
                           │    (Date.now() - startTime) / 1000      │
                           │                                         │
                           │  if elapsedSeconds >= 18000             │
                           │  OR totalBytes >= 10_737_418_240:       │
                           │    recorder.pause()                     │
                           │    MSG(LIMIT_REACHED { reason })        │
                           │    ──► SW ──► popup                     │
                           │                                         │
                           │    [Continue]:                          │
                           │      startTime = Date.now()             │
                           │      totalBytes = 0                     │
                           │      recorder.resume()                  │
                           │                                         │
                           │    [Stop & Save]: → stop flow           │
                           └────────────────────────────────────────┘

User clicks [Stop & Save]
      │
popup ──MSG(STOP_RECORDING)──► SW ──MSG(STOP_MEDIA)──► offscreen
                                                            │
                                                     recorder.stop()
                                                     onstop:
                                                       blob = new Blob(chunks)
                                                       IndexedDB.put(blobKey, blob)
                                                     MSG(BLOB_READY { blobKey, suggestedName })
                                                     ──► SW ──► popup
                                                            │
                                                     popup:
                                                       blob = IndexedDB.get(blobKey)
                                                       writable = fileHandle.createWritable()
                                                       writable.write(blob)
                                                       writable.close()
                                                       IndexedDB.delete(blobKey)
                                                            │
                                                     state ─► IDLE
```

---

## 6. Limit Handling Detail

Limits are `OR` — whichever threshold is hit first triggers the prompt. Counters reset to zero on Continue, giving the user another full 5 h / 10 GB window. The accumulated Blob chunks are **not** discarded on Continue; they grow across all windows and are all assembled at the final stop.

```
Session start (startTime₀)
│
├── elapsed ~5h → LIMIT_REACHED (reason: 'time')
│     user: [Continue]
│     startTime reset to now; totalBytes reset to 0
│
├── elapsed another ~5h → LIMIT_REACHED (reason: 'time')
│     user: [Stop & Save]
│     → all chunks (10h worth) assembled into one Blob
│     → save flow
```

---

## 7. Chrome Extension Manifest

```json
{
  "manifest_version": 3,
  "name": "Tab Recorder",
  "version": "1.0.0",
  "permissions": [
    "tabCapture",
    "tabs",
    "scripting",
    "storage",
    "microphone",
    "alarms",
    "offscreen"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "service-worker.js"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "32": "icons/icon32.png"
    }
  },
  "icons": {
    "32": "icons/icon32.png",
    "128": "icons/icon128.png"
  }
}
```

Changes from v0.2: added `"alarms"`, `"offscreen"` permissions; corrected popup path to `"popup/popup.html"`.

---

## 8. Audio Mixing Design (`lib/audio-mixer.js`)

```js
// Public API (ES module)
export class AudioMixer {
  constructor(audioContext) { /* ... */ }

  // Returns a MediaStream containing one mixed audio track
  mix(tabStream, micStream = null) { /* ... */ }

  // Disconnects all nodes; call when recording stops
  destroy() { /* ... */ }
}
```

**Internal graph:**

```
tabStream ──► MediaStreamAudioSourceNode ──► GainNode (1.0) ──┐
                                                               ├──► MediaStreamDestinationNode
micStream ──► MediaStreamAudioSourceNode ──► GainNode (1.0) ──┘

output = new MediaStream([
  tabStream.getVideoTracks()[0],
  destination.stream.getAudioTracks()[0]
])
```

- `AudioContext` is created inside `offscreen.js` and passed into `AudioMixer` (keeps the class testable in isolation)
- `GainNode` instances at fixed 1.0 are hooks for future independent level control
- `destroy()` disconnects all nodes and calls `audioContext.close()`

---

## 9. Message Protocol

Long-lived port (via `chrome.runtime.connect`) is used between popup and service worker for `STATE_UPDATE` broadcasts. All other messages use `chrome.runtime.sendMessage`.

### Popup ↔ Service Worker

| Message | Direction | Payload | Description |
|---------|-----------|---------|-------------|
| `START_RECORDING` | popup → SW | `{ tabId, tabTitle }` | Begin capture flow |
| `STOP_RECORDING` | popup → SW | — | Stop and enter save flow |
| `GET_STATE` | popup → SW | — | Request current state snapshot |
| `MIC_ANSWER` | popup → SW | `{ include: boolean }` | User mic inclusion decision |
| `CONFIRM_CONTINUE` | popup → SW | — | User chose Continue at limit |
| `CONFIRM_STOP_AT_LIMIT` | popup → SW | — | User chose Stop at limit |
| `CONFIRM_MIC` | SW → popup | — | Prompt user about microphone |
| `STATE_UPDATE` | SW → popup | `{ state, elapsedSeconds, totalBytes }` | Periodic 1-second broadcast |
| `LIMIT_REACHED` | SW → popup | `{ reason: 'time'│'size' }` | Threshold hit; recording paused |
| `BLOB_READY` | SW → popup | `{ blobKey: string, suggestedName: string }` | Blob written to IndexedDB; trigger save |
| `TAB_CLOSED` | SW → popup | — | Recorded tab was closed |
| `MIC_UNAVAILABLE` | SW → popup | — | Mic acquisition failed; fell back to tab audio only |
| `CODEC_FALLBACK` | SW → popup | — | VP9+Opus not supported; using plain WebM |

### Service Worker ↔ Offscreen Document

| Message | Direction | Payload | Description |
|---------|-----------|---------|-------------|
| `START_MEDIA` | SW → offscreen | `{ streamId, includeMic }` | Begin media pipeline |
| `STOP_MEDIA` | SW → offscreen | — | Stop recording, assemble, store |
| `CONFIRM_CONTINUE` | SW → offscreen | — | Resume after limit |
| `CONFIRM_STOP_AT_LIMIT` | SW → offscreen | — | Stop at limit |
| `TAB_CLOSED_INTERRUPT` | SW → offscreen | — | Tab closed; stop and assemble partial |
| `STATE_UPDATE` | offscreen → SW | `{ state, elapsedSeconds, totalBytes }` | Relayed to popup |
| `LIMIT_REACHED` | offscreen → SW | `{ reason }` | Relayed to popup |
| `BLOB_READY` | offscreen → SW | `{ blobKey, suggestedName }` | Relayed to popup |
| `MIC_UNAVAILABLE` | offscreen → SW | — | Relayed to popup |
| `CODEC_FALLBACK` | offscreen → SW | — | Relayed to popup |

### Content Script → Service Worker

| Message | Direction | Payload | Description |
|---------|-----------|---------|-------------|
| `MIC_PERMISSION_STATE` | content → SW | `{ state: 'granted'│'denied'│'prompt' }` | Result of Permissions API query |

---

## 10. Blob Transfer Strategy

Sending a multi-gigabyte Blob through `chrome.runtime.sendMessage` is not reliable (Chrome's IPC serialization limit). Instead:

1. **Offscreen document** assembles the Blob and writes it to **IndexedDB** under a UUID key (`"tab-recorder-blobs"` store)
2. **Service worker** relays `BLOB_READY { blobKey, suggestedName }` to popup
3. **Popup** opens its own connection to the same IndexedDB, retrieves the Blob by key, and writes it to the file system via the pre-opened `FileSystemFileHandle`
4. **Popup** deletes the IndexedDB entry after write completes (or after user discards)

All three contexts (offscreen, service worker, popup) share the same extension origin and can access the same IndexedDB database.

---

## 11. showSaveFilePicker Pre-Open Pattern

```
User clicks [Start Recording]
      │
      ├── showSaveFilePicker({ suggestedName: placeholder, ... })
      │   (user gesture is active here — the click)
      │   → fileHandle stored in popup module scope
      │
      ... recording in progress ...
      │
User clicks [Stop & Save]
      │
      ... BLOB_READY arrives ...
      │
      ├── blob = await IndexedDB.get(blobKey)
      ├── writable = await fileHandle.createWritable()
      ├── await writable.write(blob)
      └── await writable.close()
```

The placeholder `suggestedName` at Start time uses the tab title captured when Start is clicked. If the user cancels the `showSaveFilePicker` at Start, the `START_RECORDING` message is not sent — recording never begins.

---

## 12. Filename Sanitization

Tab titles may contain characters illegal in Windows filenames (`\ / : * ? " < > |`) or macOS filenames (`/`). The suggested filename is constructed as:

```js
function buildFilename(tabTitle, startDate) {
  const safe = tabTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const ts = startDate.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  return `${safe}_${ts}.webm`;
}
```

Example: `"Google Meet – Daily Stand…up"` → `"Google Meet – Daily Stand_up_2026-02-22_09-30-00.webm"`

---

## 13. Elapsed Time Tracking

Elapsed time is tracked using wall-clock time, not chunk count:

```js
let startTime;      // Date.now() at recorder.start() or after Continue
let elapsedSeconds; // updated each setInterval tick

// On start / continue:
startTime = Date.now();

// In setInterval (every 1000ms):
elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
```

Limit check: `elapsedSeconds >= 18000` (5 h = 18 000 s).

---

## 14. File Structure

```
/
├── manifest.json
├── service-worker.js
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── content/
│   └── content-script.js
├── lib/
│   └── audio-mixer.js
└── icons/
    ├── icon32.png
    └── icon128.png
```

---

## 15. Constraints & Known Limitations

| # | Constraint | Impact |
|---|------------|--------|
| L-01 | `chrome.tabCapture.getMediaStreamId()` requires the target tab to be active (foreground) when called | User must have the target tab in focus when pressing Start; recording continues in background after that |
| L-02 | Popup must remain open for the duration of recording | `beforeunload` warning fires if user attempts to close; forcing it closed terminates the recording |
| L-03 | Mic detection via Permissions API signals "permission was granted", not "mic is actively streaming" | May produce a false-positive mic prompt; accepted for MVP |
| L-04 | Offscreen document requires Chrome 109+ | Extension will not work on Chrome < 109 |
| L-05 | `showSaveFilePicker` must be called during a user gesture; pre-opened at Start time | If the user cancels the dialog at Start, recording does not begin |
| L-06 | Blob chunks accumulate in offscreen memory until stop, then written to IndexedDB | Combined limit of IndexedDB quota (~80% of available disk) applies; practical limit enforced at 10 GB / 5 h |
| L-07 | WebM is not natively playable on all platforms without codec support | Documented trade-off; MP4 remux is out of scope for MVP |
| L-08 | `tabCapture` does not capture content from cross-origin isolated iframes (`Cross-Origin-Opener-Policy`) in some edge cases | Known Chrome platform limitation; no workaround |
| L-09 | `MediaRecorder` pause/resume may produce timestamp discontinuities in the WebM stream | Acceptance tested in TASK-703; players that handle WebM seeking may show gaps at the limit boundary |

---

## 16. Out of Scope (MVP)

- Recording multiple tabs simultaneously
- User-initiated pause / resume (limit-triggered pause is in scope)
- Custom bitrate / resolution / quality settings
- Cloud / remote upload
- In-tab overlay or HUD
- MP4 output or post-processing
- Screenshot / snapshot mode
- Scheduled / timer-based recording
- Independent mic/tab volume control (GainNode hooks are present for future use)
