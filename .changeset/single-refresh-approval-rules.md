---
"@knpkv/codecommit-core": patch
---

Refreshing a single pull request that has an approval rule no longer fails. The cache's upsert input required `ApprovalRule` class instances, but the single-PR refresh passes the provider's rules as plain objects, so every refresh of such a PR failed with a schema error, which codecommit-web returned as HTTP 500. `UpsertInput.approvalRules` now accepts the rule's plain shape.
