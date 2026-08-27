# 2026-04-25 local timestamps

- Do not use `toISOString()` for user-visible local timestamps in filenames or diagnostics.
- Build visible timestamps from local date parts unless UTC is explicitly required.
