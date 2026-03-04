# Plan: Manual Pause/Resume

Date: 2026-03-04

1. Service worker
- Extend state union with `PAUSED`.
- Handle popup messages `PAUSE_RECORDING` and `RESUME_RECORDING`.
- Treat `PAUSED` as active for badge, tab-close interrupt, and pointer toggles.

2. Offscreen media pipeline
- Add elapsed accounting helpers so timer freezes on pause and continues on resume.
- Add `PAUSE_MEDIA` and `RESUME_MEDIA` handlers around `MediaRecorder.pause/resume`.
- Emit immediate `STATE_UPDATE` when pausing/resuming.

3. Popup UI and logic
- Add Pause button in recording section.
- Add `PAUSED` section with Resume and Stop & Save actions.
- Wire handlers and include `PAUSED` in close guard and relevant toggles.

4. Verification
- Run syntax checks: `node --check` for changed JS files.
- Review diff for state transitions and message flow.
- Produce review report artifact in `coordination/reviews/`.
