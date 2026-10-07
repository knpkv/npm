---
"@knpkv/herdr-work": minor
---

`WorkService.reconcile` now takes `{ confirmed }`: the `subject` and `observationId` of each fact the caller has just read and the store accepted. `observe` reports the `observationId` (the stored fact's SHA-256 id) on its `stored` and `unchanged` outcomes. A goal is closed only from a pull request fact on that list. A read refused as stale, or one that failed, confirms nothing, so an earlier fact (the pull request may since have reopened) is never acted on, including for superseded goals, which the snapshot hides, and whatever failure records were evicted. A confirmation that is no longer the subject's stored fact fails with `WorkStoreError` (`reconcile.confirmed`), and a malformed one with `reconcile.options`. A failed read newer than a fact's confirmation is also checked, inside the write's transaction too. Callers of the former argument-less `reconcile()` pass the ids from their `observe` report.
