import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"

import {
  AuthorizedPluginActionV1,
  DiffContentRangeRequestV1,
  PluginActionCancellationRequestV1,
  PluginActionReconciliationRequestV1,
  PluginSyncRequestV1
} from "../../src/domain/plugins/index.js"
import {
  PluginConflictFailure,
  PluginMalformedResponseFailure,
  PluginUnsupportedCapabilityFailure
} from "../../src/server/plugins/failures.js"
import { makeFakePluginRuntime } from "../../src/server/plugins/fake/FakePluginDefinition.js"
import { fakeReconciliationScriptKey, fakeSyncScriptKey } from "../../src/server/plugins/fake/FakePluginScenario.js"
import type { FakePluginResponse, FakePluginScenario } from "../../src/server/plugins/fake/FakePluginScenario.js"
import { AuthorizedPluginExecutor } from "../../src/server/plugins/internal/AuthorizedPluginExecutor.js"
import { pluginCapabilityCodecsV1 } from "../../src/server/plugins/PluginCapabilityCodecs.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import { buildPluginDefinitionLayer, definePluginV1 } from "../../src/server/plugins/PluginDefinition.js"
import { runPluginContractSuite } from "./plugin-contract-suite.js"

const OBSERVED_AT = "2026-07-13T10:00:00.000Z"
const RETRY_AT = "2026-07-13T10:00:30.000Z"

class PluginFactoryDependency extends Context.Service<PluginFactoryDependency, string>()(
  "@knpkv/control-center/test/PluginFactoryDependency"
) {}

const descriptor = (
  capabilities: ReadonlyArray<string> = [
    "entity.read",
    "sync.incremental",
    "action.propose",
    "action.execute",
    "action.cancel",
    "action.reconcile"
  ]
) =>
  ({
    contractId: "dev.knpkv.control-center.plugin",
    contractVersion: { major: 1, minor: 0, patch: 0 },
    pluginId: "dev.knpkv.fake",
    adapterVersion: { major: 0, minor: 1, patch: 0 },
    displayName: "Deterministic fake",
    configurationFields: [],
    capabilities: capabilities.map((capabilityId) => ({
      capabilityId,
      supportedVersions: [1],
      requirement: "required"
    }))
  }) satisfies unknown

const proposal = {
  proposalKey: "proposal-1",
  capabilityVersion: 1,
  payloadDigest: "0".repeat(64),
  request: {
    actionKind: "transition",
    target: { entityType: "issue", vendorImmutableId: "PAY-42" },
    expectedRevision: "7",
    payload: { status: "Done" },
    evidenceIds: ["evidence-1"]
  },
  summary: "Transition PAY-42",
  impact: { level: "medium", summary: "Changes workflow state" },
  proposedAt: OBSERVED_AT
}

const authorized = (digest: string) =>
  Schema.decodeUnknownSync(AuthorizedPluginActionV1)({
    proposal: { ...proposal, payloadDigest: digest },
    idempotencyKey: "action-1",
    payloadDigest: digest,
    authorizationId: "authorization-1",
    authorizedAt: OBSERVED_AT,
    expiresAt: "2026-07-13T10:05:00.000Z"
  })

const success = (value: unknown): FakePluginResponse => ({ _tag: "success", value })

const baseScenario = (overrides: Partial<FakePluginScenario> = {}): FakePluginScenario => ({
  descriptor: descriptor(),
  discover: success({
    account: {
      providerImmutableId: "account-1",
      displayName: "Acme Engineering"
    },
    workspace: {
      providerImmutableId: "workspace-1",
      displayName: "Payments"
    },
    endpoints: [
      {
        kind: "web",
        url: "https://provider.example/workspaces/payments",
        label: "Payments workspace"
      }
    ],
    discoveredAt: OBSERVED_AT
  }),
  health: success({ _tag: "healthy", checkedAt: OBSERVED_AT }),
  sync: {
    [fakeSyncScriptKey("entities", null)]: [
      success({
        events: [
          {
            _tag: "UpsertEntity",
            eventId: "event-1",
            observedAt: OBSERVED_AT,
            entityType: "issue",
            vendorImmutableId: "PAY-42",
            revision: "7",
            sourceUrl: null,
            title: "Ship payment retry",
            attributes: { status: "In progress" }
          }
        ],
        checkpointAfterPage: "checkpoint-1",
        hasMore: true
      }),
      success({
        events: [
          {
            _tag: "TombstoneEntity",
            eventId: "event-2",
            observedAt: OBSERVED_AT,
            entityType: "issue",
            vendorImmutableId: "PAY-41",
            revision: "8",
            reason: "Deleted upstream"
          }
        ],
        checkpointAfterPage: "checkpoint-2",
        hasMore: false
      })
    ],
    [fakeSyncScriptKey("entities", "checkpoint-1")]: [
      success({
        events: [
          {
            _tag: "TombstoneEntity",
            eventId: "event-2",
            observedAt: OBSERVED_AT,
            entityType: "issue",
            vendorImmutableId: "PAY-41",
            revision: "8",
            reason: "Deleted upstream"
          }
        ],
        checkpointAfterPage: "checkpoint-2",
        hasMore: false
      })
    ]
  },
  readEntity: success({
    _tag: "missing",
    reference: { entityType: "issue", vendorImmutableId: "PAY-404" },
    observedAt: OBSERVED_AT
  }),
  proposeAction: success(proposal),
  preflight: success({ _tag: "ready", checkedRevision: "7", checkedAt: OBSERVED_AT }),
  executeAuthorizedAction: success({
    _tag: "confirmed",
    receipt: {
      providerOperationId: "provider-operation-1",
      status: "succeeded",
      safeSummary: "Transition applied",
      observedAt: OBSERVED_AT
    }
  }),
  requestCancellation: success({
    _tag: "cancelled",
    receipt: {
      providerOperationId: "provider-operation-1",
      status: "cancelled",
      safeSummary: "Provider confirmed cancellation",
      observedAt: OBSERVED_AT
    }
  }),
  reconcile: {},
  ...overrides
})

const reconciliationRequest = Schema.decodeUnknownSync(PluginActionReconciliationRequestV1)({
  reconciliationKey: "reconcile-1",
  idempotencyKey: "action-1",
  payloadDigest: "0".repeat(64)
})
const idempotencyReconciliationRequest = Schema.decodeUnknownSync(PluginActionReconciliationRequestV1)({
  reconciliationKey: null,
  idempotencyKey: "action-1",
  payloadDigest: "0".repeat(64)
})
const cancellationRequest = Schema.decodeUnknownSync(PluginActionCancellationRequestV1)({
  idempotencyKey: "action-1",
  providerOperationId: "provider-operation-1",
  reconciliationKey: null
})
const syncRequest = Schema.decodeUnknownSync(PluginSyncRequestV1)({
  streamKey: "entities",
  checkpoint: null
})
const resumeSyncRequest = Schema.decodeUnknownSync(PluginSyncRequestV1)({
  streamKey: "entities",
  checkpoint: "checkpoint-1"
})

const healthFailure = (fixture: string): FakePluginResponse | undefined => {
  switch (fixture) {
    case "authentication-failure":
      return { _tag: "authentication" }
    case "authorization-failure":
      return { _tag: "authorization" }
    case "rate-limit-failure":
      return { _tag: "rate-limit", retryAt: RETRY_AT }
    case "timeout-failure":
      return { _tag: "timeout" }
    case "malformed-response":
      return { _tag: "malformed", diagnosticCode: "fixture-malformed" }
    case "connection-failure":
      return { _tag: "outage" }
    case "cancellation-failure":
      return { _tag: "cancellation" }
    default:
      return undefined
  }
}

runPluginContractSuite("FakePlugin", {
  authorizedAction: authorized,
  cancellationRequest,
  reconciliationRequest,
  resumeSyncRequest,
  syncRequest,
  expectedSync: {
    eventIds: ["event-1", "event-2"],
    checkpoints: ["checkpoint-1", "checkpoint-2"],
    resumedEventIds: ["event-2"]
  },
  expectedDiscovery: {
    accountId: "account-1",
    workspaceId: "workspace-1",
    endpointUrl: "https://provider.example/workspaces/payments"
  },
  makeRuntime: (fixture, executionGate) => {
    const ambiguousKey = fakeReconciliationScriptKey("reconcile-1", "action-1")
    const failure = healthFailure(fixture)
    const overrides: Partial<FakePluginScenario> = failure !== undefined
      ? { health: failure }
      : fixture === "unsupported-execution"
      ? { descriptor: descriptor(["sync.incremental", "entity.read", "action.propose"]) }
      : fixture === "ambiguous-execution"
      ? {
        executeAuthorizedAction: success({
          _tag: "unknown",
          reconciliationKey: "reconcile-1",
          safeSummary: "Provider outcome requires reconciliation",
          observedAt: OBSERVED_AT
        }),
        reconcile: {
          [ambiguousKey]: [
            success({ _tag: "pending", checkedAt: OBSERVED_AT }),
            success({
              _tag: "succeeded",
              receipt: {
                providerOperationId: "provider-operation-1",
                status: "succeeded",
                safeSummary: "Transition confirmed",
                observedAt: OBSERVED_AT
              }
            })
          ]
        }
      }
      : {}

    return makeFakePluginRuntime(
      baseScenario({
        ...overrides,
        ...(executionGate === undefined ? {} : { executeAuthorizedActionGate: executionGate })
      })
    ).pipe(
      Effect.map((runtime) => ({
        layer: runtime.layer,
        snapshot: runtime.probe.snapshot
      }))
    )
  }
})

const withRuntime = <A, E>(
  scenario: FakePluginScenario,
  use: Effect.Effect<A, E, PluginConnection | AuthorizedPluginExecutor>
) =>
  Effect.gen(function*() {
    const runtime = yield* makeFakePluginRuntime(scenario)
    const value = yield* use.pipe(Effect.provide(runtime.layer), Effect.scoped)
    return { runtime, value }
  })

describe("FakePlugin", () => {
  it.effect("constructs the adapter in Layer scope with required services", () =>
    Effect.gen(function*() {
      const runtime = yield* makeFakePluginRuntime(baseScenario())
      const services = yield* Effect.all({
        connection: PluginConnection,
        executor: AuthorizedPluginExecutor
      }).pipe(Effect.provide(runtime.layer), Effect.scoped)
      const acquisitions = yield* Ref.make(0)
      const releases = yield* Ref.make(0)
      const definition = definePluginV1({
        rawDescriptor: descriptor(),
        configurationSchema: Schema.Unknown,
        capabilityCodecs: pluginCapabilityCodecsV1,
        make: () =>
          Effect.gen(function*() {
            yield* PluginFactoryDependency
            yield* Effect.acquireRelease(
              Ref.update(acquisitions, (count) => count + 1),
              () => Ref.update(releases, (count) => count + 1)
            )
            return services
          })
      })

      yield* Layer.build(
        buildPluginDefinitionLayer(definition, null).pipe(
          Layer.provide(Layer.succeed(PluginFactoryDependency, "available"))
        )
      ).pipe(Effect.scoped)

      assert.strictEqual(yield* Ref.get(acquisitions), 1)
      assert.strictEqual(yield* Ref.get(releases), 1)
    }))

  it.effect("rejects missing negotiated capability codecs before factory construction", () =>
    Effect.gen(function*() {
      const runtime = yield* makeFakePluginRuntime(baseScenario())
      const services = yield* Effect.all({
        connection: PluginConnection,
        executor: AuthorizedPluginExecutor
      }).pipe(Effect.provide(runtime.layer), Effect.scoped)
      const invocations = yield* Ref.make(0)
      const definition = definePluginV1({
        rawDescriptor: descriptor(),
        configurationSchema: Schema.Unknown,
        capabilityCodecs: {},
        make: () => Ref.update(invocations, (count) => count + 1).pipe(Effect.as(services))
      })

      const outcome = yield* Layer.build(buildPluginDefinitionLayer(definition, null)).pipe(
        Effect.scoped,
        Effect.result
      )

      assert.isTrue(Result.isFailure(outcome))
      assert.strictEqual(yield* Ref.get(invocations), 0)
    }))

  it.effect("rejects diff content that exceeds its requested range", () =>
    Effect.gen(function*() {
      const runtime = yield* makeFakePluginRuntime(baseScenario())
      const services = yield* Effect.all({
        connection: PluginConnection,
        executor: AuthorizedPluginExecutor
      }).pipe(Effect.provide(runtime.layer), Effect.scoped)
      const definition = definePluginV1({
        rawDescriptor: descriptor([
          "entity.read",
          "sync.incremental",
          "action.propose",
          "action.execute",
          "action.cancel",
          "action.reconcile",
          "diff.inventory",
          "diff.content"
        ]),
        configurationSchema: Schema.Unknown,
        capabilityCodecs: pluginCapabilityCodecsV1,
        make: () =>
          Effect.succeed({
            connection: {
              ...services.connection,
              diff: Option.some({
                readInventoryPage: () => Effect.succeed({ entries: [], nextCursor: null }),
                readContentRange: () =>
                  Effect.succeed({
                    bytesBase64: Encoding.encodeBase64("too large"),
                    totalBytes: 9,
                    unavailableReason: null
                  })
              })
            },
            executor: services.executor
          })
      })
      const request = Schema.decodeUnknownSync(DiffContentRangeRequestV1)({
        entity: { entityType: "pull-request", vendorImmutableId: "42" },
        path: "src/index.ts",
        side: "after",
        offset: 0,
        length: 1
      })
      const outcome = yield* Effect.gen(function*() {
        const connection = yield* PluginConnection
        return yield* Option.match(connection.diff, {
          onNone: () => Effect.die("expected negotiated diff reader"),
          onSome: (diff) => diff.readContentRange(request)
        })
      }).pipe(Effect.provide(buildPluginDefinitionLayer(definition, null)), Effect.scoped, Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.instanceOf(outcome.failure, PluginMalformedResponseFailure)
        assert.strictEqual(outcome.failure.diagnosticCode, "plugin-diff-content-range-invalid")
      }
    }))

  it.effect("does not invoke an opaque definition factory for an unsupported major", () =>
    Effect.gen(function*() {
      const runtime = yield* makeFakePluginRuntime(baseScenario())
      const services = yield* Effect.all({
        connection: PluginConnection,
        executor: AuthorizedPluginExecutor
      }).pipe(Effect.provide(runtime.layer), Effect.scoped)
      const invocations = yield* Ref.make(0)
      const definition = definePluginV1({
        rawDescriptor: {
          ...descriptor(),
          contractVersion: { major: 2, minor: 0, patch: 0 }
        },
        configurationSchema: Schema.Unknown,
        capabilityCodecs: pluginCapabilityCodecsV1,
        make: () => Ref.update(invocations, (count) => count + 1).pipe(Effect.as(services))
      })

      const outcome = yield* Layer.build(buildPluginDefinitionLayer(definition, null)).pipe(
        Effect.scoped,
        Effect.result
      )

      assert.isTrue(Result.isFailure(outcome))
      assert.strictEqual(yield* Ref.get(invocations), 0)
    }))

  it.effect("replays stable decoded event identities across every scripted page", () =>
    withRuntime(
      baseScenario(),
      Effect.gen(function*() {
        const connection = yield* PluginConnection
        const request = Schema.decodeUnknownSync(PluginSyncRequestV1)({
          streamKey: "entities",
          checkpoint: null
        })
        const first = yield* connection.sync(request).pipe(Stream.runCollect)
        const replay = yield* connection.sync(request).pipe(Stream.runCollect)
        const resumed = yield* connection.sync(resumeSyncRequest).pipe(Stream.runCollect)
        return {
          first: first.flatMap((page) => page.events.map((event) => event.eventId)),
          replay: replay.flatMap((page) => page.events.map((event) => event.eventId)),
          checkpoints: first.map((page) => page.checkpointAfterPage),
          resumed: resumed.flatMap((page) => page.events.map((event) => event.eventId))
        }
      })
    ).pipe(
      Effect.map(({ value }) => {
        assert.deepStrictEqual(value.first, ["event-1", "event-2"])
        assert.deepStrictEqual(value.replay, value.first)
        assert.deepStrictEqual(value.checkpoints, ["checkpoint-1", "checkpoint-2"])
        assert.deepStrictEqual(value.resumed, ["event-2"])
      })
    ))

  it.effect("exposes every partial-failure fixture as a typed redacted failure", () =>
    Effect.gen(function*() {
      const responses: ReadonlyArray<readonly [FakePluginResponse, string]> = [
        [{ _tag: "authentication" }, "PluginAuthenticationFailure"],
        [{ _tag: "authorization" }, "PluginAuthorizationFailure"],
        [{ _tag: "rate-limit", retryAt: RETRY_AT }, "PluginRateLimitFailure"],
        [{ _tag: "timeout" }, "PluginTimeoutFailure"],
        [{ _tag: "malformed", diagnosticCode: "fixture-malformed" }, "PluginMalformedResponseFailure"],
        [{ _tag: "outage" }, "PluginOutageFailure"],
        [{ _tag: "cancellation" }, "PluginCancellationFailure"]
      ]

      for (const [response, expectedTag] of responses) {
        const fiber = yield* withRuntime(
          baseScenario({ health: response }),
          Effect.gen(function*() {
            const connection = yield* PluginConnection
            return yield* connection.health
          })
        ).pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        const outcome = yield* Fiber.join(fiber).pipe(Effect.result)
        assert.isTrue(Result.isFailure(outcome))
        if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, expectedTag)
      }
    }))

  it.effect("retries transient safe reads through the host wrapper at most three times", () =>
    Effect.gen(function*() {
      const runtime = yield* makeFakePluginRuntime(baseScenario({ health: { _tag: "outage" } }))
      const fiber = yield* Effect.gen(function*() {
        const connection = yield* PluginConnection
        return yield* connection.health
      }).pipe(Effect.provide(runtime.layer), Effect.scoped, Effect.forkChild)

      yield* TestClock.adjust("1 second")
      const outcome = yield* Fiber.join(fiber).pipe(Effect.result)
      const snapshot = yield* runtime.probe.snapshot

      assert.isTrue(Result.isFailure(outcome))
      assert.lengthOf(
        snapshot.calls.filter(({ operation }) => operation === "health"),
        3
      )
    }))

  it.effect("retries idempotent cancellation without dispatching a mutation", () =>
    Effect.gen(function*() {
      const runtime = yield* makeFakePluginRuntime(baseScenario({ requestCancellation: { _tag: "outage" } }))
      const fiber = yield* Effect.gen(function*() {
        const executor = yield* AuthorizedPluginExecutor
        return yield* executor.requestCancellation(cancellationRequest)
      }).pipe(Effect.provide(runtime.layer), Effect.scoped, Effect.forkChild)

      yield* TestClock.adjust("1 second")
      const outcome = yield* Fiber.join(fiber).pipe(Effect.result)
      const snapshot = yield* runtime.probe.snapshot

      assert.isTrue(Result.isFailure(outcome))
      assert.lengthOf(
        snapshot.calls.filter(({ operation }) => operation === "request-cancellation"),
        3
      )
      assert.strictEqual(snapshot.providerMutations, 0)
    }))

  it.effect("executes one provider mutation for a repeated idempotency key and digest", () =>
    Effect.gen(function*() {
      const runtime = yield* makeFakePluginRuntime(baseScenario())
      const firstRequest = authorized("0".repeat(64))
      const changedRequest = authorized("1".repeat(64))
      const result = yield* Effect.gen(function*() {
        const executor = yield* AuthorizedPluginExecutor
        const first = yield* executor.executeAuthorizedAction(firstRequest)
        const repeated = yield* executor.executeAuthorizedAction(firstRequest)
        const changed = yield* executor.executeAuthorizedAction(changedRequest).pipe(Effect.result)
        return { first, repeated, changed }
      }).pipe(Effect.provide(runtime.layer), Effect.scoped)
      const snapshot = yield* runtime.probe.snapshot

      assert.deepStrictEqual(result.repeated, result.first)
      assert.isTrue(Result.isFailure(result.changed))
      if (Result.isFailure(result.changed)) {
        assert.instanceOf(result.changed.failure, PluginConflictFailure)
      }
      assert.strictEqual(snapshot.providerMutations, 1)
    }))

  it.effect("never redispatches an ambiguous mutation and reconciles it to a receipt", () =>
    Effect.gen(function*() {
      const reconciliationKey = fakeReconciliationScriptKey("reconcile-1", "action-1")
      const runtime = yield* makeFakePluginRuntime(
        baseScenario({
          executeAuthorizedAction: success({
            _tag: "unknown",
            reconciliationKey: "reconcile-1",
            safeSummary: "Provider outcome requires reconciliation",
            observedAt: OBSERVED_AT
          }),
          reconcile: {
            [reconciliationKey]: [
              success({ _tag: "pending", checkedAt: OBSERVED_AT }),
              success({
                _tag: "succeeded",
                receipt: {
                  providerOperationId: "provider-operation-1",
                  status: "succeeded",
                  safeSummary: "Transition confirmed",
                  observedAt: OBSERVED_AT
                }
              })
            ]
          }
        })
      )
      const request = authorized("0".repeat(64))
      const result = yield* Effect.gen(function*() {
        const executor = yield* AuthorizedPluginExecutor
        const dispatched = yield* executor.executeAuthorizedAction(request)
        const repeated = yield* executor.executeAuthorizedAction(request)
        const pending = yield* executor.reconcile(reconciliationRequest)
        const succeeded = yield* executor.reconcile(reconciliationRequest)
        return { dispatched, repeated, pending, succeeded }
      }).pipe(Effect.provide(runtime.layer), Effect.scoped)
      const snapshot = yield* runtime.probe.snapshot

      assert.strictEqual(result.dispatched._tag, "unknown")
      assert.deepStrictEqual(result.repeated, result.dispatched)
      assert.strictEqual(result.pending._tag, "pending")
      assert.strictEqual(result.succeeded._tag, "succeeded")
      assert.strictEqual(snapshot.providerMutations, 1)
    }))

  it.effect("reconciles a stranded durable start by idempotency identity without dispatch", () =>
    Effect.gen(function*() {
      const reconciliationKey = fakeReconciliationScriptKey(null, "action-1")
      const runtime = yield* makeFakePluginRuntime(
        baseScenario({
          reconcile: {
            [reconciliationKey]: [success({ _tag: "pending", checkedAt: OBSERVED_AT })]
          }
        })
      )
      const result = yield* Effect.gen(function*() {
        const executor = yield* AuthorizedPluginExecutor
        return yield* executor.reconcile(idempotencyReconciliationRequest)
      }).pipe(Effect.provide(runtime.layer), Effect.scoped)
      const snapshot = yield* runtime.probe.snapshot

      assert.strictEqual(result._tag, "pending")
      assert.strictEqual(snapshot.providerMutations, 0)
      assert.deepStrictEqual(snapshot.calls.map(({ operation }) => operation), ["reconcile"])
    }))

  it.effect("rejects internal execution when action execution was not negotiated", () =>
    Effect.gen(function*() {
      const runtime = yield* makeFakePluginRuntime(
        baseScenario({
          descriptor: descriptor(["sync.incremental", "entity.read", "action.propose"])
        })
      )
      const outcome = yield* Effect.gen(function*() {
        const executor = yield* AuthorizedPluginExecutor
        return yield* executor.executeAuthorizedAction(authorized("0".repeat(64)))
      }).pipe(Effect.provide(runtime.layer), Effect.scoped, Effect.result)
      const snapshot = yield* runtime.probe.snapshot

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.instanceOf(outcome.failure, PluginUnsupportedCapabilityFailure)
      }
      assert.strictEqual(snapshot.providerMutations, 0)
    }))
})
