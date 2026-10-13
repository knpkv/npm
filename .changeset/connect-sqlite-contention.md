---
"@knpkv/herdr-connect": minor
"@knpkv/herdr-hub": patch
---

Recover Connect writes from short-lived SQLite writer contention. Use 100 ms native lock waits, followed by asynchronous exponential retries with jitter and an approximately five-second budget, replaying the whole atomic statement or IMMEDIATE transaction. Export ConnectStoreBusyError for exhaustion. Keep archive enrichment isolated, preserve safe inventory diagnostics, and return an exhausted report's operation and budget as HTTP 503 without its private cause. Preserve WAL, FULL synchronous mode and owner-only database and sidecar files; leave Work, Code and Fleet job settings unchanged.
