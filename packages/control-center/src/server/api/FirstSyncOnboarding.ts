import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as RateLimiter from "effect/persistence/RateLimiter"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"

import type {
  CreatePluginConnectionResponse,
  PluginConnectionSummary,
  PluginSynchronizationState
} from "../../api/plugins.js"
import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import { ControlCenterBootstrap } from "../runtime/Bootstrap.js"
import { superviseBackgroundWorker } from "../runtime/internal/superviseAgentJobWorker.js"
import { ServerLifecycle } from "../runtime/ServerLifecycle.js"
import type { PluginAdministration } from "./ApplicationServices.js"
import { consumeRequestToken, RequestLimitPolicy } from "./RequestLimits.js"

/** Server-owned first sync: creation succeeds while admission waits, with a visible queued state. */
export const makeFirstSyncOnboarding = Effect.fn("FirstSyncOnboarding.make")(function*(
  plugins: PluginAdministration["Service"]
) {
  const bootstrap = yield* ControlCenterBootstrap
  const scope = yield* Scope.Scope
  const lifecycle = yield* ServerLifecycle
  const limiter = yield* RateLimiter.RateLimiter
  const policy = yield* RequestLimitPolicy
  const pending = yield* Ref.make<ReadonlySet<string>>(new Set())
  const key = (workspaceId: WorkspaceId, pluginConnectionId: PluginConnectionId) =>
    `${workspaceId}:${pluginConnectionId}`

  const enqueueConnection = Effect.fn("FirstSyncOnboarding.enqueueConnection")(function*(
    workspaceId: WorkspaceId,
    connection: PluginConnectionSummary
  ) {
    const synchronize = plugins.synchronizeConnection
    const readState = plugins.synchronization
    if (!connection.isEnabled || !connection.supportsSynchronization) return
    if (synchronize === undefined || readState === undefined) {
      yield* Effect.logError("First sync unavailable for a connection advertising synchronization")
      return
    }
    const input = { workspaceId, pluginConnectionId: connection.pluginConnectionId }
    const identity = key(workspaceId, input.pluginConnectionId)
    const added = yield* Ref.modify(
      pending,
      (current) => current.has(identity) ? [false, current] : [true, new Set(current).add(identity)]
    )
    if (!added) return
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

  const enqueue = Effect.fn("FirstSyncOnboarding.enqueue")(function*(
    workspaceId: WorkspaceId,
    response: CreatePluginConnectionResponse
  ) {
    if (response.test._tag === "healthy") yield* enqueueConnection(workspaceId, response.connection)
  })

  if (bootstrap._tag !== "disabled") {
    // Re-derive interrupted first syncs from durable outcomes; successful scans sleep until drain.
    yield* superviseBackgroundWorker({
      failurePollInterval: Duration.seconds(5),
      lifecycle,
      logLabel: "First sync recovery",
      cycle: Effect.gen(function*() {
        const readState = plugins.synchronization
        if (readState === undefined || plugins.synchronizeConnection === undefined) return Duration.infinity
        const connections = yield* plugins.list(bootstrap.workspaceId)
        for (const connection of connections) {
          if (!connection.isEnabled || !connection.supportsSynchronization) continue
          const state = yield* readState({
            workspaceId: bootstrap.workspaceId,
            pluginConnectionId: connection.pluginConnectionId
          })
          if (state.result === "never") yield* enqueueConnection(bootstrap.workspaceId, connection)
        }
        return Duration.infinity
      })
    })
  }

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
