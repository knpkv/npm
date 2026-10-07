---
"@knpkv/herdr-work": minor
---

`WorkService.planReconcile({ confirmed })` answers what `reconcile` would do now, writing nothing. It shares `reconcile`'s planning: capacity, confirmation, failure and already-stamped checks, and each checkpoint's validation, each step against the ones before it, in one transaction that is rolled back. A plan is advisory; `reconcile` decides again from the store as it then is. Steps are `would_apply` (with the fact behind it and the goal's latest event id and `updatedAt` it was planned from), `recorded` or `conflict`. A shadow run in observe mode measures the real decisions this way.
