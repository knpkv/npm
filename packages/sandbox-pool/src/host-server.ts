/**
 * Server half of the hosted sandbox read model. `makeSandboxHostReads` turns the pool store and run log
 * into tagged results. Records and stored blocker lines stay in this process, except in `runLog`, which the
 * hosting server must serve to the pool owner only.
 *
 * @module
 */
import { DateTime, Effect, Schema } from "effect"
import {
  runLogLimit,
  SandboxBlocker,
  sandboxBlockerFrom,
  type SandboxCard,
  type SandboxesOverview,
  type SandboxesReadFailed,
  type SandboxRunLog,
  type SandboxRunLogQuery,
  type SandboxRuns,
  type SandboxRunsQuery,
  sweepIsStale
} from "./host.js"
import type { RunId, Sandbox } from "./lease.js"
import type { AccountId, PoolContract } from "./pool.js"
import { isBudgetHoldFor } from "./reset.js"
import { failedLine, type RunLog, runLogLines, RunNotFound, type UnknownRunCursor } from "./run-log.js"
import type { SpendReading } from "./spend.js"
import type { SandboxNotFound, SandboxStore, SandboxStoreUnavailable } from "./store.js"

/** A quarantined row the needs-you collector can turn into one item. A budget hold is not also "quarantined". */
export interface SandboxAttention {
  readonly asOf: number | null
  readonly rows: ReadonlyArray<{
    readonly accountId: AccountId
    readonly since: number
    readonly kind: "quarantined" | "budget-hold"
  }>
}

/** Reads as the hosting server serves them. A failed store or log is a result; an unknown id or cursor fails. */
export interface SandboxHostReads {
  readonly overview: Effect.Effect<SandboxesOverview>
  readonly runs: (
    query: SandboxRunsQuery
  ) => Effect.Effect<SandboxRuns, SandboxNotFound | UnknownRunCursor>
  /** One run's log tail and stored failure line. Owner only: the lines name the account's resources. */
  readonly runLog: (
    query: SandboxRunLogQuery
  ) => Effect.Effect<SandboxRunLog, SandboxNotFound | RunNotFound>
  /** Store failures stay failures so a caller cannot treat them as an empty queue. */
  readonly attention: Effect.Effect<SandboxAttention, SandboxStoreUnavailable>
}

const failed: typeof SandboxesReadFailed.Type = { _tag: "Failed", reason: "unavailable" }

/** A stored line becomes a closed blocker. A copy that misses the schema is a defect, not a served string. */
const servedBlocker = (stored: string) =>
  Schema.decodeUnknownEffect(SandboxBlocker)(sandboxBlockerFrom(stored)).pipe(Effect.orDie)

const readFailure = {
  SandboxStoreUnavailable: () => Effect.succeed(failed),
  RunLogUnavailable: () => Effect.succeed(failed)
}

/**
 * Cards and run pages for one pool. `sweepAt` is the store's last successful sweep; null is stale.
 * The current step is taken from that account's newest runs, and only when the run id matches the record.
 */
export const makeSandboxHostReads = (input: {
  readonly contract: PoolContract
  readonly store: SandboxStore["Service"]
  readonly runLog: RunLog["Service"]
}): Effect.Effect<SandboxHostReads> => {
  const poolIds = new Set(input.contract.accounts.map((account) => account.accountId))
  const currentStep = (accountId: Sandbox["accountId"], runId: RunId) =>
    input.runLog.forAccount(accountId, { limit: 20 }).pipe(
      Effect.map((page) => {
        const summary = page.runs.find((run) => run.runId === runId)
        return summary === undefined ? null : summary.current
      }),
      Effect.catchTag("UnknownRunCursor", (error) => Effect.die(error))
    )
  const card = Effect.fnUntraced(function*(sandbox: Sandbox, spendOf: (accountId: string) => SandboxCard["spend"]) {
    const label: SandboxCard["label"] = poolIds.has(sandbox.accountId) ? null : "left the pool"
    const state = sandbox.state
    switch (state._tag) {
      case "Available":
        return {
          accountId: sandbox.accountId,
          name: sandbox.name,
          label,
          spend: spendOf(sandbox.accountId),
          state: { _tag: "Available", lastResetAt: state.lastResetAt }
        } satisfies SandboxCard
      case "Leased":
        return {
          accountId: sandbox.accountId,
          name: sandbox.name,
          label,
          spend: spendOf(sandbox.accountId),
          state: { _tag: "Leased", holder: state.holder, startedAt: state.startedAt, endsAt: state.endsAt }
        } satisfies SandboxCard
      case "Cleaning":
        return {
          accountId: sandbox.accountId,
          name: sandbox.name,
          label,
          spend: spendOf(sandbox.accountId),
          state: {
            _tag: "Cleaning",
            runId: state.runId,
            step: yield* currentStep(sandbox.accountId, state.runId)
          }
        } satisfies SandboxCard
      case "Quarantined":
        return {
          accountId: sandbox.accountId,
          name: sandbox.name,
          label,
          spend: spendOf(sandbox.accountId),
          state: {
            _tag: "Quarantined",
            runId: state.runId,
            blocker: yield* servedBlocker(state.blocker),
            step: yield* currentStep(sandbox.accountId, state.runId)
          }
        } satisfies SandboxCard
    }
  })
  const overview = Effect.fn("SandboxHost.overview")(function*() {
    const records = yield* input.store.list
    const asOf = yield* input.store.sweepAt
    // Spend is extra: a reading that cannot be read leaves every card without one, never the pool unread.
    const readings = new Map<string, SpendReading>(
      (yield* input.store.spend.pipe(
        Effect.catchTag(
          "SandboxStoreUnavailable",
          (error) => Effect.logWarning("sandbox spend could not be read", error.detail).pipe(Effect.as([]))
        )
      )).map((reading) => [reading.accountId, reading])
    )
    const spendOf = (accountId: string): SandboxCard["spend"] => {
      const reading = readings.get(accountId)
      return reading === undefined ? null : { usd: reading.usd, asOf: reading.asOf }
    }
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    const sandboxes = (yield* Effect.forEach(records, (sandbox) => card(sandbox, spendOf))).sort((left, right) =>
      left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0
    )
    const stale = sweepIsStale(asOf, now)
    return {
      _tag: "Ready",
      sandboxes,
      badge: {
        quarantined: sandboxes.filter((item) => item.state._tag === "Quarantined").length,
        stale,
        partial: stale,
        asOf
      },
      spendLimits: input.contract.spend ?? null
    } satisfies SandboxesOverview
  })
  const attention = Effect.fn("SandboxHost.attention")(function*() {
    const records = yield* input.store.list
    const asOf = yield* input.store.sweepAt
    const rows: Array<SandboxAttention["rows"][number]> = []
    for (const sandbox of records) {
      const state = sandbox.state
      if (state._tag !== "Quarantined") continue
      rows.push({
        accountId: sandbox.accountId,
        since: DateTime.toEpochMillis(state.since),
        kind: isBudgetHoldFor(input.contract, state.blocker) ? "budget-hold" : "quarantined"
      })
    }
    return { asOf, rows }
  })
  const runs = Effect.fn("SandboxHost.runs")(function*(query: SandboxRunsQuery) {
    yield* input.store.get(query.id)
    const page = yield* input.runLog.forAccount(query.id, { limit: query.limit ?? 20, before: query.before })
    return {
      _tag: "Ready",
      accountId: query.id,
      runs: yield* Effect.forEach(page.runs, (summary) =>
        Effect.gen(function*() {
          return {
            runId: summary.runId,
            step: summary.current,
            blocker: summary.blocker === null ? null : yield* servedBlocker(summary.blocker),
            outcome: summary.outcome,
            reason: summary.reason,
            startedAt: summary.startedAt,
            endedAt: summary.endedAt,
            failedStep: summary.failedStep
          }
        })),
      next: page.next
    } satisfies SandboxRuns
  })
  const runLog = Effect.fn("SandboxHost.runLog")(function*(query: SandboxRunLogQuery) {
    yield* input.store.get(query.id)
    const entries = yield* input.runLog.entries(query.run)
    const start = entries.find((entry) => entry._tag === "Started")
    if (start?._tag !== "Started" || start.accountId !== query.id) {
      return yield* new RunNotFound({ runId: query.run })
    }
    const lines = runLogLines(entries)
    return {
      _tag: "Ready",
      accountId: query.id,
      runId: query.run,
      raw: failedLine(entries),
      lines: lines.slice(-runLogLimit),
      total: lines.length
    } satisfies SandboxRunLog
  })
  return Effect.succeed({
    overview: overview().pipe(Effect.catchTags(readFailure)),
    runs: (query) => runs(query).pipe(Effect.catchTags(readFailure)),
    runLog: (query) => runLog(query).pipe(Effect.catchTags(readFailure)),
    attention: attention()
  })
}
