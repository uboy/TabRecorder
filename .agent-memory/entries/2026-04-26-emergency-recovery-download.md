# 2026-04-26 emergency recovery download

- Auto-stop save flows need an independent rescue path that does not rely on popup lifetime or `FileSystemFileHandle`.
- A dedicated extension recovery page with `chrome.downloads` fallback is safer than leaving a hidden blob only in IndexedDB.
