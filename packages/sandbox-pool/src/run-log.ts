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

/**
 * One run as the hub lists it. `outcome` is null while it runs; `current` is the step in progress;
 * `failedStep` is the last step that reported failed, null for a run with no failed step.
 */
export interface RunSummary {
  readonly runId: RunId
  readonly accountId: AccountId
  readonly reason: CleaningReason
  readonly startedAt: DateTime.Utc
  readonly endedAt: DateTime.Utc | null
  readonly outcome: "Available" | "Quarantined" | null
  readonly blocker: string | null
  readonly current: RunStep | null
  readonly failedStep: RunStep | null
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
        current: null,
        failedStep: null
      })
      continue
    }
    const run = runs.get(entry.runId)
    if (run === undefined) continue
    runs.set(
      entry.runId,
      entry._tag === "Step"
        ? {
          ...run,
          current: entry.status === "started" ? entry.step : null,
          failedStep: entry.status === "failed" ? entry.step : run.failedStep
        }
        : { ...run, endedAt: entry.at, outcome: entry.outcome, blocker: entry.blocker, current: null }
    )
  }
  return [...runs.values()].sort((a, b) => DateTime.toEpochMillis(b.startedAt) - DateTime.toEpochMillis(a.startedAt))
}

/** One line of a run's log. Output lines carry the time their step reported. */
export interface RunLogLine {
  readonly at: DateTime.Utc
  readonly text: string
}

/** A log line and the stored line stop at 2,000 characters, so one long line can't crowd out the rest. */
const lineLimit = 2_000

const clamp = (text: string): string => Array.from(text).slice(0, lineLimit).join("")

const stepResult = (entry: Extract<RunEntry, { readonly _tag: "Step" }>): string =>
  entry.status === "failed" && entry.detail !== null
    ? `${entry.step}: failed: ${entry.detail}`
    : `${entry.step}: ${entry.status}`

/** One entry's lines, unclamped. */
const entryLines = (entry: RunEntry): ReadonlyArray<RunLogLine> => {
  switch (entry._tag) {
    case "Started":
      return [{
        at: entry.at,
        text: `run ${entry.runId} started, reason ${entry.reason.toLowerCase()}, account ${entry.accountId}`
      }]
    case "Step":
      return [...entry.output.map((text) => ({ at: entry.at, text })), { at: entry.at, text: stepResult(entry) }]
    case "Finished":
      return [{
        at: entry.at,
        text: `run ${entry.runId} ended, account ${entry.outcome.toLowerCase()}`
      }]
  }
}

/**
 * A run's entries as the owner's log reads them, oldest first: the start, each step with its output before its
 * result, the end. The lines name the account's resources, so they are as private as the account.
 */
export const runLogLines = (entries: ReadonlyArray<RunEntry>): ReadonlyArray<RunLogLine> =>
  entries.flatMap(entryLines).map(({ at, text }) => ({ at, text: clamp(text) }))

/** The stored line of the run's failure: its quarantine blocker, else the last failed step's detail, else null. */
export const failedLine = (entries: ReadonlyArray<RunEntry>): string | null => {
  const finished = entries.find((entry): entry is Extract<RunEntry, { readonly _tag: "Finished" }> =>
    entry._tag === "Finished"
  )
  if (finished !== undefined && finished.blocker !== null) return clamp(finished.blocker)
  const failed = entries.filter((entry): entry is Extract<RunEntry, { readonly _tag: "Step" }> =>
    entry._tag === "Step" && entry.status === "failed"
  ).at(-1)
  return failed === undefined || failed.detail === null ? null : clamp(`${failed.step}: ${failed.detail}`)
}

/** The run log could not be read or written. */
export class RunLogUnavailable extends Schema.TaggedError<RunLogUnavailable>()("RunLogUnavailable", {
  detail: Schema.String
}) {}

/** The run is not one of this account's runs. */
export class RunNotFound extends Schema.TaggedError<RunNotFound>()("RunNotFound", {
  runId: Schema.String
}) {}

/** `before` named a run this account does not have. The page is not empty. */
export class UnknownRunCursor extends Schema.TaggedError<UnknownRunCursor>()("UnknownRunCursor", {
  runId: Schema.String
}) {}

export interface RunPageQuery {
  readonly limit: number
  readonly before?: RunId | undefined
}

/** Newest first. `before` starts strictly after that run; an unknown cursor fails. */
export const pageRuns = <A extends { readonly runId: RunId }>(
  newestFirst: ReadonlyArray<A>,
  options: RunPageQuery
): Effect.Effect<{ readonly page: ReadonlyArray<A>; readonly next: RunId | null }, UnknownRunCursor> => {
  let offset = 0
  if (options.before !== undefined) {
    const start = newestFirst.findIndex((item) => item.runId === options.before)
    if (start < 0) return Effect.fail(new UnknownRunCursor({ runId: options.before }))
    offset = start + 1
  }
  const page = newestFirst.slice(offset, offset + options.limit)
  const last = page[page.length - 1]
  const next = offset + page.length < newestFirst.length && last !== undefined ? last.runId : null
  return Effect.succeed({ page, next })
}

export interface RunPage {
  readonly runs: ReadonlyArray<RunSummary>
  readonly next: RunId | null
}

export class RunLog extends Context.Service<
  RunLog,
  {
    readonly record: (entry: RunEntry) => Effect.Effect<void, RunLogUnavailable>
    /** A run's entries in recording order; empty for an unknown run. */
    readonly entries: (runId: RunId) => Effect.Effect<ReadonlyArray<RunEntry>, RunLogUnavailable>
    /** The newest `limit` runs. */
    readonly recent: (limit: number) => Effect.Effect<ReadonlyArray<RunSummary>, RunLogUnavailable>
    /** One account's runs, newest first, paged by run id. */
    readonly forAccount: (
      accountId: AccountId,
      options: RunPageQuery
    ) => Effect.Effect<RunPage, RunLogUnavailable | UnknownRunCursor>
  }
>()("SandboxPool/RunLog") {}

/** A fresh in-memory run log, for tests and fixtures. */
export const makeMemoryRunLog: Effect.Effect<RunLog["Service"]> = Effect.map(
  Ref.make<ReadonlyArray<RunEntry>>([]),
  (log) =>
    RunLog.of({
      record: (entry) => Ref.update(log, (entries) => [...entries, entry]),
      entries: (runId) => Effect.map(Ref.get(log), (entries) => entries.filter((entry) => entry.runId === runId)),
      recent: (limit) => Effect.map(Ref.get(log), (entries) => summarizeRuns(entries).slice(0, limit)),
      forAccount: (accountId, options) =>
        Ref.get(log).pipe(
          Effect.map((entries) => summarizeRuns(entries).filter((summary) => summary.accountId === accountId)),
          Effect.flatMap((summaries) => pageRuns(summaries, options)),
          Effect.map(({ next, page }) => ({ runs: page, next }))
        )
    })
)
