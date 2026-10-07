---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": patch
---

Refreshing a pull request that has an approval rule works again, and the rule shows its approvers.

- The cache's upsert input required `ApprovalRule` class instances, but the single-PR refresh passes the provider's rules as plain objects, so every refresh of such a PR failed (HTTP 500 in codecommit-web). `UpsertInput.approvalRules` now accepts the rule's plain shape.
- Rule content whose `ApprovalPoolMembers` is a single string, such as `"*"`, is read as a one-member pool instead of failing to parse and showing no approvers. A rule that can't be parsed now logs the schema error with its path.
- codecommit-web logs the cause of a failed refresh, and the PR page shares one in-flight refresh per pull request, so overlapping triggers no longer cancel each other.
