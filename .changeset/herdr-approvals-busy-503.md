---
"@knpkv/herdr-approvals": patch
---

An approval or other job write that finds the job store locked now answers 503 (`FleetStoreBusyError`, retryable) instead of 500. The approval proof survives, so retrying the same decision succeeds. Push-delivery and host-runner failures are still logged and skipped, now with a logging `Effect.catch` instead of a suppressed `Effect.ignore`.
