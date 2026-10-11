import * as Effect from "effect/Effect"
import * as RateLimiter from "effect/persistence/RateLimiter"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"

import type { CreatePluginConnectionResponse, PluginSynchronizationState } from "../../api/plugins.js"
import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import { ServerLifecycle } from "../runtime/ServerLifecycle.js"
import type { PluginAdministration } from "./ApplicationServices.js"
import { consumeRequestToken, RequestLimitPolicy } from "./RequestLimits.js"

/** Server-owned first sync: creation succeeds while admission waits, with a visible queued state. */
export const makeFirstSyncOnboarding = Effect.fn("FirstSyncOnboarding.make")(function*(
  plugins: PluginAdministration["Service"]
) {
  const scope = yield* Scope.Scope
  const lifecycle = yield* ServerLifecycle
  const limiter = yield* RateLimiter.RateLimiter
  const policy = yield* RequestLimitPolicy
  const pending = yield* Ref.make<ReadonlySet<string>>(new Set())
  const key = (workspaceId: WorkspaceId, pluginConnectionId: PluginConnectionId) =>
    `${workspaceId}:${pluginConnectionId}`

  const enqueue = Effect.fn("FirstSyncOnboarding.enqueue")(function*(
    workspaceId: WorkspaceId,
    response: CreatePluginConnectionResponse
  ) {
    const { connection, test } = response
    const synchronize = plugins.synchronizeConnection
    const readState = plugins.synchronization
    if (test._tag !== "healthy" || !connection.isEnabled || !connection.supportsSynchronization) return
    if (synchronize === undefined || readState === undefined) {
      yield* Effect.logError("First sync unavailable for a connection advertising synchronization")
      return
    }
    const input = { workspaceId, pluginConnectionId: connection.pluginConnectionId }
    const identity = key(workspaceId, input.pluginConnectionId)
    yield* Ref.update(pending, (current) => new Set(current).add(identity))
    const waitForAdmission = consumeRequestToken("sync-onboarding", workspaceId, "delay").pipe(
      Effect.provideService(RateLimiter.RateLimiter, limiter),
      Effect.provideService(RequestLimitPolicy, policy),
      // Drain cancels queued work; an already admitted durable sync finishes under runBackground.
      Effect.raceFirst(lifecycle.awaitDrain.pipe(Effect.andThen(Effect.interrupt)))
    )
    const job = lifecycle.runBackground(Effect.gen(function*() {
      yield* waitForAdmission
      const current = yield* readState(input)
      // A manual sync may have completed while onboarding was queued. Do not repeat it.
      if (current.result === "never") yield* synchronize(input)
    })).pipe(
      Effect.catch((failure) => Effect.logError("First sync failed", failure)),
      Effect.ensuring(Ref.update(pending, (current) => {
        const next = new Set(current)
        next.delete(identity)
        return next
      }))
    )
    yield* Effect.forkIn(job, scope, { startImmediately: true })
  })

  const present = Effect.fn("FirstSyncOnboarding.present")(function*(
    workspaceId: WorkspaceId,
    state: PluginSynchronizationState
  ): Effect.fn.Return<PluginSynchronizationState> {
    const queued = yield* Ref.get(pending)
    return state.result === "never" && queued.has(key(workspaceId, state.pluginConnectionId))
      ? { ...state, result: "queued" }
      : state
  })
  return { enqueue, present }
})
