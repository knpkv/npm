---
"@knpkv/herdr-work": minor
---

`WorkService.planReconcile({ confirmed })` answers what `reconcile` would do now, writing nothing. It shares `reconcile`'s planning: capacity, confirmation, failure and already-stamped checks, and each checkpoint's validation, which runs in the same kind of transaction and is rolled back. Steps are `would_apply` (with the fact and goal head they were planned from), `recorded` or `conflict`. A shadow run in observe mode measures the real decisions this way.
