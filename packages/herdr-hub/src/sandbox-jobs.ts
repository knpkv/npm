/**
 * Fleet `sandbox.*` jobs and the pool sweep, for the one host that owns the sandbox pool. @module
 *
 * Every write reads the record, applies a pure `@knpkv/sandbox-pool` transition and puts it with a
 * compare-and-set, retrying a `StaleVersion` from a fresh read. The lease holder is always the job's
 * authenticated actor. Releasing or resetting an account runs its reset inside the same job, with the
 * job id as the run id; one lock per account keeps a job and the sweep from resetting it twice.
 *
 * Nothing here talks to AWS: `PoolAccess`, `Nuke` and `BudgetControl` are supplied by the host.
 */
import type { ApprovedJobIdentity, HostOperations, JobActor } from "@knpkv/herdr-fleet"
import { FleetOperationError } from "@knpkv/herdr-fleet"
import { type SandboxJobKind, SandboxJobPayload } from "@knpkv/herdr-fleet/model"
import {
  AccountNotInPool,
  expire,
  extend,
  Holder,
  isBudgetHoldFor,
  lease,
  manualReset,
  Nuke,
  PoolAccess,
  type PoolContract,
  release,
  resetAccount,
  retry,
  RunId,
  RunLog,
  Sandbox,
  type SandboxStore,
  SandboxStoreUnavailable
} from "@knpkv/sandbox-pool"
import { Context, DateTime, Duration, Effect, Option, Ref, Schedule, Schema, Semaphore } from "effect"

/** The budget action's deny-all SCP could not be detached. */
export class BudgetLiftFailed extends Schema.TaggedError<BudgetLiftFailed>()("BudgetLiftFailed", {
  accountId: Schema.String,
  detail: Schema.String
}) {}

/** The job's actor or id is not a valid lease holder or run id. Nothing was written. */
export class SandboxJobInvalid extends Schema.TaggedError<SandboxJobInvalid>()("SandboxJobInvalid", {
  field: Schema.Literals(["actor", "jobId"]),
  detail: Schema.String
}) {}

/** `sandbox.reset` and `sandbox.budget.lift` run only with a persisted Fleet approval. */
export class ApprovalRequired extends Schema.TaggedError<ApprovalRequired>()("ApprovalRequired", {}) {}

/** A budget lift on an account that is not quarantined by this pool's budget hold. */
export class NotBudgetHeld extends Schema.TaggedError<NotBudgetHeld>()("NotBudgetHeld", {
  accountId: Schema.String
}) {}

/**
 * Detaches the budget action's deny-all SCP from a pool account. Approval-gated by `sandbox.budget.lift`.
 * Must be idempotent: a policy that is already detached is success, so a rerun after a partial lift
 * converges instead of failing.
 */
export class BudgetControl extends Context.Service<
  BudgetControl,
  { readonly lift: (accountId: string) => Effect.Effect<void, BudgetLiftFailed> }
>()("HerdrHub/BudgetControl") {}

/** Every sandbox kind; the pool owner declares them all. */
export const sandboxJobKinds: ReadonlySet<SandboxJobKind> = new Set([
  "sandbox.lease",
  "sandbox.extend",
  "sandbox.release",
  "sandbox.reset",
  "sandbox.budget.lift"
])

/** What one sweep did. `failed` counts accounts whose step errored; each is logged. */
export interface SweepReport {
  readonly at: DateTime.Utc
  readonly expired: number
  readonly resumed: number
  readonly failed: number
}

type SweepOutcome = "idle" | "expired" | "resumed" | "failed"

const encodeSandbox = Schema.encodeSync(Schema.fromJsonString(Sandbox))
const isStoreUnavailable = Schema.is(SandboxStoreUnavailable)

/** A tagged error's tag and fields, for the job's failure detail. */
const describe = (error: { readonly _tag: string }) => JSON.stringify(error)

export interface SandboxPoolServices {
  readonly contract: PoolContract
  readonly store: SandboxStore["Service"]
  readonly runLog: RunLog["Service"]
  readonly access: PoolAccess["Service"]
  readonly nuke: Nuke["Service"]
  readonly budget: BudgetControl["Service"]
}

/**
 * The pool owner's job runner and sweep. `run` executes one `sandbox.*` job; `sweepOnce` expires
 * leases past their end and resumes resets left in Cleaning (after a restart, or a defect), each
 * under the account's lock and skipped while a job holds it. `lastSweep` is the latest report.
 */
export const makeSandboxPool = Effect.fn("SandboxPool.make")(function*(services: SandboxPoolServices) {
  const { contract, store } = services
  const locks = new Map<string, Semaphore.Semaphore>()
  for (const { accountId } of contract.accounts) locks.set(accountId, yield* Semaphore.make(1))
  const lastSweep = yield* Ref.make<SweepReport | null>(null)

  /**
   * `rejected` asserts nothing was committed: the failure came before any record was written. A put the
   * store could not confirm (`SandboxStoreUnavailable` on put) may have landed, so it is never rejected.
   */
  const fail = (operation: string, error: { readonly _tag: string }, rejected: boolean) =>
    rejected && !(isStoreUnavailable(error) && error.operation === "put")
      ? new FleetOperationError({ operation, detail: describe(error), cause: error, disposition: "rejected" })
      : new FleetOperationError({ operation, detail: describe(error), cause: error })

  const reset = (cleaning: Sandbox, runId: RunId) =>
    resetAccount(contract, cleaning, runId).pipe(
      Effect.provideService(PoolAccess, services.access),
      Effect.provideService(Nuke, services.nuke),
      Effect.provideService(RunLog, services.runLog),
      Effect.flatMap(store.put)
    )

  /** Read, transition, put; a lost compare-and-set re-reads up to three times. */
  const transition = <E extends { readonly _tag: string }>(
    accountId: string,
    step: (current: Sandbox) => Effect.Effect<Sandbox, E>
  ) =>
    store.get(accountId).pipe(
      Effect.flatMap(step),
      Effect.flatMap(store.put),
      Effect.retry({ times: 3, while: (error) => error._tag === "StaleVersion" })
    )

  const lockFor = (operation: string, accountId: string) => {
    const lock = locks.get(accountId)
    return lock === undefined
      ? Effect.fail(fail(operation, new AccountNotInPool({ accountId }), true))
      : Effect.succeed(lock)
  }

  /** Runs `body` holding the account's lock, so no other job or sweep resets it meanwhile. */
  const locked = <A>(operation: string, accountId: string, body: Effect.Effect<A, FleetOperationError>) =>
    Effect.flatMap(lockFor(operation, accountId), (lock) => Semaphore.withPermit(lock, body))

  /**
   * Moves the account to Cleaning for this job and resets it; the caller holds the lock. `committed` says
   * whether anything outside the store already changed, so a failed transition is not "rejected".
   */
  const cleanThenReset = Effect.fn("SandboxPool.cleanThenReset")(function*<E extends { readonly _tag: string }>(
    operation: string,
    accountId: string,
    runId: RunId,
    toCleaning: (current: Sandbox, now: DateTime.Utc) => Effect.Effect<Sandbox, E>,
    committed = false
  ) {
    const now = yield* DateTime.now
    const cleaning = yield* transition(accountId, (current) => toCleaning(current, now)).pipe(
      Effect.mapError((error) => fail(operation, error, !committed))
    )
    return yield* reset(cleaning, runId).pipe(Effect.mapError((error) => fail(operation, error, false)))
  })

  const run = Effect.fn("SandboxPool.run")(function*(
    payload: SandboxJobPayload,
    jobId: string,
    actor: JobActor,
    approval: ApprovedJobIdentity | null
  ) {
    const operation = payload.kind
    const holder = yield* Schema.decodeUnknownEffect(Holder)(actor).pipe(
      Effect.mapError((cause) =>
        fail(operation, new SandboxJobInvalid({ field: "actor", detail: String(cause) }), true)
      )
    )
    const runId = yield* Schema.decodeUnknownEffect(RunId)(jobId).pipe(
      Effect.mapError((cause) =>
        fail(operation, new SandboxJobInvalid({ field: "jobId", detail: String(cause) }), true)
      )
    )
    const needsApproval = payload.kind === "sandbox.reset" || payload.kind === "sandbox.budget.lift"
    if (needsApproval && approval === null) {
      return yield* fail(operation, new ApprovalRequired(), true)
    }
    const done = (sandbox: Sandbox) => encodeSandbox(sandbox)
    switch (payload.kind) {
      case "sandbox.lease": {
        const now = yield* DateTime.now
        const leased = yield* store.list.pipe(
          // Rows kept for accounts that left the contract are history, not candidates.
          Effect.flatMap((pool) => lease(pool.filter(({ accountId }) => locks.has(accountId)), holder, now)),
          Effect.flatMap(store.put),
          Effect.retry({ times: 3, while: (error) => error._tag === "StaleVersion" }),
          Effect.mapError((error) => fail(operation, error, true))
        )
        return done(leased)
      }
      case "sandbox.extend":
        yield* lockFor(operation, payload.accountId)
        return done(
          yield* transition(payload.accountId, (current) => extend(current, holder)).pipe(
            Effect.mapError((error) => fail(operation, error, true))
          )
        )
      case "sandbox.release":
        return done(
          yield* locked(
            operation,
            payload.accountId,
            cleanThenReset(operation, payload.accountId, runId, (current, now) => release(current, holder, runId, now))
          )
        )
      case "sandbox.reset":
        return done(
          yield* locked(
            operation,
            payload.accountId,
            cleanThenReset(
              operation,
              payload.accountId,
              runId,
              (current, now) =>
                payload.reason === "Manual" ? manualReset(current, runId, now) : retry(current, runId, now)
            )
          )
        )
      case "sandbox.budget.lift": {
        const accountId = payload.accountId
        const lifted = Effect.gen(function*() {
          const current = yield* store.get(accountId).pipe(Effect.mapError((error) => fail(operation, error, true)))
          if (current.state._tag !== "Quarantined" || !isBudgetHoldFor(contract, current.state.blocker)) {
            return yield* fail(operation, new NotBudgetHeld({ accountId }), true)
          }
          // Once lift is called the policy may be detached, so nothing after it is "rejected"; a rerun
          // converges because lift is idempotent. Then reset again, re-verifying and re-reading the hold.
          yield* services.budget.lift(accountId).pipe(Effect.mapError((error) => fail(operation, error, false)))
          return yield* cleanThenReset(operation, accountId, runId, (latest, now) => retry(latest, runId, now), true)
        })
        return done(yield* locked(operation, accountId, lifted))
      }
    }
  })

  const idle = Option.match({ onNone: (): SweepOutcome => "idle", onSome: (outcome: SweepOutcome) => outcome })

  const leaseEnded = (sandbox: Sandbox, now: DateTime.Utc) =>
    sandbox.state._tag === "Leased" && DateTime.isLessThanOrEqualTo(sandbox.state.endsAt, now)

  /**
   * One account's sweep step: expire a lease past its end, or resume a reset nobody is running. The
   * list snapshot only picks candidates; the decision is made on a fresh read under the lock, so a
   * job that finished the account meanwhile (or a new lease on it) is never reset from a stale record.
   */
  const sweepAccount = (snapshot: Sandbox, now: DateTime.Utc) => {
    const lock = locks.get(snapshot.accountId)
    const pending = snapshot.state
    if (lock === undefined || !(leaseEnded(snapshot, now) || pending._tag === "Cleaning")) {
      return Effect.succeed<SweepOutcome>("idle")
    }
    const decide = Effect.gen(function*() {
      const current = yield* store.get(snapshot.accountId)
      const state = current.state
      if (leaseEnded(current, now)) {
        const runId = Schema.decodeUnknownSync(RunId)(`sweep-${DateTime.toEpochMillis(now)}-${current.accountId}`)
        yield* store.put(expire(current, runId, now)).pipe(Effect.flatMap((cleaning) => reset(cleaning, runId)))
        return "expired" satisfies SweepOutcome
      }
      if (state._tag === "Cleaning" && pending._tag === "Cleaning" && state.runId === pending.runId) {
        yield* reset(current, state.runId)
        return "resumed" satisfies SweepOutcome
      }
      return "idle" satisfies SweepOutcome
    })
    return Semaphore.withPermitsIfAvailable(lock, 1, decide).pipe(Effect.map(idle))
  }

  const sweepOnce = Effect.gen(function*() {
    const now = yield* DateTime.now
    const pool = yield* store.list
    const outcomes = yield* Effect.forEach(pool, (sandbox) =>
      sweepAccount(sandbox, now).pipe(
        Effect.catch((error) =>
          Effect.logWarning("sandbox sweep step failed", sandbox.accountId, describe(error)).pipe(
            Effect.as<SweepOutcome>("failed")
          )
        )
      ))
    const report: SweepReport = {
      at: now,
      expired: outcomes.filter((outcome) => outcome === "expired").length,
      resumed: outcomes.filter((outcome) => outcome === "resumed").length,
      failed: outcomes.filter((outcome) => outcome === "failed").length
    }
    yield* Ref.set(lastSweep, report)
    return report
  })

  return { run, sweepOnce, lastSweep: Ref.get(lastSweep) }
})

export type SandboxPool = Effect.Success<ReturnType<typeof makeSandboxPool>>

export const sandboxSweepInterval = Duration.minutes(5)

/**
 * Sweeps now and then every five minutes, for hostd to fork in its lifetime scope. A sweep that
 * cannot read the store is logged and the next one still runs; interrupting the fiber stops it.
 */
export const runSandboxSweep = (pool: SandboxPool): Effect.Effect<void> =>
  pool.sweepOnce.pipe(
    Effect.catch((error) => Effect.logWarning("sandbox sweep could not read the pool", describe(error))),
    Effect.repeat(Schedule.spaced(sandboxSweepInterval)),
    Effect.asVoid
  )

const isSandboxJob = Schema.is(SandboxJobPayload)

/**
 * Adds the pool's jobs to a host's operations: sandbox kinds run against `pool`, everything else
 * goes to `base`, and `sandboxJobKinds` declares every sandbox kind so submission accepts them.
 */
export const withSandboxOperations = (base: HostOperations, pool: SandboxPool): HostOperations => ({
  ...base,
  sandboxJobKinds,
  run: (payload, workerStarted, jobId, actor, lifecycle, approval) =>
    isSandboxJob(payload)
      ? pool.run(payload, jobId, actor, approval ?? null)
      : base.run(payload, workerStarted, jobId, actor, lifecycle, approval)
})
