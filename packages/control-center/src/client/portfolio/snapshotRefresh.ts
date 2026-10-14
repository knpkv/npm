import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"

import type { EventCursor } from "../../domain/identifiers.js"

/** Consume live frames while one supervised worker retains only pending cursors its response has not covered. */
export const withSnapshotRefresh = Effect.fn("PortfolioSnapshotRefresh.run")(function*<
  A extends { readonly eventCursor: EventCursor },
  E,
  R,
  B,
  E2,
  R2
>(
  load: (cursor: EventCursor) => Effect.Effect<A, E, R>,
  apply: (snapshot: A) => Effect.Effect<void>,
  consume: (controls: {
    readonly request: (cursor: EventCursor) => Effect.Effect<void, never, R>
    readonly drain: Effect.Effect<void>
    readonly reset: Effect.Effect<void>
  }) => Effect.Effect<B, E2, R2>
): Effect.fn.Return<B, E | E2, R | R2> {
  const failure = yield* Deferred.make<never, E>()
  let generation = 0
  let busy = false
  let pending: EventCursor | null = null
  let active: Fiber.Fiber<void> | null = null
  const request = Effect.fn("PortfolioSnapshotRefresh.request")(function*(cursor: EventCursor) {
    if (busy) {
      pending = pending === null || cursor > pending ? cursor : pending
      return
    }
    busy = true
    const startedGeneration = generation
    const worker = Effect.gen(function*() {
      let minimum: EventCursor | null = cursor
      while (minimum !== null) {
        const outcome: Exit.Exit<A, E> = yield* Effect.exit(load(minimum))
        if (startedGeneration !== generation) return
        if (Exit.isFailure(outcome)) {
          yield* Deferred.failCause(failure, outcome.cause)
          return
        }
        yield* apply(outcome.value)
        minimum = pending !== null && pending > outcome.value.eventCursor ? pending : null
        pending = null
      }
    }).pipe(
      Effect.onExit((outcome) =>
        startedGeneration === generation && Exit.isFailure(outcome)
          ? Deferred.failCause(failure, outcome.cause).pipe(Effect.asVoid)
          : Effect.void
      ),
      Effect.ensuring(Effect.sync(() => {
        if (startedGeneration !== generation) return
        busy = false
        active = null
      }))
    )
    const fiber = yield* worker.pipe(Effect.forkChild({ startImmediately: true }))
    active = busy ? fiber : null
  })
  return yield* Effect.raceFirst(
    consume({
      request,
      // Normal EOF drains accepted work; failing or interrupting the owner still cancels it immediately.
      drain: Effect.suspend(() => active === null ? Effect.void : Fiber.join(active)),
      reset: Effect.gen(function*() {
        generation++
        pending = null
        busy = false
        const fiber = active
        active = null
        if (fiber !== null) yield* Fiber.interrupt(fiber)
      })
    }),
    Deferred.await(failure)
  )
})
