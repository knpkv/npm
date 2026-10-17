import { DateTime, Duration, Effect, Schema } from "effect"
import { AccountId, SandboxName } from "./pool.js"

/**
 * The pool's lease model. The single hostd that owns the pool stores one
 * `Sandbox` per account and applies these pure transitions with a
 * compare-and-set on `version`. Other hosts reach it through fleetctl jobs.
 *
 *   Available --lease--> Leased --release/expire--> Cleaning --reset ok--> Available
 *                          ^ extend (+8h, 24h cap)       \--reset failed--> Quarantined --retry--> Cleaning
 */

export const leaseDuration = Duration.hours(8)
export const leaseCap = Duration.hours(24)

const Instant = Schema.DateTimeUtcFromString

/** Who holds a lease: an agent, pane or viewer identity, never an email. */
export const Holder = Schema.NonEmptyString.pipe(Schema.brand("Holder"))
export type Holder = typeof Holder.Type

export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

export const CleaningReason = Schema.Literals(["Released", "Expired", "Manual", "Retry"])
export type CleaningReason = typeof CleaningReason.Type

export const SandboxState = Schema.TaggedUnion({
  Available: { lastResetAt: Schema.NullOr(Instant) },
  Leased: { holder: Holder, startedAt: Instant, endsAt: Instant },
  Cleaning: { since: Instant, runId: RunId, reason: CleaningReason },
  Quarantined: { since: Instant, runId: RunId, blocker: Schema.String }
})
export type SandboxState = typeof SandboxState.Type

export const Sandbox = Schema.Struct({
  accountId: AccountId,
  name: SandboxName,
  state: SandboxState,
  version: Schema.Int
})
export interface Sandbox extends Schema.Schema.Type<typeof Sandbox> {}

export class NoneAvailable extends Schema.TaggedError<NoneAvailable>()("NoneAvailable", {}) {}

export class NotHolder extends Schema.TaggedError<NotHolder>()("NotHolder", {
  accountId: Schema.String
}) {}

export class CapReached extends Schema.TaggedError<CapReached>()("CapReached", {
  accountId: Schema.String
}) {}

export class InvalidTransition extends Schema.TaggedError<InvalidTransition>()("InvalidTransition", {
  accountId: Schema.String,
  from: Schema.String,
  event: Schema.String
}) {}

export class StaleRun extends Schema.TaggedError<StaleRun>()("StaleRun", {
  accountId: Schema.String,
  runId: Schema.String
}) {}

const next = (sandbox: Sandbox, state: SandboxState): Sandbox => ({
  ...sandbox,
  state,
  version: sandbox.version + 1
})

const invalid = (sandbox: Sandbox, event: string): Effect.Effect<never, InvalidTransition> =>
  Effect.fail(new InvalidTransition({ accountId: sandbox.accountId, from: sandbox.state._tag, event }))

/** Lease the longest-idle available account. */
export const lease = (
  pool: ReadonlyArray<Sandbox>,
  holder: Holder,
  now: DateTime.Utc
): Effect.Effect<Sandbox, NoneAvailable> => {
  const available = pool
    .flatMap((sandbox) =>
      sandbox.state._tag === "Available" ? [{ sandbox, lastResetAt: sandbox.state.lastResetAt }] : []
    )
    .sort((a, b) =>
      a.lastResetAt === null
        ? -1
        : b.lastResetAt === null
        ? 1
        : DateTime.toEpochMillis(a.lastResetAt) - DateTime.toEpochMillis(b.lastResetAt)
    )
  const chosen = available[0]?.sandbox
  return chosen === undefined
    ? Effect.fail(new NoneAvailable())
    : Effect.succeed(
      next(
        chosen,
        SandboxState.cases.Leased.make({ holder, startedAt: now, endsAt: DateTime.addDuration(now, leaseDuration) })
      )
    )
}

/** Add 8h, clamped to 24h after the lease started. Only the holder may extend. */
export const extend = (
  sandbox: Sandbox,
  holder: Holder
): Effect.Effect<Sandbox, NotHolder | CapReached | InvalidTransition> => {
  const state = sandbox.state
  if (state._tag !== "Leased") return invalid(sandbox, "extend")
  if (state.holder !== holder) return Effect.fail(new NotHolder({ accountId: sandbox.accountId }))
  const cap = DateTime.addDuration(state.startedAt, leaseCap)
  if (!DateTime.isLessThan(state.endsAt, cap)) return Effect.fail(new CapReached({ accountId: sandbox.accountId }))
  const extended = DateTime.addDuration(state.endsAt, leaseDuration)
  return Effect.succeed(
    next(sandbox, SandboxState.cases.Leased.make({ ...state, endsAt: DateTime.min(extended, cap) }))
  )
}

/** The holder hands the account back; a reset run starts. */
export const release = (
  sandbox: Sandbox,
  holder: Holder,
  runId: RunId,
  now: DateTime.Utc
): Effect.Effect<Sandbox, NotHolder | InvalidTransition> => {
  const state = sandbox.state
  if (state._tag !== "Leased") return invalid(sandbox, "release")
  if (state.holder !== holder) return Effect.fail(new NotHolder({ accountId: sandbox.accountId }))
  return Effect.succeed(next(sandbox, SandboxState.cases.Cleaning.make({ since: now, runId, reason: "Released" })))
}

/** The sweeper moves every lease past its end into Cleaning. Others pass through unchanged. */
export const expire = (sandbox: Sandbox, runId: RunId, now: DateTime.Utc): Sandbox =>
  sandbox.state._tag === "Leased" && !DateTime.isLessThan(now, sandbox.state.endsAt)
    ? next(sandbox, SandboxState.cases.Cleaning.make({ since: now, runId, reason: "Expired" }))
    : sandbox

/**
 * A reset outside a lease end: Available or Leased go to Cleaning. hostd routes
 * this through Fleet Approvals before calling it.
 */
export const manualReset = (
  sandbox: Sandbox,
  runId: RunId,
  now: DateTime.Utc
): Effect.Effect<Sandbox, InvalidTransition> =>
  sandbox.state._tag === "Available" || sandbox.state._tag === "Leased"
    ? Effect.succeed(next(sandbox, SandboxState.cases.Cleaning.make({ since: now, runId, reason: "Manual" })))
    : invalid(sandbox, "manualReset")

const requireRun = (
  sandbox: Sandbox,
  runId: RunId,
  event: string
): Effect.Effect<void, InvalidTransition | StaleRun> => {
  const state = sandbox.state
  if (state._tag !== "Cleaning") return invalid(sandbox, event)
  return state.runId === runId ? Effect.void : Effect.fail(new StaleRun({ accountId: sandbox.accountId, runId }))
}

export const resetSucceeded = (
  sandbox: Sandbox,
  runId: RunId,
  now: DateTime.Utc
): Effect.Effect<Sandbox, InvalidTransition | StaleRun> =>
  requireRun(sandbox, runId, "resetSucceeded").pipe(
    Effect.as(next(sandbox, SandboxState.cases.Available.make({ lastResetAt: now })))
  )

export const resetFailed = (
  sandbox: Sandbox,
  runId: RunId,
  blocker: string,
  now: DateTime.Utc
): Effect.Effect<Sandbox, InvalidTransition | StaleRun> =>
  requireRun(sandbox, runId, "resetFailed").pipe(
    Effect.as(next(sandbox, SandboxState.cases.Quarantined.make({ since: now, runId, blocker })))
  )

/** Retry a quarantined account with a fresh run. */
export const retry = (sandbox: Sandbox, runId: RunId, now: DateTime.Utc): Effect.Effect<Sandbox, InvalidTransition> =>
  sandbox.state._tag === "Quarantined"
    ? Effect.succeed(next(sandbox, SandboxState.cases.Cleaning.make({ since: now, runId, reason: "Retry" })))
    : invalid(sandbox, "retry")

/** Time left on a lease, for the hub's pool view. */
export const timeLeft = (sandbox: Sandbox, now: DateTime.Utc): Duration.Duration | undefined =>
  sandbox.state._tag === "Leased"
    ? Duration.millis(Math.max(0, DateTime.toEpochMillis(sandbox.state.endsAt) - DateTime.toEpochMillis(now)))
    : undefined
