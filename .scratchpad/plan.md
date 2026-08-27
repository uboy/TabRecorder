# Plan: Scheduled Stop + Keep Awake

Date: 2026-04-25

1. Shared schedule helper + automated verification
- Add a small helper for converting popup inputs into an absolute stop timestamp and stable display labels.
- Add a Node-based verification script for schedule math edge cases: future time today, next-day rollover, zero/invalid interval, and minute normalization.

2. Popup UI and validation
- Add idle controls for auto-stop mode: disabled, stop at local time, or stop after a duration.
- Validate input before `START_RECORDING` and send the normalized schedule payload to the service worker.
- Show the active auto-stop target in `RECORDING`, `PAUSED`, and `LIMIT_PAUSED`.

3. Service worker orchestration
- Extend canonical option/state payloads with the selected auto-stop configuration.
- Create/clear a dedicated scheduled-stop alarm and stop recording through the existing save path when it fires.
- Push popup state to `SAVING` on scheduled stop so the UI reflects the transition immediately.
- Request keep-awake while a recording session is active and release it when the session ends.

4. Manifest and docs
- Add the `power` permission required for sleep prevention.
- Update `README.md` and `TEST_PLAN.md` with the new feature behavior and manual coverage.

5. Verification and review
- Run the new Node verification script.
- Run `node --check` for changed JS files and validate `manifest.json`.
- Review the final diff and record the outcome in `coordination/reviews/`.

## Plan review result
- `Stop at time` remains tied to the system clock.
- `Stop after interval` pauses together with recording and resumes from the remaining interval after `Resume` / `Continue`.
