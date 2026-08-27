# Research: Scheduled Stop + Keep Awake

Date: 2026-04-25
Task: Add stop-at-time / stop-after-interval recording control and prevent system sleep while a recording session is active.

## Current behavior
- `service-worker.js` owns canonical recording state and already uses `chrome.alarms` only for a keepalive wake-up.
- `offscreen/offscreen.js` owns media timing and limit detection, but only for active recording segments; it has no wall-clock stop scheduler.
- `popup/popup.js` sends start options (`forceMic`, `showPointer`, `lockInteractions`) but has no scheduling controls.
- `manifest.json` declares `tabCapture`, `tabs`, `scripting`, `storage`, `alarms`, `offscreen`; there is no `power` permission yet.

## Design constraints
- User-facing "stop at 15:00" is wall-clock behavior based on system time, so the canonical deadline should be an absolute timestamp, not offscreen elapsed seconds.
- A user-configured stop must survive MV3 service-worker suspension; a dedicated `chrome.alarms` entry is the correct owner.
- The existing save pipeline already works for all stop paths through `STOP_MEDIA` -> `BLOB_READY`; scheduled stop should reuse that path.
- Sleep prevention should be tied to canonical service-worker state, not popup visibility or offscreen timers.

## Gaps
- No schedule model in popup start options, service-worker state, or `GET_STATE`.
- No alarm lifecycle for a user-defined stop deadline.
- No keep-awake lifecycle (`chrome.power.requestKeepAwake` / release).
- No automated verification artifact for schedule normalization and target-time calculation.

## Proposed direction
- Represent auto-stop as an absolute local timestamp plus metadata (`none` / `at_time` / `after_interval`) for UI display.
- Keep `Stop at time` bound to the system clock.
- Make `Stop after interval` count only active recording time; manual pause and limit pause freeze the remaining interval until recording resumes.
- Add a small shared helper for schedule math so popup validation and automated checks use the same rules.
- Keep offscreen focused on media capture; schedule triggering and keep-awake control stay in the service worker.
