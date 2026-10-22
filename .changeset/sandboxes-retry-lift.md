---
"@knpkv/herdr-hub": minor
---

The Sandboxes account page lets the owner ask Fleet to retry a quarantine's reset ("Retry reset") or lift a budget stop ("Request to lift the stop", also on the pool's budget card). `POST /v1/modules/sandboxes/jobs` takes `Retry` and `BudgetLift` orders, submitted as `sandbox.reset` (Retry) and `sandbox.budget.lift`, which always wait for an approval in Fleet / Approvals. The route refuses a request that could not run with 404 `not_found` or 409 `not_quarantined`, `not_budget_held` or `already_requested`, and `SandboxesWriteFailed` names those reasons. `SandboxesModuleWrites` gains `retry` and `liftBudget`. A later failed poll now keeps the requests and runs on screen, marked last known, instead of replacing them with a failure.
