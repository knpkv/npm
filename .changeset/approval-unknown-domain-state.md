---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
"@knpkv/codecommit": minor
---

A pull request whose approval rules fail to evaluate is now listed with its approval unknown, instead of being dropped (never cached before) or shown with a stale cached approval.

- `Domain` adds `ApprovalUnknownReason` (`NotPermitted`, `Throttled`, `ProviderFailed`), `PullRequest.approvalUnknown`, `approvalOf(pr)` (Approved, Pending or Unknown; Unknown wins), and the shared copy `approvalUnknownLabel` and `approvalUnknownReasonText`.
- The cache persists the reason and keeps the last known approval and rules until an evaluation succeeds. Health stats no longer count an unknown approval as approved.
- `AwsClient.getPullRequestRefresh` and `PullRequestRefreshItem` are removed: `getPullRequests` lists every pull request, with `approvalUnknown` set where evaluation failed. A single-PR refresh now also writes the evaluated approval.
- The CLI list, TUI badges and health score show "Approval unknown"; an unknown approval is neither approved nor pending. The TUI status filter gains `unknown`.
- codecommit-web's event stream and cached-row API carry the field. The web queue, workbench and detail page show "Approval unknown", and the reason on the detail page; an unknown approval is never shown or counted as approved, pending or ready. The status filter gains `unknown`, and "All open" includes those pull requests.
- An expired or rejected session found while evaluating approval rules fails the read instead of reading as an unknown approval, so the refresh marks the account signed out. A `GetPullRequest` answer without a pull request fails as `MissingPullRequestResponse`.
- No approval notification is sent when evaluation recovers from unknown: a pull request first seen while evaluation fails has no real last known value.
- Every write to a cached pull-request row is now a compare-and-set on the row's version, through `PullRequestRepo/rowWrites`. The version is the provider's last activity plus an observation number, which `PullRequestRepo.observe()` takes from the database before each provider read. Compared in that order, it orders two reads of the same revision. A write observed at an older version is a no-op and reports `false`. That covers the listing upsert, approval evaluations, status changes, diff stats, comment counts, health scores and commenters. A subscribed pull request's notifications are sent only when its write applied. Only a provider "pull request does not exist" deletes a row, leaving a tombstone (migration 0023) so a slower read can't bring it back, while a newer listing still can. Other read failures keep the row. `upsert` takes the observation; `recordApprovalEvaluation`, `deleteOne`, `updateDiffStats`, `updateCommentCount` and `updateHealthScore` take a `RowVersion`; `updateStatusAndClosedAt` takes the observation. The ast-grep rule `no-direct-pull-request-row-write` keeps other code from writing the table directly.