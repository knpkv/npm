---
"@knpkv/control-center": patch
---

Offline backups no longer publish a snapshot older than its WAL. A SQLite connection closing after the database was copied checkpoints the WAL into the database and deletes it, so the copy missed what the WAL held while every sidecar check passed. The capture now compares the database and its sidecars before the copy and after the sidecar copies, and starts the attempt again when anything changed.
