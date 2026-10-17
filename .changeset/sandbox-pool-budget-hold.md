---
"@knpkv/sandbox-pool": minor
---

A reset that verifies clean now quarantines the account when the budget action's deny-all SCP is still attached, with the blocker from `budgetHoldBlocker(contract)`. `PoolAccess` gains `budgetHold`, and `isBudgetHoldFor(contract, blocker)` (exact, for approvals) and `isBudgetHold(blocker)` (for display) tell a hold from a failed step. The reset never detaches the policy.
