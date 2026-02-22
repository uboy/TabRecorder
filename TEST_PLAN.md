# Test Plan: Browser Tab Recorder — Chrome Extension

**Version:** 1.0
**Date:** 2026-02-22
**Spec ref:** DESIGN_SPEC.md v0.3
**Status:** Ready for execution

---

## 1. Scope

This plan verifies all 18 functional requirements (FR-01 through FR-18) and the known architectural constraints (L-01 through L-09) from the design spec. Tests are written for manual execution in Chrome. Where file validation is required, `ffprobe` (from FFmpeg) is used.

Out of scope: performance benchmarking, cross-browser testing, accessibility auditing.

---

## 2. Test Environment

| Item | Requirement |
|------|-------------|
| Browser | Google Chrome 116+ (offscreen document support) |
| Extension load | Developer mode → "Load unpacked" |
| Video source | YouTube or any tab with embedded `<video>` element |
| Mic test tab | `https://webcamtests.com/` or `https://meet.google.com/` (mic permission granted before test) |
| File validator | `ffprobe -v error -show_streams <file>.webm` |
| Debug constants | `DEBUG_TIME_LIMIT_SECONDS = 10` and `DEBUG_SIZE_LIMIT_BYTES = 1024` available in `offscreen.js` |

---

## 3. Priority Legend

| Priority | Meaning |
|----------|---------|
| **P1 – Critical** | Blocks the primary user flow; ship-stopper if failing |
| **P2 – High** | Core feature; must pass before release |
| **P3 – Medium** | Important quality signal; should pass |
| **P4 – Low** | Nice to have; document if failing |

---

## 4. Test Suites

- [Suite 1 — Installation & Manifest](#suite-1--installation--manifest)
- [Suite 2 — Basic Recording](#suite-2--basic-recording-fr-01-fr-02-fr-03)
- [Suite 3 — Microphone Detection & Mixing](#suite-3--microphone-detection--mixing-fr-04-fr-05-fr-06-fr-16)
- [Suite 4 — Tab Switch Behavior](#suite-4--tab-switch-behavior-fr-07)
- [Suite 5 — Stop & Save Flow](#suite-5--stop--save-flow-fr-08-fr-09-fr-10-fr-18)
- [Suite 6 — Popup UI & Status Display](#suite-6--popup-ui--status-display-fr-11)
- [Suite 7 — Recording Limits](#suite-7--recording-limits-fr-12-fr-13-fr-14)
- [Suite 8 — Popup Close Guard](#suite-8--popup-close-guard-fr-15)
- [Suite 9 — Tab Closed Mid-Recording](#suite-9--tab-closed-mid-recording-fr-17)
- [Suite 10 — Edge Cases & Error Handling](#suite-10--edge-cases--error-handling)
- [Suite 11 — Constraints & Known Limitations](#suite-11--constraints--known-limitations)

---

## Suite 1 — Installation & Manifest

### TC-001 · Extension loads without errors
**Priority:** P1
**FR:** —
**Preconditions:** Extension directory is complete with all files.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open `chrome://extensions/` | Extensions page loads |
| 2 | Enable "Developer mode" | Toggle is ON |
| 3 | Click "Load unpacked"; select extension root | Extension card appears |
| 4 | Check for any error badges on the card | **No red error badge** |
| 5 | Click "Service Worker" link (inspect) | DevTools opens; console has **no errors** |

**Pass criteria:** Extension loads; no errors in manifest or service worker console.

---

### TC-002 · Required permissions are declared
**Priority:** P1
**FR:** —

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open extension `manifest.json` | File is valid JSON |
| 2 | Check `permissions` array | Contains: `tabCapture`, `tabs`, `scripting`, `storage`, `microphone`, `alarms`, `offscreen` |
| 3 | Check `host_permissions` | Contains `<all_urls>` |
| 4 | Check `action.default_popup` | Value is `"popup/popup.html"` |
| 5 | Check `background.service_worker` | Value is `"service-worker.js"` |

**Pass criteria:** All listed values are present; no typos.

---

### TC-003 · Popup opens when clicking extension icon
**Priority:** P1
**FR:** FR-01

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to any regular webpage (e.g., `https://example.com`) | Page loads |
| 2 | Click the extension icon in the Chrome toolbar | Popup window appears |
| 3 | Observe popup content | Shows tab title, IDLE state indicator, "Start Recording" button |
| 4 | Check popup console (right-click popup → Inspect) | **No JS errors** |

**Pass criteria:** Popup opens; shows IDLE state; no console errors.

---

## Suite 2 — Basic Recording (FR-01, FR-02, FR-03)

### TC-011 · Start recording a tab with video
**Priority:** P1
**FR:** FR-01, FR-02

**Preconditions:** YouTube (or equivalent) is open and playing a video. No mic permission on this tab.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Ensure target tab (YouTube) is the **active, foreground** tab | Tab is visible |
| 2 | Click extension icon to open popup | Popup shows tab title; IDLE state |
| 3 | Click "Start Recording" | Save As dialog appears |
| 4 | Accept the Save As dialog (pick any filename/location) | Dialog closes |
| 5 | Popup transitions to **RECORDING state** | Red dot visible, timer counting from 00:00:00 |
| 6 | Let recording run for **30 seconds** | Timer reaches ~00:00:30 |
| 7 | Click "Stop & Save" | Save flow completes; popup returns to IDLE |
| 8 | Open saved `.webm` file in Chrome or VLC | File plays; video content matches what was on screen |
| 9 | Confirm video is not a blank/black frame | **Actual tab content is visible** |

**Pass criteria:** File opens and plays; visual content matches recorded tab.

---

### TC-012 · Canvas animation is captured
**Priority:** P2
**FR:** FR-02

**Preconditions:** Open a tab with an HTML5 canvas animation (e.g., `https://particles.js.org/`).

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to a canvas animation page; make it foreground | Animation playing |
| 2 | Open popup; click "Start Recording"; accept Save As | RECORDING state |
| 3 | Let run for **10 seconds** | Timer at ~00:00:10 |
| 4 | Stop & Save | File saved |
| 5 | Open file | **Canvas animation is visible** in the recording, not a static frame |

**Pass criteria:** Recording shows animated canvas content.

---

### TC-013 · Tab audio is captured
**Priority:** P1
**FR:** FR-03

**Preconditions:** YouTube playing a video **with sound** (volume at 50%+). No mic on this tab.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording the YouTube tab | RECORDING state |
| 2 | Record **15 seconds** of video with clear audio | Timer running |
| 3 | Stop & Save | File saved |
| 4 | Open file and listen | **Audio from the tab is audible** in the recording |
| 5 | Run: `ffprobe -v error -show_streams <file>.webm \| grep codec_name` | Output includes an audio codec (`opus` or `vorbis`) |

**Pass criteria:** Audible tab audio present in recording; `ffprobe` confirms audio stream.

---

### TC-014 · System audio from other tabs is NOT captured
**Priority:** P1
**FR:** FR-03

**Preconditions:** Tab A (recorded): silent page. Tab B (not recorded): playing loud music.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open Tab A (e.g., `https://example.com`); make it foreground | Silent tab |
| 2 | Open Tab B (e.g., YouTube playing music) in background | Music playing from Tab B |
| 3 | Open popup on Tab A; start recording | RECORDING state |
| 4 | Record **10 seconds**; Tab B is still playing | Timer running |
| 5 | Stop & Save | File saved |
| 6 | Open file and listen at max volume | **No audio from Tab B** is audible |

**Pass criteria:** Saved file is silent (or nearly silent); Tab B audio is completely absent.

---

### TC-015 · CSS animations and DOM transitions captured
**Priority:** P2
**FR:** FR-02

**Preconditions:** Open a page with CSS transitions (e.g., any site with animated menus or carousels).

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to a page with visible CSS animations | Animations visible |
| 2 | Start recording | RECORDING state |
| 3 | Trigger CSS transitions (hover, click) for **10 seconds** | Timer running |
| 4 | Stop & Save | File saved |
| 5 | Open file | **Transitions are smooth and visible**, not skipped/frozen |

**Pass criteria:** CSS transitions appear in the recording.

---

## Suite 3 — Microphone Detection & Mixing (FR-04, FR-05, FR-06, FR-16)

### TC-031 · No mic prompt on tab without mic permission
**Priority:** P1
**FR:** FR-04, FR-05

**Preconditions:** Recorded tab is `https://example.com` — a page that has never requested mic access.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open `https://example.com`; make it foreground | Page loads |
| 2 | Open popup | IDLE state |
| 3 | Click "Start Recording"; accept Save As | Recording starts |
| 4 | Observe popup state | **No mic confirmation dialog** appears; popup shows RECORDING state directly |

**Pass criteria:** Mic prompt does not appear; recording starts without mic dialog.

---

### TC-032 · Mic prompt appears on tab with granted mic permission
**Priority:** P1
**FR:** FR-04, FR-05

**Preconditions:** Open `https://webcamtests.com/` and grant microphone permission (so browser shows permission as "granted"). Tab remains open.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Make the webcam-test tab foreground | Tab with granted mic permission is active |
| 2 | Open popup | IDLE state |
| 3 | Click "Start Recording"; accept Save As | **Mic confirmation dialog appears** in popup |
| 4 | Read dialog text | Text contains "This tab may be using the microphone. Include it?" |
| 5 | Observe buttons | **[Yes]** and **[No]** buttons are present |

**Pass criteria:** Mic dialog appears with correct text and both options.

---

### TC-033 · Choosing "Yes" includes mic audio in output
**Priority:** P1
**FR:** FR-06

**Preconditions:** Tab with granted mic permission (TC-032 setup). Physical microphone connected. Tab is playing NO audio (to isolate mic audio in recording).

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup on mic-granted tab; Start Recording; accept Save As | Mic dialog appears |
| 2 | Click **[Yes]** | Recording starts; RECORDING state shown |
| 3 | **Speak clearly** into the microphone for 10 seconds | Tab is silent; only mic audio being spoken |
| 4 | Stop & Save | File saved |
| 5 | Open file and listen | **Spoken words are clearly audible** in the recording |
| 6 | `ffprobe` confirms audio stream present | Audio codec confirmed |

**Pass criteria:** Mic audio is audibly present in the saved file.

---

### TC-034 · Choosing "No" excludes mic audio from output
**Priority:** P1
**FR:** FR-05, FR-06

**Preconditions:** Same as TC-033.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup on mic-granted tab; Start Recording; accept Save As | Mic dialog appears |
| 2 | Click **[No]** | Recording starts |
| 3 | Speak loudly into the microphone for 10 seconds | Tab is silent |
| 4 | Stop & Save | File saved |
| 5 | Open file at maximum volume and listen | **No mic audio** is audible; file is silent |

**Pass criteria:** File is silent; mic audio is completely absent.

---

### TC-035 · Mic permission state "prompt" does not trigger mic dialog
**Priority:** P2
**FR:** FR-04

**Preconditions:** Open a tab on a site where the browser's mic permission is in "Ask" (not yet granted) state. Use Chrome's site settings to reset mic permission to "Ask" for `https://webcamtests.com/`.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to site with "Ask" mic permission; make foreground | Page loads; permission is "Ask" |
| 2 | Open popup; Start Recording; accept Save As | **No mic dialog appears** |
| 3 | Popup transitions directly to RECORDING state | Recording active |

**Pass criteria:** No mic prompt shown for "Ask" (prompt) permission state.

---

### TC-036 · Mic permission state "denied" does not trigger mic dialog
**Priority:** P2
**FR:** FR-04

**Preconditions:** Block mic permission for `https://webcamtests.com/` via Chrome site settings (set to "Blocked").

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to site with blocked mic permission; make foreground | Page loads |
| 2 | Open popup; Start Recording; accept Save As | **No mic dialog appears** |
| 3 | Popup transitions directly to RECORDING state | Recording active |

**Pass criteria:** No mic prompt shown for "denied" permission state.

---

### TC-037 · Mic acquisition failure falls back gracefully with warning
**Priority:** P1
**FR:** FR-16

**Preconditions:** Tab has granted mic permission. Tester will deny the browser's mic access prompt when it appears during recording start.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup on mic-granted tab; Start Recording; accept Save As | Mic dialog appears |
| 2 | Click **[Yes]** | Browser shows its own mic permission prompt |
| 3 | Click **"Block"** in the browser mic prompt | Browser denies mic access |
| 4 | Observe popup | Popup shows **RECORDING state** (recording did not abort) |
| 5 | Observe for warning banner | **"Mic unavailable — recording tab audio only"** banner appears briefly |
| 6 | Record 10 seconds, Stop & Save | File saved |
| 7 | Verify no mic audio in file | File contains tab audio only (or silence if tab is silent) |

**Pass criteria:** Recording continues without mic; warning banner shown; no crash or abort.

---

## Suite 4 — Tab Switch Behavior (FR-07)

### TC-041 · Recording continues when user switches to another tab
**Priority:** P1
**FR:** FR-07

**Preconditions:** Recording is active on a YouTube tab.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording on YouTube tab (playing video with audio) | RECORDING state; timer running |
| 2 | Note the current timer value | e.g., 00:00:10 |
| 3 | Click on a **different tab** (e.g., `https://example.com`) | Different tab becomes active |
| 4 | Wait **15 seconds** | Do nothing on the new tab |
| 5 | Click back on the popup (it is still open) | Popup visible |
| 6 | Check timer | Timer has advanced to ~00:00:25 (**timer did not stop**) |
| 7 | Stop & Save | File saved |
| 8 | Open file; check duration | Duration is **~25 seconds** (full recording, not just the 10s on the original tab) |

**Pass criteria:** Timer runs uninterrupted; saved file duration covers the full elapsed time.

---

### TC-042 · Popup remains visually open during tab switch
**Priority:** P2
**FR:** FR-07

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording on Tab A; popup is open | RECORDING state |
| 2 | Switch to Tab B | Tab B is active |
| 3 | Look at the Chrome window | **Popup is still visible** (it is a separate window, not a tab-attached popover) |
| 4 | Verify popup still shows RECORDING state and live timer | Timer is counting |

**Pass criteria:** Popup remains open and live after tab switch.

---

## Suite 5 — Stop & Save Flow (FR-08, FR-09, FR-10, FR-18)

### TC-051 · Stop & Save button visible only in RECORDING state
**Priority:** P2
**FR:** FR-08

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup in IDLE state | Only "Start Recording" button visible |
| 2 | Start recording | Popup transitions to RECORDING |
| 3 | Check popup buttons | **"Stop & Save" is visible**; "Start Recording" is not |
| 4 | Stop & Save; return to IDLE | "Stop & Save" disappears; "Start Recording" reappears |

**Pass criteria:** Button visibility correctly reflects state.

---

### TC-052 · Save As dialog appears on stop
**Priority:** P1
**FR:** FR-09

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording (accept file handle at Start) | RECORDING state |
| 2 | Record 5 seconds | Timer at ~00:00:05 |
| 3 | Click "Stop & Save" | **Native Save As dialog does NOT re-appear** (handle was pre-opened); file is written directly to pre-chosen location |

> Note: In the pre-open pattern, `showSaveFilePicker` runs at **Start**, not at **Stop**. TC-052 verifies the dialog appears at the right time.

**Revised step 1:** When user clicks "Start Recording", Save As dialog appears immediately. Accept it. Then observe stop.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click "Start Recording" | **Save As dialog appears immediately** |
| 2 | Choose location and confirm | Dialog closes; recording begins |
| 3 | Click "Stop & Save" | File is saved silently to pre-chosen location; popup returns to IDLE |

**Pass criteria:** Save As dialog appears at Start; stop writes silently to the pre-chosen file.

---

### TC-053 · Default filename format is correct
**Priority:** P2
**FR:** FR-09

**Preconditions:** Target tab title is "YouTube — Cute Cat Videos".

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup on YouTube tab at e.g., 09:30:00 on 2026-02-22 | IDLE |
| 2 | Click "Start Recording" | Save As dialog appears |
| 3 | Observe the **pre-filled filename** in the dialog | Filename matches pattern: `YouTube — Cute Cat Videos_2026-02-22_09-30-00.webm` |

**Pass criteria:** Filename matches `<tab-title>_<YYYY-MM-DD_HH-MM-SS>.webm`.

---

### TC-054 · Filename sanitization replaces illegal characters
**Priority:** P2
**FR:** FR-09

**Preconditions:** Navigate to a page whose title contains illegal filename characters. Use a locally served HTML file with `<title>Test: File * Name? "Illegal" \Chars/</title>`.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup on the test page | Tab title shown with illegal chars |
| 2 | Click "Start Recording" | Save As dialog appears |
| 3 | Observe the pre-filled filename | All characters `\ / : * ? " < > |` are replaced with `_` |
| 4 | Example expected: `Test_ File _ Name_ _Illegal_ _Chars__2026-02-22_09-30-00.webm` | No illegal chars present |

**Pass criteria:** No illegal filesystem characters in the suggested filename.

---

### TC-055 · Output file is a valid WebM
**Priority:** P1
**FR:** FR-10

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Record 10 seconds; Stop & Save | File saved at known location |
| 2 | Run: `ffprobe -v error -show_format <file>.webm` | Output shows `format_name=matroska,webm` |
| 3 | Run: `ffprobe -v error -show_streams <file>.webm` | Shows at least one `video` stream and one `audio` stream |
| 4 | Check `duration` field | Duration is approximately **10 seconds** (±2 s) |

**Pass criteria:** `ffprobe` confirms valid WebM container with video and audio streams.

---

### TC-056 · Output codec is VP9 + Opus (or plain WebM fallback)
**Priority:** P2
**FR:** FR-10

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Record 10 seconds; Stop & Save | File saved |
| 2 | Run: `ffprobe -v error -show_streams <file>.webm \| grep codec_name` | Output contains `vp9` and `opus` **OR** `vp8` / `vorbis` (fallback) |
| 3 | If fallback: check popup console during recording | `CODEC_FALLBACK` message was sent (verify in SW/popup DevTools) |

**Pass criteria:** File uses VP9+Opus; or if fallback, `CODEC_FALLBACK` was signalled.

---

### TC-057 · Audio/video sync is correct
**Priority:** P1
**FR:** FR-10

**Preconditions:** Record a tab with a video containing a **clapper-board moment** or any easily time-syncable A/V event (a person speaking clearly on screen, or a YouTube countdown clock).

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Record 30 seconds of A/V-sync-testable content | Timer at ~00:00:30 |
| 2 | Stop & Save | File saved |
| 3 | Open file; observe a moment where audio and video events coincide | Audio and video are **in sync** (within ~100 ms) |
| 4 | Run: `ffprobe -v error -show_streams <file>.webm \| grep start_time` | Video and audio `start_time` values are both `0.000` or within 100 ms of each other |

**Pass criteria:** A/V is perceptibly in sync; no drifting observable over 30 seconds.

---

### TC-058 · Cancelling Save As at Start → recording does not begin
**Priority:** P1
**FR:** — (pre-open pattern behavior)

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup in IDLE state | "Start Recording" visible |
| 2 | Click "Start Recording" | Save As dialog appears |
| 3 | Click **Cancel** in the Save As dialog | Dialog closes |
| 4 | Observe popup state | Popup remains in **IDLE state** |
| 5 | Observe popup console | No `START_RECORDING` message was sent to service worker |

**Pass criteria:** Cancelling Save As at Start leaves popup in IDLE; no recording is initiated.

---

### TC-059 · Cancelling Save As at Stop → retry prompt appears
**Priority:** P1
**FR:** FR-18

> Note: In the pre-open pattern the second Save As opportunity occurs when the popup detects that the pre-opened `fileHandle` write fails (or when testing an override that forces the picker to re-appear). Adapt this test to your implementation's retry entry point.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Record 10 seconds; Stop & Save | Blob assembled; save attempted |
| 2 | Simulate save failure / cancellation (implementation-specific) | Save fails |
| 3 | Observe popup | **Retry prompt appears**: "The recording was not saved. Try again?" |
| 4 | Click **Retry** | Save As dialog re-appears |
| 5 | Accept | File saved; popup returns to IDLE |

**Pass criteria:** Retry prompt shown on first failure; retry successfully saves the file.

---

### TC-060 · Declining retry → warning shown → IDLE state
**Priority:** P2
**FR:** FR-18

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Trigger save failure (from TC-059 step 1-2) | Retry prompt appears |
| 2 | Click **Decline** / close the retry prompt | Warning shown: "Recording was not saved" |
| 3 | Observe popup state | Popup returns to **IDLE** |
| 4 | Open DevTools → Application → IndexedDB | **No leftover Blob entry** in `tab-recorder-blobs` store |

**Pass criteria:** Warning displayed; popup reaches IDLE; IndexedDB cleaned up.

---

### TC-061 · IndexedDB entry cleaned up after successful save
**Priority:** P2
**FR:** —

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Record and save successfully | File saved; popup IDLE |
| 2 | Open DevTools → Application → IndexedDB → `tab-recorder-blobs` | **Store is empty** (or the key used during this session is gone) |

**Pass criteria:** No orphaned Blob data left in IndexedDB after save.

---

## Suite 6 — Popup UI & Status Display (FR-11)

### TC-071 · IDLE state UI elements correct
**Priority:** P2
**FR:** FR-11

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup on any regular tab | Popup opens |
| 2 | Verify UI elements | Tab title shown (truncated if > 30 chars) |
| | | Idle indicator visible (○ or similar) |
| | | "Start Recording" button is **enabled** |
| | | No timer visible |
| | | No size display visible |
| | | No "Stop & Save" button |

**Pass criteria:** All IDLE elements present; no recording-state elements visible.

---

### TC-072 · Timer counts up from 00:00:00 in RECORDING state
**Priority:** P1
**FR:** FR-11

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording | RECORDING state |
| 2 | Immediately observe timer | Timer shows **00:00:00** or **00:00:01** |
| 3 | Wait 5 seconds | Timer shows **00:00:05** (±1 s) |
| 4 | Wait until timer reaches 01:00 (1 minute) | Timer shows **00:01:00** format correctly |

**Pass criteria:** Timer starts from 0, increments each second, uses HH:MM:SS format.

---

### TC-073 · Timer accuracy within ±2 seconds over 60 seconds
**Priority:** P2
**FR:** FR-11

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording; simultaneously start a stopwatch | Both running |
| 2 | After exactly 60 seconds (by stopwatch), read popup timer | Popup timer shows **00:00:58 to 00:01:02** (within ±2 s) |

**Pass criteria:** Timer drift < 2 seconds over 60 seconds.

---

### TC-074 · Size display updates each second
**Priority:** P2
**FR:** FR-11

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording a tab with video | RECORDING state; Size shows 0 KB or similar |
| 2 | Wait 5 seconds | Size display has **increased** from initial value |
| 3 | Observe size display over 10 seconds | Size updates **approximately every second** |

**Pass criteria:** Size increases over time; updates are visible at ~1 second intervals.

---

### TC-075 · Size formatting is correct
**Priority:** P3
**FR:** FR-11

| Size (bytes) | Expected display |
|---|---|
| 500 | `500 B` or `0.5 KB` |
| 512,000 | `512.0 KB` or `0.5 MB` |
| 1,234,567 | `1.2 MB` |
| 1,234,567,890 | `1.1 GB` |

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Record briefly | Small size shown correctly |
| 2 | Record longer (or use debug size limit to observe large values) | Larger sizes format correctly |
| 3 | Cross-check: `ffprobe -v error -show_format <file>.webm \| grep size` vs popup display | Within ~5% of each other |

**Pass criteria:** All size ranges display with correct unit and 1 decimal place.

---

### TC-076 · Tab title truncated at 30 characters with ellipsis
**Priority:** P3
**FR:** FR-11

**Preconditions:** Use a tab with a title longer than 30 characters: `"This Is A Very Long Tab Title That Exceeds Thirty Characters"`.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup on the long-title tab | Popup opens |
| 2 | Observe tab title in popup | Title is truncated with ellipsis: `"This Is A Very Long Tab Title T…"` |
| 3 | Verify popup width does not expand | Popup stays at fixed 320 px width |

**Pass criteria:** Title truncates; popup width unchanged.

---

### TC-077 · Popup shows RECORDING state correctly after reopen
**Priority:** P2
**FR:** FR-11

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording | RECORDING state |
| 2 | Let timer reach ~00:00:30 | Timer at ~30 s |
| 3 | Dismiss the popup (click away — note: this triggers beforeunload warning; accept to close) | Popup closed |
| 4 | Reopen popup (click extension icon) | Popup shows **RECORDING state** with elapsed time ~00:00:31+ (not reset to 0) |

**Pass criteria:** Reopened popup reflects correct current state; timer continues from where it was.

---

### TC-078 · LIMIT_PAUSED state UI is correct
**Priority:** P2
**FR:** FR-12

**Preconditions:** `DEBUG_TIME_LIMIT_SECONDS = 10` is set in offscreen.js.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording | RECORDING state |
| 2 | Wait ~10 seconds for debug limit | Popup transitions to **LIMIT_PAUSED state** |
| 3 | Verify UI | Warning indicator (⚠) visible |
| | | Text: "Recording limit reached." or similar |
| | | **[Continue]** button visible and enabled |
| | | **[Stop & Save]** button visible and enabled |
| | | Timer is **frozen** (not incrementing) |

**Pass criteria:** LIMIT_PAUSED state shown with correct elements; timer stopped.

---

## Suite 7 — Recording Limits (FR-12, FR-13, FR-14)

### TC-091 · Time limit triggers LIMIT_REACHED
**Priority:** P1
**FR:** FR-12

**Preconditions:** `DEBUG_TIME_LIMIT_SECONDS = 10`.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording | RECORDING state |
| 2 | Wait 10–12 seconds | Popup transitions to LIMIT_PAUSED |
| 3 | Check service worker console | `LIMIT_REACHED { reason: 'time' }` message logged |

**Pass criteria:** LIMIT_REACHED fires within 2 seconds of the threshold; reason is `'time'`.

---

### TC-092 · Size limit triggers LIMIT_REACHED
**Priority:** P1
**FR:** FR-12

**Preconditions:** `DEBUG_SIZE_LIMIT_BYTES = 1024` (1 KB). Record a tab with high-bitrate video to quickly exceed this.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording high-bitrate video tab | RECORDING state |
| 2 | Wait until size limit is exceeded (should be < 5 seconds with 1 KB limit) | Popup transitions to LIMIT_PAUSED |
| 3 | Check service worker console | `LIMIT_REACHED { reason: 'size' }` message logged |

**Pass criteria:** LIMIT_REACHED fires when size threshold crossed; reason is `'size'`.

---

### TC-093 · [Continue] resumes recording and resets counters
**Priority:** P1
**FR:** FR-13

**Preconditions:** Limit has been triggered (LIMIT_PAUSED state); `DEBUG_TIME_LIMIT_SECONDS = 10`.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | In LIMIT_PAUSED state, click **[Continue]** | Popup returns to **RECORDING state** |
| 2 | Observe timer | Timer resets to **00:00:00** (limit counter reset) |
| 3 | Observe size display | Size resets to **0** (or near-0) |
| 4 | Wait 10 more seconds | Second LIMIT_REACHED fires |

**Pass criteria:** Recording resumes; timer and size reset to 0; second limit fires correctly.

---

### TC-094 · Chunks are retained across Continue (full session in one file)
**Priority:** P1
**FR:** FR-13

**Preconditions:** `DEBUG_TIME_LIMIT_SECONDS = 10`. Two limit cycles will be triggered.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording | RECORDING state |
| 2 | Wait ~10 s → LIMIT_PAUSED | First limit |
| 3 | Click Continue | RECORDING resumes |
| 4 | Wait ~10 s → LIMIT_PAUSED | Second limit |
| 5 | Click [Stop & Save] | File saved |
| 6 | Check file duration via `ffprobe` | Duration is **~20 seconds** (both segments combined) |
| 7 | Open file | Video plays continuously for ~20 s without a hard cut |

**Pass criteria:** File contains content from all recording windows; total duration ~20 s.

---

### TC-095 · [Stop & Save] at limit triggers save flow
**Priority:** P1
**FR:** FR-14

**Preconditions:** LIMIT_PAUSED state reached.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | In LIMIT_PAUSED state, click **[Stop & Save]** | Popup shows SAVING state |
| 2 | Wait for save to complete | Popup returns to IDLE |
| 3 | Verify file at previously chosen location | File exists and is a valid WebM |

**Pass criteria:** Stop at limit produces a valid, playable file.

---

### TC-096 · Output file across pause/resume boundary is valid
**Priority:** P1
**FR:** FR-13

**Preconditions:** Record through one Continue cycle (from TC-093 or TC-094).

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Obtain the saved file from a Continue + Stop session | File at known path |
| 2 | Run: `ffprobe -v error <file>.webm` | **No errors** reported |
| 3 | Run: `ffprobe -v error -show_streams <file>.webm` | Valid video and audio streams with no codec errors |
| 4 | Open file in Chrome and scrub through the boundary point | Playback is **continuous** (may have a small gap but no crash or corruption) |

**Pass criteria:** `ffprobe` reports no errors; file is playable end-to-end.

---

## Suite 8 — Popup Close Guard (FR-15)

### TC-111 · Closing popup during RECORDING shows browser warning
**Priority:** P1
**FR:** FR-15

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording | RECORDING state |
| 2 | Attempt to close the popup window (click X) | **Browser shows `beforeunload` confirmation dialog** |
| 3 | Read dialog text | Contains message about recording in progress |
| 4 | Click **Cancel** (keep popup open) | Popup stays open; RECORDING state continues |

**Pass criteria:** Browser `beforeunload` dialog fires; cancelling keeps popup open.

---

### TC-112 · Closing popup during LIMIT_PAUSED shows browser warning
**Priority:** P2
**FR:** FR-15

**Preconditions:** Debug limit triggered; popup in LIMIT_PAUSED state.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | With popup in LIMIT_PAUSED state, attempt to close popup | **Browser `beforeunload` dialog appears** |

**Pass criteria:** Warning fires in LIMIT_PAUSED state, not just RECORDING.

---

### TC-113 · Force-closing popup → extension returns to IDLE on reopen
**Priority:** P2
**FR:** FR-15

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording | RECORDING state |
| 2 | Attempt to close popup; browser shows warning | Warning dialog |
| 3 | Click **OK / Leave** (confirm close) | Popup closes |
| 4 | Reopen popup (click extension icon) | Popup shows **IDLE state** |
| 5 | Check service worker console | No lingering RECORDING state; MediaRecorder stopped |
| 6 | Check chrome://offscreen-internals or DevTools | No active offscreen document (or it is idle) |

**Pass criteria:** After force-close, extension returns to clean IDLE; no zombie recording state.

---

## Suite 9 — Tab Closed Mid-Recording (FR-17)

### TC-121 · Closing recorded tab shows error in popup
**Priority:** P1
**FR:** FR-17

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording on Tab A | RECORDING state |
| 2 | Record 10 seconds | Timer at ~00:00:10 |
| 3 | Close **Tab A** (the recorded tab) | Tab closes |
| 4 | Observe popup within 2 seconds | Popup transitions to **error state** |
| 5 | Read error text | "The recorded tab was closed. Recording stopped." or similar |
| 6 | Observe available actions | **[Save partial]** and **[Discard]** buttons present |

**Pass criteria:** Error shown within 2 seconds of tab close; both action buttons present.

---

### TC-122 · "Save partial" saves a valid (partial) file
**Priority:** P1
**FR:** FR-17

**Preconditions:** Tab has been closed mid-recording (TC-121 state); ~10 seconds of chunks accumulated.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Click **[Save partial]** | Save As dialog appears (or uses pre-opened handle) |
| 2 | Accept the save | File saved |
| 3 | `ffprobe -v error <file>.webm` | **No errors** (file is valid WebM) |
| 4 | Open file | File plays; duration is approximately the time recorded before tab close |

**Pass criteria:** Partial file is a valid, playable WebM.

---

### TC-123 · "Discard" returns to IDLE without saving
**Priority:** P2
**FR:** FR-17

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Tab has been closed; error state shown | [Save partial] and [Discard] visible |
| 2 | Click **[Discard]** | Popup returns to **IDLE** |
| 3 | Confirm no file was saved at the pre-chosen location | No new file exists |
| 4 | Check IndexedDB | No orphaned Blob entry |

**Pass criteria:** No file saved; IDLE state; IndexedDB clean.

---

## Suite 10 — Edge Cases & Error Handling

### TC-131 · Recording a tab with no audio produces a valid file
**Priority:** P2
**FR:** FR-03

**Preconditions:** Tab has no audio playing and no mic (e.g., `https://example.com`).

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording; record 10 seconds | RECORDING state; timer running |
| 2 | Stop & Save | File saved |
| 3 | `ffprobe -show_streams <file>.webm` | File has a video stream; audio stream may be present but silent |
| 4 | Open file | Plays without errors; silent |

**Pass criteria:** Recording does not abort or error on a silent tab.

---

### TC-132 · Very long tab title is truncated in filename
**Priority:** P3
**FR:** FR-09

**Preconditions:** Tab title is 100+ characters long.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup on 100+ char title tab | Tab title truncated in popup display |
| 2 | Click "Start Recording" | Save As dialog appears |
| 3 | Inspect suggested filename | Filename is truncated to **≤ 60 characters** for the title portion (+ timestamp + `.webm`) |

**Pass criteria:** Filename does not exceed a reasonable length; no OS error from filename too long.

---

### TC-133 · Tab title composed entirely of illegal characters
**Priority:** P3
**FR:** FR-09

**Preconditions:** Serve an HTML page with `<title>\\:*?"<>|</title>`.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup on this tab | Tab title may show as blank or garbled in popup |
| 2 | Click "Start Recording" | Save As dialog appears |
| 3 | Observe suggested filename | Filename is `_________<timestamp>.webm` (all underscores) or just `<timestamp>.webm` |
| 4 | Accept Save As | File saved without OS error |

**Pass criteria:** No OS-level error from illegal characters in filename; file saves successfully.

---

### TC-134 · Record and immediately stop (< 1 second)
**Priority:** P2
**FR:** FR-08

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording | RECORDING state |
| 2 | Immediately click "Stop & Save" (within 1 second) | Save flow triggered |
| 3 | `ffprobe <file>.webm` | File is valid WebM (may be very small; 0-second duration is acceptable) |

**Pass criteria:** No crash or error; a valid (possibly empty-content) WebM file is produced.

---

### TC-135 · Content script double-injection guard works
**Priority:** P3
**FR:** —

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open popup on a tab | IDLE state |
| 2 | In service worker DevTools, manually trigger content script injection twice on the same tab | Two injections happen |
| 3 | Check service worker message log | Only **one** `MIC_PERMISSION_STATE` message received (not two) |

**Pass criteria:** Double-injection guard (`window.__tabRecorderInjected`) prevents duplicate messages.

---

### TC-136 · Extension gracefully handles `chrome://` pages
**Priority:** P2
**FR:** —

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Navigate to `chrome://settings/` | Chrome settings page |
| 2 | Open popup | Popup opens |
| 3 | Click "Start Recording" | **Error is shown** (cannot record internal Chrome pages) OR Save As dialog opens but recording fails gracefully |
| 4 | No crash or unhandled promise rejection | Console is clean (or shows a handled error) |

**Pass criteria:** Extension does not crash; user sees a clear error if recording is not possible.

---

### TC-137 · Codec fallback produces a valid file with notification
**Priority:** P3
**FR:** FR-10

> This test requires a browser or test environment where VP9+Opus `MediaRecorder` MIME type is not supported. Can be simulated by temporarily overriding `MediaRecorder.isTypeSupported` to return `false` for VP9+Opus.

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Override `MediaRecorder.isTypeSupported` for VP9+Opus to return `false` | Fallback will be triggered |
| 2 | Start recording | RECORDING state |
| 3 | Check popup DevTools for `CODEC_FALLBACK` signal | Message logged or UI indicator shown |
| 4 | Record 10 seconds; Stop & Save | File saved |
| 5 | `ffprobe -show_streams <file>.webm \| grep codec_name` | Shows fallback codec (e.g., `vp8` / `vorbis`) |
| 6 | Open file | File plays normally |

**Pass criteria:** Fallback triggers notification; file is still valid and playable.

---

### TC-138 · Rapid Start→Stop→Start does not leave orphaned state
**Priority:** P3
**FR:** —

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording; immediately Stop & Save | IDLE |
| 2 | Immediately Start recording again | RECORDING state (new session) |
| 3 | Record 5 seconds; Stop & Save | File saved |
| 4 | `ffprobe` both files | Both are valid; no cross-contamination of chunks |

**Pass criteria:** Two valid, independent files produced; no shared state between sessions.

---

## Suite 11 — Constraints & Known Limitations

These tests verify that the documented constraints (L-01 through L-09) behave as specified, not as bugs.

### TC-141 · Tab must be foreground when Start is clicked (L-01)
**Priority:** P2
**Constraint:** L-01

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open Tab A in background (it is not the active tab) | Tab A not foreground |
| 2 | On a different active tab, open popup via extension icon | Popup opens for **current active tab**, not Tab A |
| 3 | Verify popup title shows the current active tab's title | Correct tab referenced |

**Pass criteria:** Recording is always started on the currently active foreground tab; there is no way to record a background tab from scratch.

---

### TC-142 · Extension requires Chrome 109+ (L-04)
**Priority:** P2
**Constraint:** L-04

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Check `chrome://version/` | Chrome version ≥ 109 |
| 2 | If version < 109: load extension | Extension may fail to load or offscreen document creation fails |

**Pass criteria:** Document in README that Chrome 109+ is required; extension loads successfully on 109+.

---

### TC-143 · Chunked-memory accumulation: IndexedDB write completes for large recordings
**Priority:** P2
**Constraint:** L-06

**Preconditions:** Record a tab with high-bitrate content for several minutes (e.g., 5 minutes at 1080p).

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Start recording high-bitrate video | RECORDING state |
| 2 | Record for **5 minutes** | Timer at ~00:05:00; size display shows hundreds of MB |
| 3 | Stop & Save | SAVING state briefly; then IDLE |
| 4 | `ffprobe <file>.webm` | Valid file; duration ~5 min |
| 5 | Check service worker / offscreen console for memory errors | **No out-of-memory errors** |

**Pass criteria:** 5-minute recording saves without memory errors; valid output file.

---

## 5. Traceability Matrix

| Requirement | Test Cases |
|------------|-----------|
| FR-01 | TC-003, TC-011 |
| FR-02 | TC-011, TC-012, TC-015 |
| FR-03 | TC-013, TC-014, TC-131 |
| FR-04 | TC-031, TC-032, TC-035, TC-036 |
| FR-05 | TC-032, TC-033, TC-034, TC-035, TC-036 |
| FR-06 | TC-033, TC-034 |
| FR-07 | TC-041, TC-042 |
| FR-08 | TC-051, TC-134 |
| FR-09 | TC-052, TC-053, TC-054, TC-132, TC-133 |
| FR-10 | TC-055, TC-056, TC-057, TC-137 |
| FR-11 | TC-071, TC-072, TC-073, TC-074, TC-075, TC-076, TC-077, TC-078 |
| FR-12 | TC-078, TC-091, TC-092 |
| FR-13 | TC-093, TC-094, TC-096 |
| FR-14 | TC-095 |
| FR-15 | TC-111, TC-112, TC-113 |
| FR-16 | TC-037 |
| FR-17 | TC-121, TC-122, TC-123 |
| FR-18 | TC-059, TC-060, TC-061 |
| L-01 | TC-141 |
| L-04 | TC-142 |
| L-06 | TC-143 |

---

## 6. Test Execution Checklist

```
□ Environment: Chrome 116+ with extension loaded in developer mode
□ ffprobe installed and accessible from terminal
□ DEBUG_TIME_LIMIT_SECONDS and DEBUG_SIZE_LIMIT_BYTES constants available in offscreen.js
□ Mic-permission-granted tab prepared (e.g., webcamtests.com)
□ Physical microphone connected for TC-033, TC-034, TC-037
□ High-bitrate video source available (YouTube 1080p or local file server)
□ Local HTML test page with illegal characters in <title> prepared
□ All P1 tests executed before any P2/P3 tests
□ Results recorded in test log with: date, tester, Chrome version, result (Pass/Fail/Skip), notes
```

---

## 7. Pass/Fail Criteria for Release

| Gate | Criteria |
|------|---------|
| **P1 — All must pass** | TC-001, TC-002, TC-003, TC-011, TC-013, TC-014, TC-031, TC-032, TC-033, TC-034, TC-037, TC-041, TC-051, TC-052, TC-055, TC-057, TC-058, TC-059, TC-072, TC-091, TC-092, TC-093, TC-094, TC-095, TC-096, TC-111, TC-121, TC-122, TC-134 |
| **P2 — ≥ 90% must pass** | All P2 tests |
| **P3/P4 — Document failures** | Known issues logged; not a release blocker |
