# 2026-04-25 autosave fallback preserve handle

- Do not clear a persisted save handle just because an offscreen direct-save attempt failed.
- Let popup fallback reuse the same handle after auto-save failure.
- Prefer attempting `createWritable()` directly over rejecting on a possibly misleading permission pre-check.
