import { Context, Effect, Layer, Ref, Schema } from "effect"
import { type Sandbox, SandboxState } from "./lease.js"
import type { PoolContract } from "./pool.js"
import type { SpendReading } from "./spend.js"

/**
 * A write was made from a version that is no longer current: someone else
 * moved the account first. `expected` is the version the write was made from,
 * `actual` the stored one. Re-read and apply the transition again.
 */
export class StaleVersion extends Schema.TaggedError<StaleVersion>()("StaleVersion", {
  accountId: Schema.String,
  expected: Schema.Int,
  actual: Schema.Int
}) {}

/** A write would change what account a record describes: its name differs from the stored one. */
export class RecordMismatch extends Schema.TaggedError<RecordMismatch>()("RecordMismatch", {
  accountId: Schema.String,
  stored: Schema.String,
  received: Schema.String
}) {}

/** The store itself could not be read or written, e.g. its database is unavailable. Nothing was written. */
export class SandboxStoreUnavailable extends Schema.TaggedError<SandboxStoreUnavailable>()("SandboxStoreUnavailable", {
  operation: Schema.Literals(["list", "get", "put", "sweep", "rename", "spend"]),
  detail: Schema.String
}) {}

/** The account has no stored sandbox: it is not in the pool. */
export class SandboxNotFound extends Schema.TaggedError<SandboxNotFound>()("SandboxNotFound", {
  accountId: Schema.String
}) {}

/**
 * The pool's stored records, one per account. Every transition bumps `version`
 * by one, so `put(next)` writes only when the stored record is still at
 * `next.version - 1`, the version the transition was computed from, and
 * describes the same account (`RecordMismatch` otherwise). `rename` is the explicit
 * name change: it keeps the version and state, and a name that already matches
 * changes nothing. A durable store fails with `SandboxStoreUnavailable` when it
 * cannot be reached; the memory store never does. `sweepAt` is the last successful
 * sweep's epoch milliseconds, or null until one is recorded. `spend` is the latest reading per
 * account, in account-id order; `recordSpend` replaces that account's reading.
 */
export interface SandboxStoreService {
  readonly list: Effect.Effect<ReadonlyArray<Sandbox>, SandboxStoreUnavailable>
  readonly get: (accountId: string) => Effect.Effect<Sandbox, SandboxNotFound | SandboxStoreUnavailable>
  readonly put: (
    next: Sandbox
  ) => Effect.Effect<Sandbox, StaleVersion | SandboxNotFound | RecordMismatch | SandboxStoreUnavailable>
  readonly rename: (
    accountId: string,
    name: Sandbox["name"]
  ) => Effect.Effect<Sandbox, SandboxNotFound | SandboxStoreUnavailable>
  readonly sweepAt: Effect.Effect<number | null, SandboxStoreUnavailable>
  readonly markSweep: (at: number) => Effect.Effect<void, SandboxStoreUnavailable>
  readonly spend: Effect.Effect<ReadonlyArray<SpendReading>, SandboxStoreUnavailable>
  readonly recordSpend: (reading: SpendReading) => Effect.Effect<void, SandboxStoreUnavailable>
}

export class SandboxStore extends Context.Service<SandboxStore, SandboxStoreService>()("SandboxPool/SandboxStore") {}

/** Every pool account as Available, never reset, at version 0: the store's first contents. */
export const seedPool = (contract: PoolContract): ReadonlyArray<Sandbox> =>
  contract.accounts.map(({ accountId, name }) => ({
    accountId,
    name,
    state: SandboxState.cases.Available.make({ lastResetAt: null }),
    version: 0
  }))

/** A fresh in-memory store seeded with `initial`, for tests and fixtures. Each run is its own store. */
export const makeMemorySandboxStore = (initial: ReadonlyArray<Sandbox>): Effect.Effect<SandboxStoreService> =>
  Effect.gen(function*() {
    const records = yield* Ref.make(
      new Map<string, Sandbox>(initial.map((sandbox): [string, Sandbox] => [sandbox.accountId, sandbox]))
    )
    const sweptAt = yield* Ref.make<number | null>(null)
    const readings = yield* Ref.make(new Map<string, SpendReading>())
    const get = (accountId: string) =>
      Ref.get(records).pipe(
        Effect.flatMap((map) => {
          const found = map.get(accountId)
          return found === undefined ? Effect.fail(new SandboxNotFound({ accountId })) : Effect.succeed(found)
        })
      )
    return SandboxStore.of({
      list: Ref.get(records).pipe(Effect.map((map) => [...map.values()])),
      get,
      put: (next) =>
        Ref.modify(
          records,
          (map): [Effect.Effect<Sandbox, StaleVersion | SandboxNotFound | RecordMismatch>, Map<string, Sandbox>] => {
            const current = map.get(next.accountId)
            if (current === undefined) return [Effect.fail(new SandboxNotFound({ accountId: next.accountId })), map]
            if (current.name !== next.name) {
              const mismatch = new RecordMismatch({
                accountId: next.accountId,
                stored: current.name,
                received: next.name
              })
              return [Effect.fail(mismatch), map]
            }
            if (current.version !== next.version - 1) {
              const stale = new StaleVersion({
                accountId: next.accountId,
                expected: next.version - 1,
                actual: current.version
              })
              return [Effect.fail(stale), map]
            }
            return [Effect.succeed(next), new Map(map).set(next.accountId, next)]
          }
        ).pipe(Effect.flatten),
      rename: (accountId, name) =>
        Ref.modify(
          records,
          (map): [Effect.Effect<Sandbox, SandboxNotFound>, Map<string, Sandbox>] => {
            const current = map.get(accountId)
            if (current === undefined) return [Effect.fail(new SandboxNotFound({ accountId })), map]
            if (current.name === name) return [Effect.succeed(current), map]
            const renamed = { ...current, name }
            return [Effect.succeed(renamed), new Map(map).set(accountId, renamed)]
          }
        ).pipe(Effect.flatten),
      sweepAt: Ref.get(sweptAt),
      markSweep: (at) => Ref.set(sweptAt, at),
      spend: Ref.get(readings).pipe(
        Effect.map((map) => [...map.values()].sort((a, b) => (a.accountId < b.accountId ? -1 : 1)))
      ),
      recordSpend: (reading) => Ref.update(readings, (map) => new Map(map).set(reading.accountId, reading))
    })
  })

/** `makeMemorySandboxStore` as a layer. */
export const memorySandboxStore = (initial: ReadonlyArray<Sandbox>): Layer.Layer<SandboxStore> =>
  Layer.effect(SandboxStore, makeMemorySandboxStore(initial))
