import { Context, DateTime, Effect, Ref, Schema } from "effect"
import { CleaningReason, RunId } from "./lease.js"
import { AccountId } from "./pool.js"

/**
 * What one reset run did, step by step, for the hub's run views. `resetAccount`
 * records a run's entries as it goes; a store keeps them in order, and
 * `summarizeRuns` folds them into one summary per run. Recording is best
 * effort: a failed write is logged and never changes the reset's outcome. An
 * implementation must report every store failure, a thrown driver error or an
 * undecodable row included, as `RunLogUnavailable`, never as a defect: a defect
 * propagates and ends the reset with the account still Cleaning, for the sweep
 * to resume.
 */

const Instant = Schema.DateTimeUtcFromString

/** A reset's steps in the order they run. `sign in` is the session; `dry run` includes the guard. */
export const RunStep = Schema.Literals([
  "sign in",
  "baseline",
  "dry run",
  "nuke",
  "verify",
  "baseline re-check",
  "budget hold"
])
export type RunStep = typeof RunStep.Type

export const RunEntry = Schema.TaggedUnion({
  Started: { runId: RunId, accountId: AccountId, reason: CleaningReason, at: Instant },
  /** `detail` is the failure, at most 500 characters; `output` the aws-nuke tail for nuke steps. */
  Step: {
    runId: RunId,
    step: RunStep,
    status: Schema.Literals(["started", "ok", "failed"]),
    at: Instant,
    detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
    output: Schema.Array(Schema.String)
  },
  Finished: {
    runId: RunId,
    outcome: Schema.Literals(["Available", "Quarantined"]),
    blocker: Schema.NullOr(Schema.String),
    at: Instant
  }
})
export type RunEntry = typeof RunEntry.Type

/** One run as the hub lists it. `outcome` is null while it runs; `current` is the step in progress. */
export interface RunSummary {
  readonly runId: RunId
  readonly accountId: AccountId
  readonly reason: CleaningReason
  readonly startedAt: DateTime.Utc
  readonly endedAt: DateTime.Utc | null
  readonly outcome: "Available" | "Quarantined" | null
  readonly blocker: string | null
  readonly current: RunStep | null
}

/** One summary per started run, newest start first. Entries of a run whose start is missing are ignored. */
export const summarizeRuns = (entries: ReadonlyArray<RunEntry>): ReadonlyArray<RunSummary> => {
  const runs = new Map<RunId, RunSummary>()
  for (const entry of entries) {
    if (entry._tag === "Started") {
      runs.set(entry.runId, {
        runId: entry.runId,
        accountId: entry.accountId,
        reason: entry.reason,
        startedAt: entry.at,
        endedAt: null,
        outcome: null,
        blocker: null,
        current: null
      })
      continue
    }
    const run = runs.get(entry.runId)
    if (run === undefined) continue
    runs.set(
      entry.runId,
      entry._tag === "Step"
        ? { ...run, current: entry.status === "started" ? entry.step : null }
        : { ...run, endedAt: entry.at, outcome: entry.outcome, blocker: entry.blocker, current: null }
    )
  }
  return [...runs.values()].sort((a, b) => DateTime.toEpochMillis(b.startedAt) - DateTime.toEpochMillis(a.startedAt))
}

/** The run log could not be read or written. */
export class RunLogUnavailable extends Schema.TaggedError<RunLogUnavailable>()("RunLogUnavailable", {
  detail: Schema.String
}) {}

export class RunLog extends Context.Service<
  RunLog,
  {
    readonly record: (entry: RunEntry) => Effect.Effect<void, RunLogUnavailable>
    /** A run's entries in recording order; empty for an unknown run. */
    readonly entries: (runId: RunId) => Effect.Effect<ReadonlyArray<RunEntry>, RunLogUnavailable>
    /** The newest `limit` runs. */
    readonly recent: (limit: number) => Effect.Effect<ReadonlyArray<RunSummary>, RunLogUnavailable>
  }
>()("SandboxPool/RunLog") {}

/** A fresh in-memory run log, for tests and fixtures. */
export const makeMemoryRunLog: Effect.Effect<RunLog["Service"]> = Effect.map(
  Ref.make<ReadonlyArray<RunEntry>>([]),
  (log) =>
    RunLog.of({
      record: (entry) => Ref.update(log, (entries) => [...entries, entry]),
      entries: (runId) => Effect.map(Ref.get(log), (entries) => entries.filter((entry) => entry.runId === runId)),
      recent: (limit) => Effect.map(Ref.get(log), (entries) => summarizeRuns(entries).slice(0, limit))
    })
)
