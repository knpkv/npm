---
"@knpkv/herdr-work": patch
---

`WorkStore.open` now upgrades legacy tables and creates or completes Work's schema in one transaction. If any step fails, the file is left exactly as it was, and opening a file no longer syncs it to disk once per schema statement.
