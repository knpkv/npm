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
