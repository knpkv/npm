import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"

import { PluginHealth } from "../../../domain/freshness.js"
import {
  type AuthorizedPluginActionV1,
  type NegotiatedPluginDescriptorV1,
  PluginActionCancellationResultV1,
  PluginActionDispatchResultV1,
  type PluginActionDispatchResultV1 as PluginActionDispatchResultV1Type,
  type PluginActionPayloadDigest,
  PluginActionPreflightV1,
  PluginActionProposalV1,
  PluginActionReconciliationResultV1,
  PluginDiscoveryV1,
  PluginSyncPageV1,
  type PluginSyncRequestV1,
  ReadPluginEntityResultV1
} from "../../../domain/plugins/index.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  PluginCancellationFailure,
  PluginConfigurationFailure,
  PluginConflictFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginRateLimitFailure,
  PluginTimeoutFailure
} from "../failures.js"
import { negotiatePluginDescriptorV1 } from "../negotiation.js"
import { pluginCapabilityCodecsV1 } from "../PluginCapabilityCodecs.js"
import type { PluginConnectionV1 } from "../PluginConnection.js"
import { buildPluginDefinitionLayer, type DefinedPluginV1, definePluginV1 } from "../PluginDefinition.js"
import type { PluginDefinitionV1 } from "../PluginDefinitionV1.js"
import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"
import type { FakePluginProbe } from "./FakePluginProbe.js"
import { makeFakePluginProbe } from "./FakePluginProbe.js"
import {
  type FakePluginResponse,
  type FakePluginScenario,
  fakeReconciliationScriptKey,
  fakeSyncScriptKey
} from "./FakePluginScenario.js"

interface ExecutedAction {
  readonly payloadDigest: PluginActionPayloadDigest
  readonly result: PluginActionDispatchResultV1Type
}

/** Negotiated fake runtime plus its isolated deterministic observer. */
export interface FakePluginRuntime {
  readonly descriptor: NegotiatedPluginDescriptorV1
  readonly definition: PluginDefinitionV1
  readonly layer: ReturnType<typeof buildPluginDefinitionLayer>
  readonly probe: FakePluginProbe
}

const malformed = (operation: string, diagnosticCode = "fake-response-schema-invalid") =>
  new PluginMalformedResponseFailure({ operation, diagnosticCode })

const decodeResponse = <S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: S,
  response: FakePluginResponse
): Effect.Effect<S["Type"], PluginFailure> => {
  switch (response._tag) {
    case "success":
      return Schema.decodeUnknownEffect(schema)(response.value).pipe(Effect.mapError(() => malformed(operation)))
    case "authentication":
      return Effect.fail(new PluginAuthenticationFailure({ operation }))
    case "authorization":
      return Effect.fail(new PluginAuthorizationFailure({ operation }))
    case "rate-limit":
      return Schema.decodeUnknownEffect(UtcTimestamp)(response.retryAt).pipe(
        Effect.mapError(() => malformed(operation, "fake-rate-limit-time-invalid")),
        Effect.flatMap((retryAt) => Effect.fail(new PluginRateLimitFailure({ operation, retryAt })))
      )
    case "timeout":
      return Effect.fail(new PluginTimeoutFailure({ operation }))
    case "malformed":
      return Effect.fail(malformed(operation, response.diagnosticCode))
    case "outage":
      return Effect.fail(new PluginOutageFailure({ operation }))
    case "cancellation":
      return Effect.fail(new PluginCancellationFailure({ operation }))
  }
}

const missingScript = (operation: string): PluginConfigurationFailure =>
  new PluginConfigurationFailure({ diagnosticCode: `fake-${operation}-script-missing` })

/** Construct a scoped fake adapter from unknown scripted provider responses. */
export const makeFakePluginRuntime: (
  scenario: FakePluginScenario
) => Effect.Effect<FakePluginRuntime, PluginFailure> = Effect.fn("FakePlugin.makeRuntime")(function*(
  scenario: FakePluginScenario
) {
  const descriptor = yield* negotiatePluginDescriptorV1(scenario.descriptor)
  const probeControl = yield* makeFakePluginProbe()
  const executed = yield* Ref.make<ReadonlyMap<string, ExecutedAction>>(new Map())
  const reconcileOffsets = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
  const executeSemaphore = yield* Semaphore.make(1)

  const connection: PluginConnectionV1 = {
    descriptor,
    discover: probeControl
      .recordCall("discover")
      .pipe(Effect.andThen(decodeResponse("discover", PluginDiscoveryV1, scenario.discover))),
    health: probeControl
      .recordCall("health")
      .pipe(Effect.andThen(decodeResponse("health", PluginHealth, scenario.health))),
    sync: (request: PluginSyncRequestV1) => {
      const key = fakeSyncScriptKey(request.streamKey, request.checkpoint)
      const responses = scenario.sync[key]
      if (responses === undefined) {
        return Stream.fail(missingScript("sync"))
      }
      return Stream.unwrap(
        probeControl.recordCall("sync", key).pipe(
          Effect.as(
            Stream.fromIterable(responses).pipe(
              Stream.mapEffect((response) => decodeResponse("sync", PluginSyncPageV1, response))
            )
          )
        )
      )
    },
    readEntity: (request) =>
      probeControl.recordCall("read-entity", `${request.entityType}:${request.vendorImmutableId}`).pipe(
        Effect.andThen(decodeResponse("read-entity", ReadPluginEntityResultV1, scenario.readEntity))
      ),
    diff: Option.none(),
    proposeAction: (request) =>
      probeControl
        .recordCall("propose-action", `${request.actionKind}:${request.target.vendorImmutableId}`)
        .pipe(
          Effect.andThen(decodeResponse("propose-action", PluginActionProposalV1, scenario.proposeAction))
        )
  }

  const executeAuthorizedAction = Effect.fn("FakePlugin.executeAuthorizedAction")(function*(
    request: AuthorizedPluginActionV1
  ) {
    yield* probeControl.recordCall("execute-authorized-action", request.idempotencyKey)

    return yield* executeSemaphore.withPermit(
      Effect.gen(function*() {
        const previous = (yield* Ref.get(executed)).get(request.idempotencyKey)
        if (previous !== undefined) {
          if (previous.payloadDigest !== request.payloadDigest) {
            return yield* new PluginConflictFailure({
              operation: "execute-authorized-action",
              diagnosticCode: "fake-idempotency-payload-conflict"
            })
          }
          return previous.result
        }

        if (scenario.executeAuthorizedActionGate !== undefined) {
          yield* Deferred.succeed(scenario.executeAuthorizedActionGate.entered, undefined)
          yield* Deferred.await(scenario.executeAuthorizedActionGate.release)
        }

        const result = yield* decodeResponse(
          "execute-authorized-action",
          PluginActionDispatchResultV1,
          scenario.executeAuthorizedAction
        )
        yield* probeControl.recordMutation
        yield* Ref.update(executed, (current) => {
          const next = new Map(current)
          next.set(request.idempotencyKey, {
            payloadDigest: request.payloadDigest,
            result
          })
          return next
        })
        return result
      })
    )
  })

  const nextReconciliationResponse = Effect.fn("FakePlugin.nextReconciliation")(function*(key: string) {
    const responses = scenario.reconcile[key]
    if (responses === undefined || responses.length === 0) {
      return yield* missingScript("reconcile")
    }
    const offset = yield* Ref.modify(reconcileOffsets, (current): readonly [number, ReadonlyMap<string, number>] => {
      const selected = Math.min(current.get(key) ?? 0, responses.length - 1)
      const next = new Map(current)
      next.set(key, selected + 1)
      return [selected, next]
    })
    const response = responses[offset]
    return response === undefined ? yield* missingScript("reconcile") : response
  })

  const executor: AuthorizedPluginExecutorV1 = {
    preflight: (request) =>
      probeControl.recordCall("preflight", request.idempotencyKey).pipe(
        Effect.andThen(decodeResponse("preflight", PluginActionPreflightV1, scenario.preflight))
      ),
    executeAuthorizedAction,
    requestCancellation: (request) =>
      probeControl.recordCall("request-cancellation", request.idempotencyKey).pipe(
        Effect.andThen(
          decodeResponse("request-cancellation", PluginActionCancellationResultV1, scenario.requestCancellation)
        )
      ),
    reconcile: (request) => {
      const key = fakeReconciliationScriptKey(request.reconciliationKey, request.idempotencyKey)
      return probeControl.recordCall("reconcile", key).pipe(
        Effect.andThen(nextReconciliationResponse(key)),
        Effect.flatMap((response) => decodeResponse("reconcile", PluginActionReconciliationResultV1, response))
      )
    }
  }

  const definition: DefinedPluginV1<never> = definePluginV1({
    rawDescriptor: scenario.descriptor,
    configurationSchema: Schema.Unknown,
    capabilityCodecs: pluginCapabilityCodecsV1,
    make: () =>
      Effect.acquireRelease(
        probeControl.recordAcquisition,
        () => probeControl.recordRelease
      ).pipe(Effect.as({ connection, executor }))
  })
  const layer = buildPluginDefinitionLayer(definition, null)
  const publicDefinition: PluginDefinitionV1 = definition

  return {
    descriptor,
    definition: publicDefinition,
    layer,
    probe: probeControl.probe
  } satisfies FakePluginRuntime
})
