import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"

import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import type {
  AuthorizedPluginActionV1,
  PluginActionCancellationRequestV1,
  PluginActionReconciliationRequestV1,
  PluginSyncRequestV1
} from "../../src/domain/plugins/index.js"
import {
  PluginConflictFailure,
  type PluginFailure,
  PluginOutageFailure,
  PluginUnsupportedCapabilityFailure
} from "../../src/server/plugins/failures.js"
import { AuthorizedPluginExecutor } from "../../src/server/plugins/internal/AuthorizedPluginExecutor.js"
import { AuthorizedPluginExecutorMap } from "../../src/server/plugins/internal/AuthorizedPluginExecutorMap.js"
import {
  PluginRuntimeAuthority,
  PluginRuntimeAuthorityToken
} from "../../src/server/plugins/internal/PluginRuntimeAuthority.js"
import { PluginConnectionMapLive, PluginRuntimeMap } from "../../src/server/plugins/internal/PluginRuntimeMap.js"
import { PluginRuntimeRegistry } from "../../src/server/plugins/internal/PluginRuntimeRegistry.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import { PluginConnectionMap, type PluginRuntimeScope } from "../../src/server/plugins/PluginConnectionMap.js"

export type PluginContractFixture =
  | "healthy"
  | "authentication-failure"
  | "authorization-failure"
  | "rate-limit-failure"
  | "timeout-failure"
  | "malformed-response"
  | "connection-failure"
  | "cancellation-failure"
  | "ambiguous-execution"
  | "unsupported-execution"

export interface PluginContractRuntimeSnapshot {
  readonly providerMutations: number
  readonly runtimeAcquisitions: number
  readonly runtimeReleases: number
}

export interface PluginContractRuntime {
  readonly layer: Layer.Layer<PluginConnection | AuthorizedPluginExecutor, PluginFailure>
  readonly snapshot: Effect.Effect<PluginContractRuntimeSnapshot>
}

export interface PluginContractHarness {
  readonly makeRuntime: (
    fixture: PluginContractFixture,
    executionGate?: {
      readonly entered: Deferred.Deferred<void>
      readonly release: Deferred.Deferred<void>
    }
  ) => Effect.Effect<PluginContractRuntime, PluginFailure>
  readonly authorizedAction: (digest: string) => AuthorizedPluginActionV1
  readonly cancellationRequest: PluginActionCancellationRequestV1
  readonly reconciliationRequest: PluginActionReconciliationRequestV1
  readonly resumeSyncRequest: PluginSyncRequestV1
  readonly syncRequest: PluginSyncRequestV1
  readonly expectedSync: {
    readonly eventIds: ReadonlyArray<string>
    readonly checkpoints: ReadonlyArray<string>
    readonly resumedEventIds: ReadonlyArray<string>
  }
  readonly expectedDiscovery: {
    readonly accountId: string
    readonly workspaceId: string
    readonly endpointUrl: string
  }
}

/**
 * Host ingestion invariant exercised by the shared persistence integration:
 * every decoded page's events and `checkpointAfterPage` commit in one transaction;
 * a failed page leaves the previously accepted checkpoint unchanged and is replayable.
 */
export const PLUGIN_CHECKPOINT_ATOMICITY_CONTRACT: {
  readonly transactionUnit: "decoded-page-events-and-checkpoint"
  readonly failureBehavior: "retain-previous-checkpoint-and-replay-page"
} = {
  transactionUnit: "decoded-page-events-and-checkpoint",
  failureBehavior: "retain-previous-checkpoint-and-replay-page"
}

const WORKSPACE_A = Schema.decodeUnknownSync(WorkspaceId)("01912345-6789-7abc-8def-0123456789ab")
const WORKSPACE_B = Schema.decodeUnknownSync(WorkspaceId)("01912345-6789-7abc-9def-0123456789ab")
const CONNECTION_ID = Schema.decodeUnknownSync(PluginConnectionId)("01912345-6789-7abd-adef-0123456789ab")

const scope = (workspaceId: typeof WorkspaceId.Type): PluginRuntimeScope => ({
  workspaceId,
  pluginConnectionId: CONNECTION_ID
})

const provideRuntime = <A, E>(
  runtime: PluginContractRuntime,
  effect: Effect.Effect<A, E, PluginConnection | AuthorizedPluginExecutor>
) => effect.pipe(Effect.provide(runtime.layer), Effect.scoped)

const runAfterRetryWindow = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(effect)
    yield* TestClock.adjust("1 second")
    return yield* Fiber.join(fiber)
  })

/**
 * Shared behavioral contract for every first-party plugin adapter.
 * Future adapters supply only a deterministic transport harness.
 */
export const runPluginContractSuite = (name: string, harness: PluginContractHarness): void => {
  describe(`${name} plugin contract`, () => {
    it.effect("decodes safe provider account, workspace, resource, and endpoint discovery", () =>
      Effect.gen(function*() {
        const runtime = yield* harness.makeRuntime("healthy")
        const discovery = yield* provideRuntime(
          runtime,
          Effect.flatMap(PluginConnection, (connection) => connection.discover)
        )

        assert.strictEqual(discovery.account?.providerImmutableId, harness.expectedDiscovery.accountId)
        assert.strictEqual(discovery.workspace?.providerImmutableId, harness.expectedDiscovery.workspaceId)
        assert.isNull(discovery.resource)
        assert.strictEqual(discovery.endpoints[0]?.url.toString(), harness.expectedDiscovery.endpointUrl)
      }))

    it.effect("replays stable event identities and resumes after an accepted checkpoint", () =>
      Effect.gen(function*() {
        const runtime = yield* harness.makeRuntime("healthy")
        const replay = yield* provideRuntime(
          runtime,
          Effect.gen(function*() {
            const connection = yield* PluginConnection
            const first = yield* connection.sync(harness.syncRequest).pipe(Stream.runCollect)
            const repeated = yield* connection.sync(harness.syncRequest).pipe(Stream.runCollect)
            const resumed = yield* connection.sync(harness.resumeSyncRequest).pipe(Stream.runCollect)
            return { first, repeated, resumed }
          })
        )
        const firstIds = replay.first.flatMap((page) => page.events.map((event) => event.eventId))
        const repeatedIds = replay.repeated.flatMap((page) => page.events.map((event) => event.eventId))

        assert.deepStrictEqual(firstIds, harness.expectedSync.eventIds)
        assert.deepStrictEqual(repeatedIds, firstIds)
        assert.deepStrictEqual(
          replay.first.map((page) => page.checkpointAfterPage),
          harness.expectedSync.checkpoints
        )
        assert.deepStrictEqual(
          replay.resumed.flatMap((page) => page.events.map((event) => event.eventId)),
          harness.expectedSync.resumedEventIds
        )
      }))

    it.effect("isolates an independently failing connection", () =>
      Effect.gen(function*() {
        const healthy = yield* harness.makeRuntime("healthy")
        const failing = yield* harness.makeRuntime("connection-failure")
        const failingResult = yield* runAfterRetryWindow(
          provideRuntime(
            failing,
            Effect.flatMap(PluginConnection, (connection) => connection.health)
          )
        ).pipe(Effect.result)
        const healthyResult = yield* provideRuntime(
          healthy,
          Effect.flatMap(PluginConnection, (connection) => connection.health)
        )

        assert.isTrue(Result.isFailure(failingResult))
        if (Result.isFailure(failingResult)) {
          assert.instanceOf(failingResult.failure, PluginOutageFailure)
        }
        assert.strictEqual(healthyResult._tag, "healthy")
      }))

    it.effect("maps common provider failures into the closed typed taxonomy", () =>
      Effect.gen(function*() {
        const fixtures: ReadonlyArray<readonly [PluginContractFixture, string]> = [
          ["authentication-failure", "PluginAuthenticationFailure"],
          ["authorization-failure", "PluginAuthorizationFailure"],
          ["rate-limit-failure", "PluginRateLimitFailure"],
          ["timeout-failure", "PluginTimeoutFailure"],
          ["malformed-response", "PluginMalformedResponseFailure"],
          ["connection-failure", "PluginOutageFailure"],
          ["cancellation-failure", "PluginCancellationFailure"]
        ]

        for (const [fixture, expectedTag] of fixtures) {
          const runtime = yield* harness.makeRuntime(fixture)
          const outcome = yield* runAfterRetryWindow(
            provideRuntime(
              runtime,
              Effect.flatMap(PluginConnection, (connection) => connection.health)
            )
          ).pipe(Effect.result)
          assert.isTrue(Result.isFailure(outcome))
          if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, expectedTag)
        }
      }))

    it.effect("interrupts a gated in-flight mutation without recording a dispatch", () =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const runtime = yield* harness.makeRuntime("healthy", { entered, release })
        const request = harness.authorizedAction("0".repeat(64))
        const exit = yield* Effect.gen(function*() {
          const executor = yield* AuthorizedPluginExecutor
          const fiber = yield* executor.executeAuthorizedAction(request).pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }).pipe(Effect.provide(runtime.layer), Effect.scoped)
        const snapshot = yield* runtime.snapshot

        assert.isTrue(Exit.isFailure(exit))
        if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
        assert.strictEqual(snapshot.providerMutations, 0)
      }))

    it.effect("negotiates execution and enforces exact-once dispatch", () =>
      Effect.gen(function*() {
        const runtime = yield* harness.makeRuntime("healthy")
        const request = harness.authorizedAction("0".repeat(64))
        const changed = harness.authorizedAction("1".repeat(64))
        const results = yield* provideRuntime(
          runtime,
          Effect.gen(function*() {
            const executor = yield* AuthorizedPluginExecutor
            const first = yield* executor.executeAuthorizedAction(request)
            const repeated = yield* executor.executeAuthorizedAction(request)
            const conflict = yield* executor.executeAuthorizedAction(changed).pipe(Effect.result)
            return { first, repeated, conflict }
          })
        )
        const snapshot = yield* runtime.snapshot

        assert.deepStrictEqual(results.repeated, results.first)
        assert.isTrue(Result.isFailure(results.conflict))
        if (Result.isFailure(results.conflict)) {
          assert.instanceOf(results.conflict.failure, PluginConflictFailure)
        }
        assert.strictEqual(snapshot.providerMutations, 1)
      }))

    it.effect("runs final preflight and requests provider cancellation", () =>
      Effect.gen(function*() {
        const runtime = yield* harness.makeRuntime("healthy")
        const results = yield* provideRuntime(
          runtime,
          Effect.gen(function*() {
            const executor = yield* AuthorizedPluginExecutor
            const preflight = yield* executor.preflight(harness.authorizedAction("0".repeat(64)))
            const cancellation = yield* executor.requestCancellation(harness.cancellationRequest)
            return { preflight, cancellation }
          })
        )

        assert.strictEqual(results.preflight._tag, "ready")
        assert.strictEqual(results.cancellation._tag, "cancelled")
      }))

    it.effect("rejects execution when its capability was not negotiated", () =>
      Effect.gen(function*() {
        const runtime = yield* harness.makeRuntime("unsupported-execution")
        const outcome = yield* provideRuntime(
          runtime,
          Effect.flatMap(AuthorizedPluginExecutor, (executor) =>
            executor.executeAuthorizedAction(harness.authorizedAction("0".repeat(64))))
        ).pipe(Effect.result)
        const snapshot = yield* runtime.snapshot

        assert.isTrue(Result.isFailure(outcome))
        if (Result.isFailure(outcome)) {
          assert.instanceOf(outcome.failure, PluginUnsupportedCapabilityFailure)
        }
        assert.strictEqual(snapshot.providerMutations, 0)
      }))

    it.effect("reconciles an ambiguous dispatch without redispatching", () =>
      Effect.gen(function*() {
        const runtime = yield* harness.makeRuntime("ambiguous-execution")
        const request = harness.authorizedAction("0".repeat(64))
        const results = yield* provideRuntime(
          runtime,
          Effect.gen(function*() {
            const executor = yield* AuthorizedPluginExecutor
            const dispatched = yield* executor.executeAuthorizedAction(request)
            const repeated = yield* executor.executeAuthorizedAction(request)
            const pending = yield* executor.reconcile(harness.reconciliationRequest)
            const succeeded = yield* executor.reconcile(harness.reconciliationRequest)
            return { dispatched, repeated, pending, succeeded }
          })
        )
        const snapshot = yield* runtime.snapshot

        assert.strictEqual(results.dispatched._tag, "unknown")
        assert.deepStrictEqual(results.repeated, results.dispatched)
        assert.strictEqual(results.pending._tag, "pending")
        assert.strictEqual(results.succeeded._tag, "succeeded")
        assert.strictEqual(snapshot.providerMutations, 1)
      }))

    it.effect("reuses, isolates, projects, and finalizes workspace-scoped runtimes", () =>
      Effect.gen(function*() {
        const runtimeA = yield* harness.makeRuntime("healthy")
        const runtimeB = yield* harness.makeRuntime("healthy")
        const scopeA = scope(WORKSPACE_A)
        const equalScopeA = scope(WORKSPACE_A)
        const scopeB = scope(WORKSPACE_B)
        const authorityA = PluginRuntimeAuthorityToken.make(`sha256:${"a".repeat(64)}`)
        const authorityB = PluginRuntimeAuthorityToken.make(`sha256:${"b".repeat(64)}`)
        const registry = Layer.succeed(PluginRuntimeRegistry, {
          layer: (key) =>
            Layer.merge(
              key.workspaceId === WORKSPACE_A ? runtimeA.layer : runtimeB.layer,
              Layer.succeed(
                PluginRuntimeAuthority,
                key.workspaceId === WORKSPACE_A ? authorityA : authorityB
              )
            )
        })
        const runtimeMap = PluginRuntimeMap.layer.pipe(Layer.provide(registry))
        const projections = Layer.merge(PluginConnectionMapLive, AuthorizedPluginExecutorMap.layer).pipe(
          Layer.provide(runtimeMap)
        )

        yield* Effect.gen(function*() {
          const connections = yield* PluginConnectionMap
          const executors = yield* AuthorizedPluginExecutorMap
          const contextA = yield* Effect.scoped(connections.contextEffect(scopeA))
          const equalContextA = yield* Effect.scoped(connections.contextEffect(equalScopeA))
          const executorLease = yield* Effect.scoped(
            executors.contextEffectForAuthority(equalScopeA, authorityA)
          )
          const unavailable = yield* Effect.scoped(
            executors.contextEffectForAuthority(
              equalScopeA,
              PluginRuntimeAuthorityToken.make(`sha256:${"c".repeat(64)}`)
            )
          ).pipe(Effect.flip)
          const contextB = yield* Effect.scoped(connections.contextEffect(scopeB))

          assert.strictEqual(Context.get(contextA, PluginConnection), Context.get(equalContextA, PluginConnection))
          assert.notStrictEqual(Context.get(contextA, PluginConnection), Context.get(contextB, PluginConnection))
          assert.isTrue(Option.isNone(Context.getOption(contextA, AuthorizedPluginExecutor)))
          assert.strictEqual(executorLease.runtimeAuthorityToken, authorityA)
          assert.strictEqual(unavailable._tag, "PluginRuntimeAuthorityUnavailable")

          const beforeA = yield* runtimeA.snapshot
          const beforeB = yield* runtimeB.snapshot
          assert.strictEqual(beforeA.runtimeAcquisitions, 1)
          assert.strictEqual(beforeB.runtimeAcquisitions, 1)

          yield* connections.invalidate(scopeA)
          yield* connections.invalidate(scopeB)
        }).pipe(Effect.provide(projections), Effect.scoped)

        const afterA = yield* runtimeA.snapshot
        const afterB = yield* runtimeB.snapshot
        assert.strictEqual(afterA.runtimeReleases, 1)
        assert.strictEqual(afterB.runtimeReleases, 1)
      }))
  })
}
