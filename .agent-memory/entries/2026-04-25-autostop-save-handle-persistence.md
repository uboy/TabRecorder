# 2026-04-25 auto-stop save handle persistence

- Do not keep a preselected `FileSystemFileHandle` only in popup memory if the save can happen after popup close.
- Persist auto-stop save handles in IndexedDB and restore them before processing a deferred `BLOB_READY`.
- Keep all extension contexts on the same IndexedDB schema version when popup and offscreen share the same database.
