---
"@knpkv/sandbox-pool": minor
---

A leased card now carries `startedAt`, and an available card carries `lastResetAt` (null when the account was never reset), so a view can show the 24-hour cap and the longest-idle account. `leaseDuration` and `leaseCap` are exported from `@knpkv/sandbox-pool/host`.
