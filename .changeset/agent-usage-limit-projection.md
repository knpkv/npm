---
"@knpkv/agent-usage": minor
---

Limits now says how long each window lasts at the current pace: "at this pace: out at 14:20" when the last hour's burn reaches the limit before the reset, which also raises the row to Near limit; "lasts until reset" when it does not; "pace unknown" when the reading is old or the cycle has too few readings, never a time or 0. `projectWindow` and `describeProjection` are exported from `@knpkv/agent-usage/limits`.
