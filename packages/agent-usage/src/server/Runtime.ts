/**
 * The long-running half of `agent-usage serve`: an ingest pass every minute, a ticket-title refresh
 * on its own minute schedule, and a Claude limit poll every five minutes, all feeding the store the
 * API reads.
 *
 * **Mental model**
 *
 * - **Polling, not watching.** Byte cursors make a pass over unchanged files cheap, so a fixed
 *   interval is simpler and as current as the graphs need; no filesystem watchers.
 * - **A failed pass is a status, not a crash.** It is recorded for the status strip and the next
 *   interval tries again; the server keeps serving what the store already holds.
 * - **Ingest Status lives in memory.** Cursors are the only persisted ingest state; a restart
 *   recomputes the status on its first pass.
 *
 * @module
 */
import type { FileSystem, Path } from "effect"
import { Clock, Context, Duration, Effect, Layer, Schedule, SubscriptionRef } from "effect"
import { attribute, knownProjects } from "../core/Attribution.js"
import { type ClaudeUsageDeps, pollClaudeLimits } from "../core/ClaudeLimits.js"
import { ingestOnce, type SourceRoots } from "../core/Ingest.js"
import { UsageStore } from "../core/Store.js"
import { refreshTicketTitles, type TicketSearch } from "../core/Tickets.js"
import type { ServerStatus } from "../shared/contracts.js"

export const INGEST_INTERVAL = Duration.seconds(60)
export const CLAUDE_POLL_INTERVAL = Duration.minutes(5)
/** How far back ticket titles are kept fresh. */
const TITLE_HORIZON_MILLIS = 90 * 24 * 60 * 60 * 1000

export class RuntimeState extends Context.Service<RuntimeState, {
  readonly machine: string
  /** Known Projects from configuration. */
  readonly projects: ReadonlyArray<string>
  /** The status the page shows; a SubscriptionRef so its changes can be followed. */
  readonly status: SubscriptionRef.SubscriptionRef<ServerStatus>
}>()("@knpkv/agent-usage/server/Runtime/RuntimeState") {
  static readonly layer = (machine: string, projects: ReadonlyArray<string> = []) =>
    Layer.effect(
      RuntimeState,
      Effect.map(
        SubscriptionRef.make<ServerStatus>({
          machine,
          ingest: null,
          ingestFailure: null,
          limitsFailure: null,
          ticketLookupFailures: []
        }),
        (status) => RuntimeState.of({ machine, projects, status })
      )
    )
}

/** The Known Projects now: those the store's branches and paths name, plus the configured ones. */
export const currentKnownProjects = Effect.gen(function*() {
  const store = yield* UsageStore
  const state = yield* RuntimeState
  return knownProjects(yield* store.places(state.machine), state.projects)
})

export interface BackgroundOptions {
  readonly roots: SourceRoots
  readonly claude: ClaudeUsageDeps
  readonly ticketSearch: TicketSearch
}

/** Ticket keys booked in the recent past, whose titles the page will ask for. */
const recentTicketKeys = Effect.gen(function*() {
  const store = yield* UsageStore
  const now = yield* Clock.currentTimeMillis
  const state = yield* RuntimeState
  const groups = yield* store.usageGroups({ from: now - TITLE_HORIZON_MILLIS, to: now + 1, machine: state.machine })
  const projects = yield* currentKnownProjects
  const keys = new Set<string>()
  for (const group of groups) {
    const { booking } = attribute(group.attribution, projects)
    if (booking._tag === "Ticket") keys.add(booking.key)
  }
  return [...keys]
})

/** One ingest pass, its outcome written to the status. */
export const ingestCycle = (options: BackgroundOptions) =>
  Effect.gen(function*() {
    const state = yield* RuntimeState
    const outcome = yield* Effect.result(ingestOnce(options.roots))
    if (outcome._tag === "Failure") {
      yield* SubscriptionRef.update(state.status, (status) => ({
        ...status,
        ingestFailure: `${outcome.failure.operation}: the store could not be written`
      }))
      return
    }
    yield* SubscriptionRef.update(
      state.status,
      (status) => ({ ...status, ingest: outcome.success, ingestFailure: null })
    )
  })

/**
 * One title refresh for the tickets booked recently. It runs on its own schedule: a slow or hung
 * `acli` delays titles, never the next ingest pass.
 */
export const titleCycle = (options: BackgroundOptions) =>
  Effect.gen(function*() {
    const state = yield* RuntimeState
    const failures = yield* recentTicketKeys.pipe(
      Effect.flatMap((keys) => refreshTicketTitles(keys, options.ticketSearch)),
      Effect.map((lookups) => lookups.map((failure) => failure.reason)),
      Effect.catchTag("StoreError", (error) => Effect.succeed([`ticket titles: ${error.operation} failed`]))
    )
    yield* SubscriptionRef.update(
      state.status,
      (status) => ({ ...status, ticketLookupFailures: [...new Set(failures)] })
    )
  })

/**
 * One Claude limit poll, recorded. Failing to store it is reported apart from ingest, so a good
 * ingest pass cannot clear it; the next stored poll does.
 */
export const claudePollCycle = (options: BackgroundOptions) =>
  Effect.gen(function*() {
    const state = yield* RuntimeState
    const store = yield* UsageStore
    const observations = yield* pollClaudeLimits(options.claude, state.machine)
    const stored = yield* Effect.result(store.recordObservations(observations.snapshots, observations.balances))
    yield* SubscriptionRef.update(state.status, (status) => ({
      ...status,
      limitsFailure: stored._tag === "Failure"
        ? `${stored.failure.operation}: Claude limits could not be stored`
        : null
    }))
  })

/** Runs both cycles on their intervals for the life of the layer's scope. */
export const backgroundLayer = (
  options: BackgroundOptions
): Layer.Layer<never, never, RuntimeState | UsageStore | FileSystem.FileSystem | Path.Path> =>
  Layer.effectDiscard(Effect.gen(function*() {
    yield* Effect.forkScoped(Effect.repeat(ingestCycle(options), Schedule.spaced(INGEST_INTERVAL)))
    yield* Effect.forkScoped(Effect.repeat(titleCycle(options), Schedule.spaced(INGEST_INTERVAL)))
    yield* Effect.forkScoped(Effect.repeat(claudePollCycle(options), Schedule.spaced(CLAUDE_POLL_INTERVAL)))
  }))
