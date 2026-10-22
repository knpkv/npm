# @knpkv/sandbox-pool

Lease model and reset job for a pool of ephemeral AWS sandbox accounts. An agent or person leases an account for 8 hours, can extend it up to 24 hours from the start, and hands it back. The account is then emptied with aws-nuke before anyone gets it again. A reset that fails quarantines the account until someone retries it.

```ts
import { lease, memorySandboxStore, PoolContract, SandboxStore, seedPool } from "@knpkv/sandbox-pool"

// The pool comes from the owning host's configuration, never from this package.
const contract = yield * Schema.decodeUnknownEffect(PoolContract)(config.sandboxPool)

const leased = Effect.gen(function* () {
  const store = yield* SandboxStore
  const next = yield* lease(yield* store.list, holder, yield* DateTime.now)
  return yield* store.put(next) // fails StaleVersion if another writer moved the account first
}).pipe(Effect.provide(memorySandboxStore(seedPool(contract))))
```

## Run it on its own

This package has no executable and no server of its own: `hostd` from `@knpkv/herdr-hub` mounts it.

## Pool contract

The package ships no real organization. `PoolContract` is decoded from the owning host's configuration:

- `accounts`: the pool, each with a distinct `name` and 12-digit `accountId`.
- `nukeBlocklist`: every organization account outside the pool, the management account included, so never empty. aws-nuke refuses them whatever its config says, and a reset refuses to start on one. Decoding fails if a pool account is in it.
- `regions`: the regions aws-nuke scans besides `global`.
- `accountAccessRole`: the role a reset assumes in a pool account, which aws-nuke keeps.
- `boundaryPath` and `boundaryName`: the permissions boundary policy a reset re-asserts and keeps.
- `accountAliasPrefix`: a pool account's alias is this prefix plus its name.
- `budgetActionRole` and `denyAllPolicy`: the budget action's role and the policy it attaches to stop spend.

## States

```
Available --lease--> Leased --release/expire--> Cleaning --reset ok--> Available
                       ^ extend (+8h, 24h cap)       \--reset failed--> Quarantined --retry--> Cleaning
```

| Transition                                  | From → to                                           | Fails with                                     |
| ------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| `lease(pool, holder, now)`                  | longest-idle Available → Leased, ends 8h later      | `NoneAvailable`                                |
| `extend(sandbox, holder)`                   | Leased → Leased, +8h, capped at 24h after the start | `NotHolder`, `CapReached`, `InvalidTransition` |
| `release(sandbox, holder, runId, now)`      | Leased → Cleaning (Released)                        | `NotHolder`, `InvalidTransition`               |
| `expire(sandbox, runId, now)`               | Leased past its end → Cleaning (Expired)            | none; other states pass through                |
| `manualReset(sandbox, runId, now)`          | Available or Leased → Cleaning (Manual)             | `InvalidTransition`                            |
| `resetSucceeded(sandbox, runId, now)`       | Cleaning for `runId` → Available                    | `StaleRun`, `InvalidTransition`                |
| `resetFailed(sandbox, runId, blocker, now)` | Cleaning for `runId` → Quarantined                  | `StaleRun`, `InvalidTransition`                |
| `retry(sandbox, runId, now)`                | Quarantined → Cleaning (Retry)                      | `InvalidTransition`                            |

Transitions are pure and bump `version` by one. A `Holder` is an agent, pane or viewer identity, never an email.

## Store

`SandboxStore` holds one record per pool account. `put(next)` writes only when the stored record is still at `next.version - 1`, the version the transition was computed from. Otherwise it fails with `StaleVersion`: re-read and apply the transition again. A record whose name differs from the stored one fails with `RecordMismatch`. `rename(accountId, name)` is the name change that `put` refuses: the version and state stay, and a name that already matches writes nothing. `makeMemorySandboxStore` builds a fresh in-memory store for tests and fixtures (`memorySandboxStore` is the same as a layer); `seedPool(contract)` gives every pool account as Available at version 0. A durable store fails with `SandboxStoreUnavailable` when it cannot be reached, and writes nothing. `sweepAt` is the last successful sweep's epoch milliseconds, or null until `markSweep` records one.

## Reset

`resetAccount(contract, sandbox, runId)` needs two services:

- `PoolAccess`: `session(accountId)` assumes the contract's `accountAccessRole` from the management SSO session. `ensureBaseline` re-creates the account alias and the contract's boundary policy.
- `Nuke`: `writeConfig` and `run({ configPath, session, live })` for the aws-nuke v3 binary.

It runs session → baseline → dry run → guard → live run → verifying dry run (must find nothing removable) → baseline again.

The dry run and the verifying run must also be complete: an error-level log line, such as aws-nuke's `listing failed` for a resource type it could not list, quarantines the account with the blocker `"<step>: incomplete scan: <line>"`, or libnuke's warning that a resource type's scan queue filled (`not all resources will be enqueued`), even when the run exits 0 and counts nothing removable. `discoveryFailures(output)` returns those lines. aws-nuke runs with colours off and full timestamps (`nukeArgs`), so they have one shape. The live run's own errors are left to the verifying run.

After the verifying run and the baseline re-assert, `PoolAccess.budgetHold` checks whether the budget action attached the contract's `denyAllPolicy` SCP: the month's spend is over the cap. A held account is quarantined even though it is clean, with the blocker `budgetHoldBlocker(contract)`, `"budget hold: <denyAllPolicy> attached; lift via sandbox.budget.lift"`. Reset never detaches the policy; only the approval-gated `sandbox.budget.lift` does. The text is a contract: match it with `isBudgetHoldFor(contract, blocker)` (exact, for approvals) or `isBudgetHold(blocker)` (any pool, for display), never a copied string. The host routes do not serve this sentence. A failed read of the hold quarantines under the step `budget hold check`, whatever the access layer reported, so it never matches either.

The guard is a second layer under the aws-nuke filters. If the dry run lists any protected resource for removal, the reset stops before the live run, whatever the config says. Protected: the Identity Center SAML provider and roles, the access role, service-linked roles, the boundary, the budget action's role and policy, and the pool accounts' aliases. It fails closed: removal lines are read through terminal colour codes and carriage returns, and if their count differs from the scan summary's nukeable count the reset stops too, since an unreadable line could be a protected resource. `protectedListed(contract, output)` returns what it found; the blocker step is `guard`. Any step's failure becomes the Quarantined blocker `"<step>: <detail>"`, at most 500 characters. Only `AccountNotInPool`, `InvalidTransition` and `StaleRun` fail the job itself. The aws-nuke config always blocks the contract's `nukeBlocklist`.

This package has no live AWS layers: the host that runs resets provides `PoolAccess`, `Nuke` and `BudgetControl`.

## Host read

`@knpkv/sandbox-pool/host` is the read model. `makeSandboxHostReads` from `@knpkv/sandbox-pool/host/server` builds it from a store and a run log. Stored blocker lines stay in the process that holds the store.

A card carries the account id, name and state. `label` is `"left the pool"` when that id is absent from the current contract. The state tag stays, so a lease that left the contract remains Leased, with its holder id, `startedAt` and `endsAt`. An available card keeps `lastResetAt`, null when the account has never been reset. Cleaning and quarantine carry `runId` and the current step, taken from that account's newest 20 runs when the run id matches. A quarantine blocker is `sandboxBlockerFrom` of the stored line: `ResourcesRemain` (how many remain), `NukeFailed` (a PascalCase resource type, or none), `BudgetHold`, `ScanIncomplete`, or `Unknown`. Each tag's `text` is fixed copy for that tag. The stored line is not served, so a role name, ARN, resource name, policy name, listing, or failure reason cannot cross the route. The account id stays on the card. Version, the cleaning reason and quarantine time stay in the store.

Overview is `Ready` with cards sorted by account id, or `Failed` with `reason: "unavailable"` when the store or the run log cannot be read. `Failed` is not an empty pool. The badge counts quarantined rows, including accounts that left the pool. `stale` and `partial` are true when `sweepAt` is null or older than 10 minutes (`sweepStaleAfterMillis`); 10 minutes exactly is fresh. `sandboxNavigationBadge` returns nothing when the count is 0 and the sweep is fresh. A stale zero has empty text and a label that says the count is stale.

`forAccount(accountId, { limit, before })` pages that account's runs, newest first. A resumed run has a second `Started` entry and still counts as one row. `pageRuns` is the same cut. `before` starts strictly after that run. An unknown `before` fails with `UnknownRunCursor`. `next` is the last run id on the page when older runs remain, otherwise null. The hosted query defaults `limit` to 20 and rejects a limit outside 1–50. An unknown account is `SandboxNotFound`. Each served run carries its run id, the step in progress, the cleaning `reason`, `startedAt`, `endedAt` (null while it runs), `outcome`, `failedStep` (the step that reported failed, or null) and the closed blocker; never the stored line or output.

`attention` lists quarantined rows for needs-you. A blocker that `isBudgetHoldFor` matches is `budget-hold` and is not also `quarantined`. A store failure stays `SandboxStoreUnavailable`.

## Run log

`resetAccount` also needs a `RunLog`. It records a run's `Started` entry, a `Step` entry when each step starts and when it ends (`ok` or `failed`, with the blocker as `detail`), and a `Finished` entry with the outcome. The steps, in order: `sign in`, `baseline`, `dry run` (which includes the guard), `nuke`, `verify`, `baseline re-check`, `budget hold`. A step that ran aws-nuke carries `outputTail(output)`: its last 40 lines, uncoloured, at most 300 characters each. They name the pool account's resources, so the log is as private as the account and is shown only on authenticated routes. `summarizeRuns(entries)` folds entries into one `RunSummary` per run (newest first, with the step in progress); `makeMemoryRunLog` is the in-memory log. Recording is best effort: a failed write (`RunLogUnavailable`) is logged as a warning and never changes the reset's outcome. A durable log must map every store failure, thrown driver errors and undecodable rows included, to `RunLogUnavailable`; a defect propagates and leaves the account Cleaning for the sweep to resume. Hosts must serve `entries(runId)`, which carries the output tail, to the pool owner only; run summaries carry no output. `forAccount` pages one account's summaries and fails with `UnknownRunCursor` when `before` is not one of that account's runs.
