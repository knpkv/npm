---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit": patch
---

A failed `EvaluatePullRequestApprovalRules` call no longer shows a pull request as "pending approval" with every rule unsatisfied.

- `AwsClient.getPullRequestRefresh` streams each pull request as `Fetched` or `EvaluationFailed` with a typed `ApprovalEvaluationError`. The refresh keeps a failed pull request's cached row, carries on with the account's other pull requests, and records the failure in `AppState.unevaluatedPullRequests`. The account's refresh then counts as partial rather than successful, and a notification says how many pull requests couldn't be re-evaluated.
- `getPullRequests` and the pull-request detail still fail with the typed error, because they can't report one pull request as unknown.
- The codecommit README now lists `codecommit:EvaluatePullRequestApprovalRules` and `codecommit:GetPullRequestApprovalStates` among the required IAM actions.
