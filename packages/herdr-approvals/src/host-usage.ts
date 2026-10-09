/**
 * This host's usage for the hub's Usage tab: hostd runs `agent-usage usage` for the asked range and
 * zone and serves its answer, refreshed in the background. Like limits, the command reads
 * agent-usage's own store over its owner-only control socket, and its answer holds tokens per agent
 * and model and the limit series only: agent-usage leaves cost, balances, Bookings and paths out at
 * the source.
 *
 * **The command.** It is the configured `agentUsageLimitsCommand` with its final `limits` word
 * replaced by `usage`, so a host set up for Connect's limits needs nothing new. A command that does
 * not end in `limits` (a wrapper script) has no usage, and says so.
 *
 * @module
 */
import {
  decodeUsageTolerantly,
  type HostUsage,
  RawUsage,
  type UsageQuery,
  usageReadingOf,
  usageResponseMaxBytes,
  usageUnavailable
} from "@knpkv/herdr-connect"
import { Clock, Duration, Effect, Result, Schema, Scope, Semaphore, SynchronizedRef } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { reportFailure } from "./agent-usage-failure.js"
import { runCommand, type StaleWhileRevalidate, staleWhileRevalidate } from "./host-limits.js"

// A 30-day read scans a month of the store; give it longer than limits' 10 seconds.
export const hostUsageTimeout = "20 seconds"

/** How long a read is served before it is refreshed in the background: usage is history, not a live gauge. */
export const hostUsageTtl = Duration.minutes(5)

/** At most this many range and zone pairs are cached; the oldest is dropped for a new one. */
export const hostUsageCacheEntries = 16

const decodeRawUsage = Schema.decodeUnknownResult(Schema.fromJsonString(RawUsage))

/** The `agent-usage usage` command for a configured limits command, or undefined when it has none. */
export const usageCommandFor = (
  limitsCommand: ReadonlyArray<string> | undefined
): readonly [string, ...Array<string>] | undefined => {
  const executable = limitsCommand?.[0]
  if (limitsCommand === undefined || executable === undefined || limitsCommand.length < 2) return undefined
  if (limitsCommand.at(-1) !== "limits") return undefined
  return [executable, ...limitsCommand.slice(1, -1), "usage"]
}

const readReading = (
  limitsCommand: ReadonlyArray<string> | undefined,
  query: UsageQuery
): Effect.Effect<HostUsage["reading"], never, ChildProcessSpawner.ChildProcessSpawner> => {
  const command = usageCommandFor(limitsCommand)
  if (command === undefined) {
    return Effect.succeed(
      usageUnavailable(
        "not_configured",
        limitsCommand === undefined
          ? "agentUsageLimitsCommand is not set for this host"
          : "agentUsageLimitsCommand does not end in `limits`, so this host has no `agent-usage usage`"
      )
    )
  }
  return runCommand([...command, "--range", query.range, "--time-zone", query.timeZone], usageResponseMaxBytes).pipe(
    Effect.timeoutOrElse({ duration: hostUsageTimeout, orElse: () => Effect.succeed(null) }),
    Effect.map((stdout): HostUsage["reading"] => {
      if (stdout === null) return usageUnavailable("timeout", `no answer within ${hostUsageTimeout}`)
      const json = decodeRawUsage(stdout.trim())
      if (Result.isFailure(json)) {
        return usageUnavailable("invalid_output", "agent-usage printed something that is not a JSON object")
      }
      return usageReadingOf(decodeUsageTolerantly(json.success))
    }),
    // agent-usage's own sentence can name host paths: it is logged here, and a fixed sentence leaves.
    Effect.catchTag(
      "CommandFailed",
      (failure) => Effect.map(reportFailure("Usage tab", failure), (sentence) => usageUnavailable("failed", sentence))
    )
  )
}

/**
 * Runs the usage command once for `query` and reports what it said. Never fails: no command, a
 * crash, a timeout, a newer format or output that is not agent-usage's each become `Unavailable`
 * with its own reason.
 */
export const readHostUsage = Effect.fn("HostUsage.read")(function*(
  host: string,
  limitsCommand: ReadonlyArray<string> | undefined,
  query: UsageQuery
) {
  const reading = yield* readReading(limitsCommand, query)
  return { host, readAt: yield* Clock.currentTimeMillis, reading } satisfies HostUsage
})

/** At most this many agent-usage reads run at once across every range and zone. */
export const hostUsageConcurrentReads = 2

/**
 * One {@link staleWhileRevalidate} per range and zone, at most {@link hostUsageCacheEntries} of
 * them: a new pair beyond that drops the least recently asked one. Finding or creating a pair's
 * entry is atomic, so concurrent first asks share one read; and at most
 * {@link hostUsageConcurrentReads} reads run at once, so a burst of new pairs queues rather than
 * starting a command each. Refreshes live in `scope`.
 */
export const usageCache = Effect.fn("HostUsage.cache")(function*(
  read: (query: UsageQuery) => Effect.Effect<HostUsage>,
  ttl: Duration.Duration = hostUsageTtl,
  entries: number = hostUsageCacheEntries
) {
  const scope: Scope.Scope = yield* Effect.scope
  const reads = yield* Semaphore.make(hostUsageConcurrentReads)
  const caches = yield* SynchronizedRef.make(new Map<string, StaleWhileRevalidate<HostUsage>>())
  const entryFor = (query: UsageQuery) =>
    SynchronizedRef.modifyEffect(caches, (current) =>
      Effect.gen(function*() {
        const key = `${query.range} ${query.timeZone}`
        const next = new Map(current)
        const known = next.get(key)
        // Re-inserted on every ask, so the Map's order is least recently asked first.
        next.delete(key)
        const cache = known ?? (yield* staleWhileRevalidate(reads.withPermits(1)(read(query)), ttl).pipe(
          Effect.provideService(Scope.Scope, scope)
        ))
        next.set(key, cache)
        while (next.size > entries) {
          const oldest = next.keys().next().value
          if (oldest === undefined) break
          next.delete(oldest)
        }
        const updated: readonly [StaleWhileRevalidate<HostUsage>, Map<string, StaleWhileRevalidate<HostUsage>>] = [
          cache,
          next
        ]
        return updated
      }))
  return (query: UsageQuery): Effect.Effect<HostUsage> => Effect.flatMap(entryFor(query), (cache) => cache.read)
})
