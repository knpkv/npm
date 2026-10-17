---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
"@knpkv/review": minor
"@knpkv/rly": minor
"@knpkv/herdr-hub": minor
---

Review pages name commits by title and time instead of their ids. A commit reads as “Restore the draft on reconnect, 14:18” (with the date when it was not made the day of the reading); the full id is in the tooltip and behind a Copy commit id button.

- `@knpkv/codecommit-core`: `CodeCommitReadClient.getCommit` reads a commit's title and commit time (`CodeCommitCommitSummary`), gated as the new `getCommit` read operation. It needs `codecommit:GetCommit`. Implementations of `CodeCommitReadClientService` must add the method.
- `@knpkv/codecommit-web`: the owner API serves `GET /prs/:awsAccountId/:prId/commits/:commitId`, the host contract adds `CodeCommitSummary`, `CodeCommitQuery` and `CodeCommitSummaryResult`, and `CodeHostReads.commit` reads one commit per caller. The Relay findings label no longer prints a short head id; the exact head stays in the context body.
- `@knpkv/review`: `CommitLabel`, `CommitSummaryProvider`, `useCommitSummaries` and `useCommitWords` from `@knpkv/review/react`, with styles at `@knpkv/review/commit-label.css`. The canvas uses them for its head and still-open lines, without the copy button inside the shrunk drawing.
- `@knpkv/rly`: a `copy` icon.
- `@knpkv/herdr-hub`: Code pages read commit titles through `/v1/modules/code/commit`.
