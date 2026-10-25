import { Cause, Effect, Exit, Option, Result, Schema } from "effect"
import {
  type NeedsYouContribution,
  type NeedsYouFailure,
  type NeedsYouItem,
  NeedsYouProviderResult,
  type NeedsYouResult,
  type NeedsYouSource
} from "./module-needs-you.js"

interface Reading {
  readonly provider: NeedsYouContribution["provider"]
  readonly asOf: NeedsYouContribution["asOf"]
  readonly lastDecisionAt?: number | null | undefined
  readonly items: ReadonlyArray<NeedsYouItem>
  readonly failures: ReadonlyArray<NeedsYouFailure>
  readonly sources: ReadonlyArray<NeedsYouSource>
}

export interface NeedsYouProvider {
  readonly id: string
  readonly pages: ReadonlyArray<string>
  /** Decoded here: an app's reading arrives as JSON from its own process. */
  readonly read: Effect.Effect<unknown, unknown>
}

/**
 * Providers close their service requirements at startup. Keep the whole earliest-created row
 * for duplicate opaque keys; sort expiry ascending, null last, then creation time and key.
 */
export const collectNeedsYou = Effect.fn("ModuleRegistry.collectNeedsYou")(function*(
  providers: ReadonlyArray<NeedsYouProvider>
): Effect.fn.Return<NeedsYouResult> {
  const readings = yield* Effect.forEach(
    providers,
    Effect.fnUntraced(function*(provider) {
      const result = yield* Effect.exit(provider.read.pipe(Effect.timeoutOption("4 seconds")))
      if (Exit.isFailure(result)) {
        if (Cause.hasInterrupts(result.cause)) {
          const [fiberId] = Cause.interruptors(result.cause)
          return yield* Effect.failCause(Cause.interrupt(fiberId))
        }
        yield* Effect.logError("Needs-you provider failed", result.cause).pipe(
          Effect.annotateLogs("module", provider.id)
        )
        return {
          provider: provider.id,
          asOf: null,
          items: [],
          failures: [],
          sources: [{
            provider: provider.id,
            issue: {
              state: "failed",
              reason: "internal"
            }
          }]
        } satisfies Reading
      }
      if (Option.isNone(result.value)) {
        return {
          provider: provider.id,
          asOf: null,
          items: [],
          failures: [],
          sources: [{
            provider: provider.id,
            issue: {
              state: "failed",
              reason: "timeout"
            }
          }]
        } satisfies Reading
      }
      const decoded = Schema.decodeUnknownResult(NeedsYouProviderResult, { onExcessProperty: "error" })(
        result.value.value
      )
      const invalidDestination = Result.isSuccess(decoded) &&
        decoded.success.items.some((item) =>
          item.destination.module !== provider.id ||
          (item.destination._tag === "ModulePage" && !provider.pages.includes(item.destination.page))
        )
      if (Result.isFailure(decoded) || invalidDestination) {
        return {
          provider: provider.id,
          asOf: null,
          items: [],
          failures: [],
          sources: [{
            provider: provider.id,
            issue: {
              state: "failed",
              reason: "invalid_response"
            }
          }]
        } satisfies Reading
      }
      return {
        provider: provider.id,
        asOf: decoded.success.asOf,
        lastDecisionAt: decoded.success.lastDecisionAt,
        items: decoded.success.items.map(({ sourceKey, ...item }) => ({
          ...item,
          provider: provider.id,
          key: `${provider.id}:${sourceKey}`
        })),
        failures: (decoded.success.failures ?? []).map(({ sourceKey, ...failure }) => ({
          ...failure,
          provider: provider.id,
          key: `${provider.id}:${sourceKey}`
        })),
        sources: decoded.success.issues.map((issue) => ({ provider: provider.id, issue }))
      } satisfies Reading
    }),
    { concurrency: 4 }
  )
  const unique = new Map<string, NeedsYouItem>()
  for (const item of readings.flatMap((reading) => reading.items)) {
    const previous = unique.get(item.key)
    if (previous === undefined || item.createdAt < previous.createdAt) unique.set(item.key, item)
  }
  const items = [...unique.values()].sort((a, b) => {
    if (a.expiresAt !== b.expiresAt) {
      if (a.expiresAt === null) return 1
      if (b.expiresAt === null) return -1
      return a.expiresAt - b.expiresAt
    }
    return a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  })
  const sources: Array<NeedsYouSource> = readings.flatMap((reading) => reading.sources)
  const counts = new Map<string, number>()
  const truncated = new Set<string>()
  const bounded: Array<NeedsYouItem> = []
  for (const item of items) {
    const count = counts.get(item.provider) ?? 0
    if (count < 256) {
      bounded.push(item)
      counts.set(item.provider, count + 1)
    } else {
      truncated.add(item.provider)
    }
  }
  for (const provider of truncated) {
    if (!sources.some((source) => source.provider === provider && source.issue.state === "truncated")) {
      sources.push({ provider, issue: { state: "truncated" } })
    }
  }
  const contributions = readings.map((reading): NeedsYouContribution =>
    reading.lastDecisionAt === undefined
      ? { provider: reading.provider, asOf: reading.asOf }
      : { provider: reading.provider, asOf: reading.asOf, lastDecisionAt: reading.lastDecisionAt }
  )
  // Keys are provider-scoped, so failures need no dedupe; newest first.
  const failures = readings.flatMap((reading) => reading.failures).sort((a, b) =>
    b.failedAt - a.failedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  )
  // Absent when empty, so a hub without failures answers exactly as before.
  const result: NeedsYouResult = sources.length === 0
    ? { _tag: "Complete", items: bounded, contributions }
    : { _tag: "Partial", items: bounded, sources, contributions }
  return failures.length === 0 ? result : { ...result, failures }
})
