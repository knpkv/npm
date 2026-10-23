---
"@knpkv/sandbox-pool": minor
"@knpkv/herdr-hub": minor
---

Live AWS adapters for the sandbox pool: `makeStsPoolAccess`, `makeAwsNuke` and `makeOrganizationsBudgetLift` in `@knpkv/sandbox-pool/aws`, with `observeBaseline` and `planBaseline` for a read-only check. The `BudgetControl` port and `BudgetLiftFailed` move to `@knpkv/sandbox-pool`; `@knpkv/herdr-hub/hostd-runtime` still exports both.
