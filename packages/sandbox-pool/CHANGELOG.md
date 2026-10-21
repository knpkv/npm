# @knpkv/sandbox-pool

## 0.4.0

### Minor Changes

- [#1036](https://github.com/knpkv/npm/pull/1036) [`f81d38a`](https://github.com/knpkv/npm/commit/f81d38a491b72e33878d454e0b33baa258bc2eb0) Thanks [@konopkov](https://github.com/konopkov)! - A leased card now carries `startedAt`, and an available card carries `lastResetAt` (null when the account was never reset), so a view can show the 24-hour cap and the longest-idle account. `leaseDuration` and `leaseCap` are exported from `@knpkv/sandbox-pool/host`.

## 0.3.1

### Patch Changes

- [#1041](https://github.com/knpkv/npm/pull/1041) [`6e6d029`](https://github.com/knpkv/npm/commit/6e6d029fd0979aca90815ab4a0a6d8bed5967887) Thanks [@konopkov](https://github.com/konopkov)! - READMEs open with "Run it on its own": the `npx` command, its port, and what it runs without. Packages with no executable say where they run instead. CodeCommit web no longer claims it needs Bun; only the terminal UI does.

## 0.3.0

### Minor Changes

- [#1026](https://github.com/knpkv/npm/pull/1026) [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2) Thanks [@konopkov](https://github.com/konopkov)! - Add the sandbox read model (`@knpkv/sandbox-pool/host` and `./host/server`) and the hub's Sandboxes module. A quarantine or run blocker is a closed tag (`ResourcesRemain`, `NukeFailed`, `BudgetHold`, `ScanIncomplete`, or `Unknown`) with fixed copy; the stored reset line is not served. `RELAY_SANDBOXES_HOST` plus an optional `sandboxPool` configuration select the hub that opens the pool database and serves overview and paged runs. Needs-you gains an `asOf` per provider, module-page destinations, and quarantined and budget-hold items. A host that does not own the pool contributes nothing. A reader that cannot start contributes a failed unavailable issue. This does not start pool jobs or the sweep, and it does not add the Sandboxes page.

- [#1026](https://github.com/knpkv/npm/pull/1026) [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2) Thanks [@konopkov](https://github.com/konopkov)! - Rename a stored sandbox when its contract keeps the account id and changes the name. The version and state stay, and an account that left the contract keeps its row. A rename whose stored version moved writes nothing.

## 0.2.0

### Minor Changes

- [#1007](https://github.com/knpkv/npm/pull/1007) [`f981895`](https://github.com/knpkv/npm/commit/f98189507ed95617a57d51b812d8ddc76c6de6c8) Thanks [@konopkov](https://github.com/konopkov)! - A reset that verifies clean now quarantines the account when the budget action's deny-all SCP is still attached, with the blocker from `budgetHoldBlocker(contract)`. `PoolAccess` gains `budgetHold`, and `isBudgetHoldFor(contract, blocker)` (exact, for approvals) and `isBudgetHold(blocker)` (for display) tell a hold from a failed step. The reset never detaches the policy.

- [#1009](https://github.com/knpkv/npm/pull/1009) [`98af69f`](https://github.com/knpkv/npm/commit/98af69f536d7ff4d4b04d9906d523e8dcb1a2900) Thanks [@konopkov](https://github.com/konopkov)! - `resetAccount` records each run in a new `RunLog` service: a start, each step's start and end (with the blocker and the aws-nuke output tail), and the outcome. `summarizeRuns` folds the entries into one summary per run, and `makeMemoryRunLog` is an in-memory log. `SandboxStore` operations may now fail with `SandboxStoreUnavailable`, for durable stores; the memory store never does. `resetAccount` now requires `RunLog`.

## 0.1.0

### Minor Changes

- [#996](https://github.com/knpkv/npm/pull/996) [`1621b7e`](https://github.com/knpkv/npm/commit/1621b7ed1661ebe0538c33814bf1650fc5a45d9a) Thanks [@konopkov](https://github.com/konopkov)! - Add the sandbox pool's lease model, reset job and compare-and-set store contract.
