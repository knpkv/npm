---
"@knpkv/herdr-work": minor
"@knpkv/herdr-hub": minor
---

Add `WorkService.attachPullRequest` and `fleetctl work attach-pr` to attach a GitHub pull request to an existing goal. The latest event, stored repository and branch, active state, and existing review URL are checked in the same transaction that derives and appends the checkpoint. Concurrent goal changes produce `WorkPullRequestAttachConflict` instead of being overwritten. Reattaching the same URL is a no-op success that preserves later goal updates.
