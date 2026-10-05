---
"@knpkv/herdr-work": patch
---

`WorkStore.open` now creates or completes Work's schema in one transaction. If a step fails, no partial tables are left behind, and opening a file no longer syncs it to disk once per schema statement.
