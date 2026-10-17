# @knpkv/sandbox-pool

## 0.2.0

### Minor Changes

- [#1007](https://github.com/knpkv/npm/pull/1007) [`f981895`](https://github.com/knpkv/npm/commit/f98189507ed95617a57d51b812d8ddc76c6de6c8) Thanks [@konopkov](https://github.com/konopkov)! - A reset that verifies clean now quarantines the account when the budget action's deny-all SCP is still attached, with the blocker from `budgetHoldBlocker(contract)`. `PoolAccess` gains `budgetHold`, and `isBudgetHoldFor(contract, blocker)` (exact, for approvals) and `isBudgetHold(blocker)` (for display) tell a hold from a failed step. The reset never detaches the policy.

- [#1009](https://github.com/knpkv/npm/pull/1009) [`98af69f`](https://github.com/knpkv/npm/commit/98af69f536d7ff4d4b04d9906d523e8dcb1a2900) Thanks [@konopkov](https://github.com/konopkov)! - `resetAccount` records each run in a new `RunLog` service: a start, each step's start and end (with the blocker and the aws-nuke output tail), and the outcome. `summarizeRuns` folds the entries into one summary per run, and `makeMemoryRunLog` is an in-memory log. `SandboxStore` operations may now fail with `SandboxStoreUnavailable`, for durable stores; the memory store never does. `resetAccount` now requires `RunLog`.

## 0.1.0

### Minor Changes

- [#996](https://github.com/knpkv/npm/pull/996) [`1621b7e`](https://github.com/knpkv/npm/commit/1621b7ed1661ebe0538c33814bf1650fc5a45d9a) Thanks [@konopkov](https://github.com/konopkov)! - Add the sandbox pool's lease model, reset job and compare-and-set store contract.
