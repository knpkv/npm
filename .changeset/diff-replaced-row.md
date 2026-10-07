---
"@knpkv/codecommit-core": minor
---

A subscribed pull request's notifications describe the transition from the row the refresh actually replaced. `PullRequestRepo.upsert` and `upsertRead` read the row in the same transaction as the write and return it as `replaced` (`UpsertResult`). Before, the bulk and single refresh diffed a snapshot read earlier, so a write landing in between could hide a revocation or announce a change that didn't happen.
