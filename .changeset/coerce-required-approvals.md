---
"@knpkv/codecommit-core": patch
---

fix(codecommit-core): coerce `NumberOfApprovalsNeeded` from string to number

AWS CodeCommit returns `NumberOfApprovalsNeeded` inconsistently as either a number or a string. `parseRuleContent` now coerces with `Number()` and falls back to `1` when the value is non-numeric, so `requiredApprovals` is always a number.
