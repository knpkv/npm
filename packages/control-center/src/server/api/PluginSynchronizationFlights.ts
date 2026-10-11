import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"

import type { PluginSynchronizationState } from "../../api/plugins.js"
import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import { type ServerDraining, ServerLifecycle } from "../runtime/ServerLifecycle.js"
import type { ApplicationInvalidRequest, PluginAdministrationError } from "./ApplicationServices.js"
import type { RequestRateLimitExceeded, RequestRateLimitUnavailable } from "./RequestLimits.js"

interface SynchronizationIdentity {
  readonly workspaceId: WorkspaceId
  readonly pluginConnectionId: PluginConnectionId
}

type SynchronizationFailure =
  | ApplicationInvalidRequest
  | PluginAdministrationError
  | RequestRateLimitExceeded
  | RequestRateLimitUnavailable
  | ServerDraining

type SynchronizationWork = Effect.Effect<PluginSynchronizationState, SynchronizationFailure>

interface Flight {
  readonly kind: "onboarding" | "manual"
  readonly completion: Deferred.Deferred<PluginSynchronizationState, SynchronizationFailure>
}

/** Only active work is retained. Cache cancels its lookup when the last waiter leaves; these owners belong to the server scope. */
export const makePluginSynchronizationFlights = Effect.fn("PluginSynchronizationFlights.make")(function*() {
  const scope = yield* Scope.Scope
  const lifecycle = yield* ServerLifecycle
  const pending = yield* Ref.make<ReadonlyMap<string, Flight>>(new Map())
  const key = (input: SynchronizationIdentity) => `${input.workspaceId}:${input.pluginConnectionId}`

  const start = Effect.fn("PluginSynchronizationFlights.start")((
    input: SynchronizationIdentity,
    kind: Flight["kind"],
    work: SynchronizationWork
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        const identity = key(input)
        const flight: Flight = {
          kind,
          completion: yield* Deferred.make<PluginSynchronizationState, SynchronizationFailure>()
        }
        const existing = yield* Ref.modify(pending, (current): [Flight | undefined, ReadonlyMap<string, Flight>] => {
          const existing = current.get(identity)
          return existing === undefined ? [undefined, new Map(current).set(identity, flight)] : [existing, current]
        })
        if (existing !== undefined) return existing.completion
        const owner = restore(lifecycle.runBackground(work)).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function*() {
              yield* Ref.update(pending, (current) => {
                if (current.get(identity) !== flight) return current
                const next = new Map(current)
                next.delete(identity)
                return next
              })
              yield* Deferred.done(flight.completion, exit)
            })
          ),
          Effect.exit,
          Effect.asVoid
        )
        yield* Effect.forkIn(owner, scope, { startImmediately: true })
        return flight.completion
      })
    )
  )

  const enqueue = Effect.fn("PluginSynchronizationFlights.enqueue")(
    function*(input: SynchronizationIdentity, work: SynchronizationWork) {
      yield* start(input, "onboarding", work)
    }
  )
  const join = Effect.fn("PluginSynchronizationFlights.join")(
    function*(input: SynchronizationIdentity, work: SynchronizationWork) {
      return yield* Deferred.await(yield* start(input, "manual", work))
    }
  )
  const hasOnboarding = Effect.fn("PluginSynchronizationFlights.hasOnboarding")(
    function*(input: SynchronizationIdentity) {
      return (yield* Ref.get(pending)).get(key(input))?.kind === "onboarding"
    }
  )
  return { enqueue, join, hasOnboarding }
})
