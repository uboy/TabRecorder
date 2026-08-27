# 2026-04-25 offscreen autosave

- Auto-stop save flows should not depend on popup lifetime.
- If a destination was preselected at start, let the persistent offscreen pipeline try the file write first.
- Keep the old `BLOB_READY` fallback path for cases where direct auto-save is unavailable or permission was lost.
