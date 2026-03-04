# Research: Manual Pause/Resume for Recording

Date: 2026-03-04
Task: Add user-controlled pause/resume while recording in popup.

## Current behavior
- `service-worker.js` owns canonical states: `IDLE`, `CONFIRMING_MIC`, `RECORDING`, `LIMIT_PAUSED`, `SAVING`.
- `offscreen/offscreen.js` controls `MediaRecorder`; pause exists only for limit handling (`triggerLimit`).
- `popup/popup.js` has no pause/resume actions and no `PAUSED` UI state.

## Gaps
- No manual command path popup -> SW -> offscreen for pause/resume.
- No explicit `PAUSED` state in SW state machine.
- Timer accounting is tied to `startTime` and needs explicit handling across manual pause/resume.

## Implementation direction
- Add SW state `PAUSED` and message types: `PAUSE_RECORDING`, `RESUME_RECORDING`.
- Add offscreen handlers: `PAUSE_MEDIA`, `RESUME_MEDIA`.
- Add elapsed-time helpers in offscreen to freeze/resume timer accurately.
- Add popup controls for pause/resume and a dedicated paused panel.
- Keep existing limit pause flow unchanged (`LIMIT_PAUSED` remains separate).
