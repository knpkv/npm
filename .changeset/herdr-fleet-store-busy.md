---
"@knpkv/herdr-fleet": minor
---

Job-store writes (`put`, `transition`) that lose the SQLite write lock to another connection now fail with the new `FleetStoreBusyError` instead of `FleetStoreError`. Nothing was written, so the same request can be retried. Every `FleetService` method that writes a job (approve, reject, run and the rest) can now fail with it.
