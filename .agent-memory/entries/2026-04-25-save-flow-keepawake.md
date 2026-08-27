# 2026-04-25 save-flow keep-awake

- Do not release `chrome.power` as soon as recording stops if the file is still being written or waiting for a retry-save decision.
- Treat popup `showSaveFilePicker()` cancellation (`AbortError`) during retry as a deferred-save state, not as data loss.
- Keep the pending blob until the user either saves successfully or explicitly discards it.
