---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
"@knpkv/codecommit": minor
---

A pull request whose approval rules fail to evaluate is now listed with its approval unknown, instead of being dropped (never cached before) or shown with a stale cached approval.

- `Domain` adds `ApprovalUnknownReason` (`NotPermitted`, `Throttled`, `ProviderFailed`), `PullRequest.approvalUnknown`, `approvalOf(pr)` (Approved, Pending or Unknown; Unknown wins), and the shared copy `approvalUnknownLabel` and `approvalUnknownReasonText`.
- The cache persists the reason and keeps the last known approval and rules until an evaluation succeeds. Health stats no longer count an unknown approval as approved.
- `AwsClient.getPullRequestRefresh` and `PullRequestRefreshItem` are removed: `getPullRequests` lists every pull request, with `approvalUnknown` set where evaluation failed. A single-PR refresh now also writes the evaluated approval.
- The CLI list, TUI badges, status filters and health score show "Approval unknown"; an unknown approval is neither approved nor pending.
- codecommit-web's event stream and cached-row API carry the field. The web queue, filters, counts, workbench and detail page show "Approval unknown", and the reason on the detail page; an unknown approval is never shown as approved, pending or ready.
