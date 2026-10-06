---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit": patch
---

A failed `EvaluatePullRequestApprovalRules` call no longer shows the pull request as "pending approval" with every rule unsatisfied. It now fails with a typed `ApprovalEvaluationError`, surfaced the same way as a failed `GetPullRequest`: the account's refresh reports an error and keeps the cached rows, and the pull-request detail shows its API error. The codecommit README now lists `codecommit:EvaluatePullRequestApprovalRules` and `codecommit:GetPullRequestApprovalStates` among the required IAM actions; a user without the first one sees a refresh error instead of a queue where everything is pending.
