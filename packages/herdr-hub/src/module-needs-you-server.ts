import { Cause, Effect, Exit, Option, Result, Schema } from "effect"
import {
  type NeedsYouItem,
  NeedsYouProviderResult,
  type NeedsYouResult,
  type NeedsYouSource
} from "./module-needs-you.js"

export interface NeedsYouProvider {
  readonly id: string
  readonly read: Effect.Effect<NeedsYouProviderResult>
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
        if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause)
        yield* Effect.logError("Needs-you provider failed", result.cause).pipe(
          Effect.annotateLogs("module", provider.id)
        )
        return {
          items: [],
          sources: [{
            provider: provider.id,
            issue: {
              state: "failed",
              reason: "internal"
            }
          }]
        } satisfies { readonly items: ReadonlyArray<NeedsYouItem>; readonly sources: ReadonlyArray<NeedsYouSource> }
      }
      if (Option.isNone(result.value)) {
        return {
          items: [],
          sources: [{
            provider: provider.id,
            issue: {
              state: "failed",
              reason: "timeout"
            }
          }]
        } satisfies { readonly items: ReadonlyArray<NeedsYouItem>; readonly sources: ReadonlyArray<NeedsYouSource> }
      }
      const decoded = Schema.decodeUnknownResult(NeedsYouProviderResult, { onExcessProperty: "error" })(
        result.value.value
      )
      if (Result.isFailure(decoded) || decoded.success.items.some((item) => item.destination.module !== provider.id)) {
        return {
          items: [],
          sources: [{
            provider: provider.id,
            issue: {
              state: "failed",
              reason: "invalid_response"
            }
          }]
        } satisfies { readonly items: ReadonlyArray<NeedsYouItem>; readonly sources: ReadonlyArray<NeedsYouSource> }
      }
      return {
        items: decoded.success.items.map(({ sourceKey, ...item }) => ({
          ...item,
          provider: provider.id,
          key: `${provider.id}:${sourceKey}`
        })),
        sources: decoded.success.issues.map((issue) => ({ provider: provider.id, issue }))
      }
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
  return sources.length === 0 ? { _tag: "Complete", items: bounded } : { _tag: "Partial", items: bounded, sources }
})
