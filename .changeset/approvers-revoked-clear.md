---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": patch
---

An approval revoked down to no approvers is now cleared. Approvers are who approved the pull request now, from the same read as the approval: a read with none clears them, and only a read that couldn't fetch them keeps the last known list. Before, a failed approver read and a real "no approvers" were the same empty list, and the cache kept the old approvers in both cases, so a revoked approval never cleared.

- `fetchApprovers` returns `Option`: none when the read fails (logged as a warning), never an empty list standing in for a failure.
- `PullRequest` and `PullRequestDetail` gain `approversUnknown` (set when the approver read failed; `approvedBy` is then only the last known list), and `UpsertInput` carries it.
- Approvers now move with the approval group's version, so a read whose approval is older than the cached one doesn't overwrite them.
- The cache keeps the marker (`approvers_unknown`, migration 0025; rows cached before it start unknown, since their lists may hold a revoked approval, until the next successful read), so a published pull request still says its approvers are only last known; the browser's wire schema decodes it.
- A bulk refresh, listed or stale re-read, with a pull request whose approvers couldn't be read counts that account as partial, not clean.
- `needsMyReview` and the workbench don't claim a definite review while approvers are unknown (the user may already have approved): the workbench lists such a pull request under the pool, and a last known approval never takes the user out of it.
- `Domain` adds `approversUnknownLabel` and `currentApprovers` (none while approvers are unknown). The browser shows "Approvers unknown" instead of an approval count, rule progress or approver check marks.
