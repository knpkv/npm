---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": minor
---

PR approvers: approval rules, review UI, desktop notifications

- ApprovalRule domain model with needsMyReview, diffApprovalPools, approval_requested/review_reminder notifications
- Approval rule CRUD via CodeCommitApprovers format with cross-account SSO support (repoAccountId from getRepository)
- Cache: 3 migrations (approval_rules, approved_by_arns, repo_account_id)
- SSE: pendingReviewCount, approvalRules + approvedByArns in wire schema
- UI: header review badge, Review filter, required/optional approvers cards with suggested users + optimistic spinners
- Desktop notifications with click-to-navigate, dedup, review reminders (configurable interval)
- Notification settings tab (desktop toggle, reminder interval)
- Audit: clear all logs, Statement.and parameterized queries, disabled by default
- Noise reduction: removed transient SSO/assume notifications, toast suppression for title/description changes
