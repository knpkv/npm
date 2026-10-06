---
"@knpkv/herdr-work": minor
---

Add observed facts for the Work tab. `WorkService.observe` stores the latest fact per pull request or agent in a bounded overlay that is never goal history and never part of an approval token, and `snapshots` merges those facts into the `now` window as `observed` entries with first-seen and last-confirmed times, the goal's current read failure (`unknown`), a derived `displayState` and a 24-hour `stale` flag. `WorkStoreService` gains the required `observe` method.
