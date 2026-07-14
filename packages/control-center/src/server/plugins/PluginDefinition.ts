import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

import { PluginHealth } from "../../domain/freshness.js"
import {
  type DiffContentRangeRequestV1,
  type DiffContentRangeV1,
  type NegotiatedPluginDescriptorV1,
  type PluginCapabilityId,
  PluginDiscoveryV1
} from "../../domain/plugins/index.js"
import {
  PluginConfigurationFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginUnsupportedCapabilityFailure
} from "./failures.js"
import { AuthorizedPluginExecutor } from "./internal/AuthorizedPluginExecutor.js"
import { hasPluginCapability, negotiatePluginDescriptorV1 } from "./negotiation.js"
import type { PluginCapabilityCodecsV1 } from "./PluginCapabilityCodecs.js"
import { PluginConnection, type PluginConnectionV1 } from "./PluginConnection.js"
import { makePluginDefinitionV1, type PluginDefinitionV1 } from "./PluginDefinitionV1.js"
import type { AuthorizedPluginExecutorV1 } from "./PluginExecutor.js"
import { retryPluginOperation, retryPluginStream } from "./retryPolicy.js"

type PluginServices = PluginConnection | AuthorizedPluginExecutor
type AdapterServices = {
  readonly connection: PluginConnectionV1
  readonly executor: AuthorizedPluginExecutorV1
}

const PluginDefinitionRuntimeTypeId: unique symbol = Symbol.for(
  "@knpkv/control-center/internal/PluginDefinitionRuntimeV1"
)

/** Opaque definition plus its server-private, requirement-preserving runtime. @internal */
export interface DefinedPluginV1<R> extends PluginDefinitionV1 {
  readonly [PluginDefinitionRuntimeTypeId]: {
    readonly requirements: (requirements: R) => R
    readonly build: (
      configuration: unknown,
      descriptor: NegotiatedPluginDescriptorV1
    ) => Layer.Layer<PluginServices, PluginFailure, R>
  }
}

/** Inputs for first-party adapter construction. @internal */
export interface DefinePluginV1Options<ConfigurationSchema extends Schema.Codec<unknown, unknown, never, never>, R> {
  readonly rawDescriptor: unknown
  readonly configurationSchema: ConfigurationSchema
  readonly capabilityCodecs: PluginCapabilityCodecsV1
  readonly make: (input: {
    readonly configuration: ConfigurationSchema["Type"]
    readonly descriptor: NegotiatedPluginDescriptorV1
  }) => Effect.Effect<AdapterServices, PluginFailure, R>
}

const missingCapabilityCodec = (capabilityId: PluginCapabilityId) =>
  new PluginConfigurationFailure({
    diagnosticCode: `plugin-codec-${capabilityId.replaceAll(".", "-")}-missing`
  })

const validateCapabilityCodecs = Effect.fn("PluginDefinition.validateCapabilityCodecs")(function*(
  descriptor: NegotiatedPluginDescriptorV1,
  codecs: PluginCapabilityCodecsV1
) {
  for (const capability of descriptor.capabilities) {
    const registered = (() => {
      switch (capability.capabilityId) {
        case "entity.read":
          return codecs.entityRead
        case "sync.incremental":
          return codecs.syncIncremental
        case "action.propose":
          return codecs.actionPropose
        case "action.execute":
          return codecs.actionExecute
        case "action.cancel":
          return codecs.actionCancel
        case "action.reconcile":
          return codecs.actionReconcile
        case "diff.inventory":
          return codecs.diffInventory
        case "diff.content":
          return codecs.diffContent
      }
    })()
    if (registered === undefined || registered.version !== capability.version) {
      return yield* missingCapabilityCodec(capability.capabilityId)
    }
  }
})

const decodeBoundary = <S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  boundary: "input" | "output",
  schema: S,
  value: unknown
): Effect.Effect<S["Type"], PluginFailure> =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
    Effect.mapError(
      () =>
        new PluginMalformedResponseFailure({
          operation,
          diagnosticCode: `plugin-capability-${boundary}-invalid`
        })
    )
  )

const validateDiffContentRange = Effect.fn("PluginDefinition.validateDiffContentRange")(function*(
  request: DiffContentRangeRequestV1,
  response: DiffContentRangeV1
) {
  if (response.bytesBase64 === null) return response
  const decoded = Encoding.decodeBase64(response.bytesBase64)
  if (Result.isFailure(decoded)) {
    return yield* new PluginMalformedResponseFailure({
      operation: "diff-content",
      diagnosticCode: "plugin-diff-content-base64-invalid"
    })
  }
  if (
    decoded.success.byteLength > request.length ||
    (response.totalBytes !== null &&
      (request.offset > response.totalBytes || request.offset + decoded.success.byteLength > response.totalBytes))
  ) {
    return yield* new PluginMalformedResponseFailure({
      operation: "diff-content",
      diagnosticCode: "plugin-diff-content-range-invalid"
    })
  }
  return response
})

const requireCapability = (
  descriptor: NegotiatedPluginDescriptorV1,
  capabilityId: PluginCapabilityId
): Effect.Effect<void, PluginUnsupportedCapabilityFailure> =>
  hasPluginCapability(descriptor, capabilityId, 1)
    ? Effect.void
    : Effect.fail(
      new PluginUnsupportedCapabilityFailure({
        capabilityId,
        requestedVersion: 1,
        diagnosticCode: "plugin-capability-not-negotiated"
      })
    )

const withCapability = <A, E>(
  descriptor: NegotiatedPluginDescriptorV1,
  capabilityId: PluginCapabilityId,
  effect: Effect.Effect<A, E>
): Effect.Effect<A, E | PluginUnsupportedCapabilityFailure> =>
  requireCapability(descriptor, capabilityId).pipe(Effect.andThen(effect))

const wrapAdapterServices = Effect.fn("PluginDefinition.wrapAdapterServices")(function*(
  descriptor: NegotiatedPluginDescriptorV1,
  codecs: PluginCapabilityCodecsV1,
  services: AdapterServices
) {
  const entityRead = codecs.entityRead
  const syncIncremental = codecs.syncIncremental
  const actionPropose = codecs.actionPropose
  const actionExecute = codecs.actionExecute
  const actionCancel = codecs.actionCancel
  const actionReconcile = codecs.actionReconcile
  const diffInventory = codecs.diffInventory
  const diffContent = codecs.diffContent

  const requiresDiff = hasPluginCapability(descriptor, "diff.inventory", 1) ||
    hasPluginCapability(descriptor, "diff.content", 1)
  if (requiresDiff && Option.isNone(services.connection.diff)) {
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "plugin-negotiated-diff-implementation-missing"
    })
  }

  const connection: PluginConnectionV1 = {
    descriptor,
    discover: retryPluginOperation({
      operation: services.connection.discover,
      safety: "safe-read"
    }).pipe(Effect.flatMap((value) => decodeBoundary("discover", "output", PluginDiscoveryV1, value))),
    health: retryPluginOperation({
      operation: services.connection.health,
      safety: "safe-read"
    }).pipe(Effect.flatMap((value) => decodeBoundary("health", "output", PluginHealth, value))),
    sync: (request) =>
      Stream.unwrap(
        withCapability(
          descriptor,
          "sync.incremental",
          syncIncremental === undefined
            ? Effect.fail(missingCapabilityCodec("sync.incremental"))
            : decodeBoundary("sync", "input", syncIncremental.input, request).pipe(
              Effect.map((decoded) =>
                retryPluginStream({
                  stream: services.connection.sync(decoded),
                  safety: "safe-read"
                }).pipe(Stream.mapEffect((page) => decodeBoundary("sync", "output", syncIncremental.output, page)))
              )
            )
        )
      ),
    readEntity: (request) =>
      withCapability(
        descriptor,
        "entity.read",
        entityRead === undefined
          ? Effect.fail(missingCapabilityCodec("entity.read"))
          : decodeBoundary("read-entity", "input", entityRead.input, request).pipe(
            Effect.flatMap((decoded) =>
              retryPluginOperation({
                operation: services.connection.readEntity(decoded),
                safety: "safe-read"
              })
            ),
            Effect.flatMap((result) => decodeBoundary("read-entity", "output", entityRead.output, result))
          )
      ),
    diff: requiresDiff
      ? Option.map(services.connection.diff, (diff) => ({
        readInventoryPage: (request) =>
          withCapability(
            descriptor,
            "diff.inventory",
            diffInventory === undefined
              ? Effect.fail(missingCapabilityCodec("diff.inventory"))
              : decodeBoundary("diff-inventory", "input", diffInventory.input, request).pipe(
                Effect.flatMap((decoded) =>
                  retryPluginOperation({
                    operation: diff.readInventoryPage(decoded),
                    safety: "safe-read"
                  })
                ),
                Effect.flatMap((page) => decodeBoundary("diff-inventory", "output", diffInventory.output, page))
              )
          ),
        readContentRange: (request) =>
          withCapability(
            descriptor,
            "diff.content",
            diffContent === undefined
              ? Effect.fail(missingCapabilityCodec("diff.content"))
              : decodeBoundary("diff-content", "input", diffContent.input, request).pipe(
                Effect.flatMap((decodedRequest) =>
                  retryPluginOperation({
                    operation: diff.readContentRange(decodedRequest),
                    safety: "safe-read"
                  }).pipe(
                    Effect.flatMap((range) => decodeBoundary("diff-content", "output", diffContent.output, range)),
                    Effect.flatMap((range) => validateDiffContentRange(decodedRequest, range))
                  )
                )
              )
          )
      }))
      : Option.none(),
    proposeAction: (request) =>
      withCapability(
        descriptor,
        "action.propose",
        actionPropose === undefined
          ? Effect.fail(missingCapabilityCodec("action.propose"))
          : decodeBoundary("propose-action", "input", actionPropose.input, request).pipe(
            Effect.flatMap((decoded) =>
              retryPluginOperation({
                operation: services.connection.proposeAction(decoded),
                safety: "safe-read"
              })
            ),
            Effect.flatMap((proposal) => decodeBoundary("propose-action", "output", actionPropose.output, proposal))
          )
      )
  }

  const executor: AuthorizedPluginExecutorV1 = {
    preflight: (request) =>
      withCapability(
        descriptor,
        "action.execute",
        actionExecute === undefined
          ? Effect.fail(missingCapabilityCodec("action.execute"))
          : decodeBoundary("preflight", "input", actionExecute.input, request).pipe(
            Effect.flatMap((decoded) =>
              retryPluginOperation({
                operation: services.executor.preflight(decoded),
                safety: "safe-read"
              })
            ),
            Effect.flatMap((result) => decodeBoundary("preflight", "output", actionExecute.preflightOutput, result))
          )
      ),
    executeAuthorizedAction: (request) =>
      withCapability(
        descriptor,
        "action.execute",
        actionExecute === undefined
          ? Effect.fail(missingCapabilityCodec("action.execute"))
          : decodeBoundary("execute-authorized-action", "input", actionExecute.input, request).pipe(
            Effect.flatMap(services.executor.executeAuthorizedAction),
            Effect.flatMap((result) =>
              decodeBoundary("execute-authorized-action", "output", actionExecute.dispatchOutput, result)
            )
          )
      ),
    requestCancellation: (request) =>
      withCapability(
        descriptor,
        "action.cancel",
        actionCancel === undefined
          ? Effect.fail(missingCapabilityCodec("action.cancel"))
          : decodeBoundary("request-cancellation", "input", actionCancel.input, request).pipe(
            Effect.flatMap((decoded) =>
              retryPluginOperation({
                operation: services.executor.requestCancellation(decoded),
                safety: "idempotent-write"
              })
            ),
            Effect.flatMap((result) => decodeBoundary("request-cancellation", "output", actionCancel.output, result))
          )
      ),
    reconcile: (request) =>
      withCapability(
        descriptor,
        "action.reconcile",
        actionReconcile === undefined
          ? Effect.fail(missingCapabilityCodec("action.reconcile"))
          : decodeBoundary("reconcile", "input", actionReconcile.input, request).pipe(
            Effect.flatMap((decoded) =>
              retryPluginOperation({
                operation: services.executor.reconcile(decoded),
                safety: "safe-read"
              })
            ),
            Effect.flatMap((result) => decodeBoundary("reconcile", "output", actionReconcile.output, result))
          )
      )
  }

  return { connection, executor }
})

/**
 * Define a first-party plugin while keeping its vendor-write service sealed.
 * The adapter acquisition runs inside the built Layer scope and may require services.
 * @internal
 */
export const definePluginV1 = <ConfigurationSchema extends Schema.Codec<unknown, unknown, never, never>, R>(
  options: DefinePluginV1Options<ConfigurationSchema, R>
): DefinedPluginV1<Exclude<R, Scope.Scope>> => {
  const definition = makePluginDefinitionV1(options.rawDescriptor)
  return {
    ...definition,
    [PluginDefinitionRuntimeTypeId]: {
      requirements: (requirements) => requirements,
      build: (configuration, descriptor) =>
        Layer.effectContext(
          Effect.gen(function*() {
            yield* validateCapabilityCodecs(descriptor, options.capabilityCodecs)
            const decoded = yield* Schema.decodeUnknownEffect(options.configurationSchema)(configuration).pipe(
              Effect.mapError(
                () =>
                  new PluginConfigurationFailure({
                    diagnosticCode: "plugin-configuration-schema-invalid"
                  })
              )
            )
            const adapter = yield* options.make({ configuration: decoded, descriptor })
            const wrapped = yield* wrapAdapterServices(descriptor, options.capabilityCodecs, adapter)
            return Context.make(PluginConnection, wrapped.connection).pipe(
              Context.add(AuthorizedPluginExecutor, wrapped.executor)
            )
          })
        )
    }
  }
}

const hasDefinitionRuntime = (definition: PluginDefinitionV1): definition is DefinedPluginV1<never> =>
  PluginDefinitionRuntimeTypeId in definition

/** Negotiate and decode before constructing the scoped adapter layer. @internal */
export function buildPluginDefinitionLayer<R>(
  definition: DefinedPluginV1<R>,
  configuration: unknown
): Layer.Layer<PluginServices, PluginFailure, R>
export function buildPluginDefinitionLayer(
  definition: PluginDefinitionV1,
  configuration: unknown
): Layer.Layer<PluginServices, PluginFailure>
export function buildPluginDefinitionLayer(
  definition: PluginDefinitionV1,
  configuration: unknown
): Layer.Layer<PluginServices, PluginFailure> {
  if (!hasDefinitionRuntime(definition)) {
    return Layer.effectContext(
      Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "plugin-definition-not-registered" }))
    )
  }
  return Layer.unwrap(
    negotiatePluginDescriptorV1(definition.rawDescriptor).pipe(
      Effect.map((descriptor) => definition[PluginDefinitionRuntimeTypeId].build(configuration, descriptor))
    )
  )
}
