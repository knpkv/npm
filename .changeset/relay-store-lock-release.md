---
"@knpkv/relay": patch
---

Closing a Relay harness now frees its store at once, so the same process can open it again. Ownership moves from the libsql connection's exclusive mode to an exclusive lock on `<store>.lock`, held through `node:sqlite` with `exec` only. libsql keeps a closed connection, and the lock it took, until its prepared statements are garbage-collected, so a store that had been opened once could not be reopened in that process.
