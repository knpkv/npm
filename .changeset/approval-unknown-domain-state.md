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
- Every write to a cached pull-request row goes through `PullRequestRepo/rowWrites`, under three rules that keep an older read from overwriting a newer one:
  1. **Provider reads write whole column groups.** `upsert` (a listing) and the new `writeRead` (a re-read) take a complete `RowGroup` and `ApprovalGroup`, each written unless that group's version is newer. A version is the provider's last activity plus an observation number, which `PullRequestRepo.observe()` takes from the database before each read; compared in that order, it orders two reads of the same revision.
  2. **Recomputed values never move a version.** The new `writeDerived` (diff stats, comment count, health score, commenters) applies only while the row still holds both versions it was read at. The comment cache and its notifications follow only when it applied.
  3. **A tombstone keeps the later of both versions.** Only a provider "pull request does not exist" deletes a row, ordered by its observation, and the tombstone (migration 0023) stops a read that began earlier from bringing it back. Other read failures keep the row.

  `upsert` reports which groups it wrote (`GroupsWritten`), and notifications, unknown-approval reporting and auto-subscription follow only those. `recordApprovalEvaluation`, `updateStatusAndClosedAt`, `updateDiffStats`, `updateCommentCount` and `updateHealthScore` are removed. `deleteOne` takes the not-found read's observation. `AwsClient`'s `PullRequestDetail` gains `isMergeable`, so a re-read carries a whole row. The ast-grep rules `no-direct-pull-request-row-write` and `no-pull-request-free-form-row-write` keep other code from writing the table directly or in part.
