---
"@knpkv/herdr-work": minor
---

`WorkService.reconcile` takes an optional `{ confirmed }`: the `subject` and `observationId` of each fact the caller has just read and the store accepted. `observe` now reports the `observationId` on its `stored` and `unchanged` outcomes. With `confirmed`, a goal is closed only from a pull request fact on that list. A read refused as stale, or one that failed, confirms nothing, so an earlier fact (the pull request may since have reopened) is never acted on, including for superseded goals, which the snapshot hides. A confirmation that is no longer the subject's stored fact fails with `WorkStoreError` (`reconcile.confirmed`), and a malformed one with `reconcile.options`. With or without the option, a fact is skipped after a failed read newer than its last confirmation, re-checked inside the write's transaction.
