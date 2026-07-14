import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import type {
  PatchPluginConfigurationRequest,
  PluginConfiguration,
  PluginConfigurationMetadata,
  PluginConfigurationPatchValue,
  PluginConnectionSummary,
  RedactedPluginConfigurationValue
} from "../../api/plugins.js"
import { PluginConfigurationKey } from "../../api/plugins.js"
import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import { NegotiatedPluginDescriptorV1 } from "../../domain/plugins/descriptor.js"
import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationServiceUnavailable,
  PluginAdministration,
  type PluginAdministrationService
} from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import type { PluginConnectionRecord } from "../persistence/repositories/models.js"
import type { StoredPluginConfigurationValue } from "../persistence/repositories/pluginConfigurationModels.js"
import {
  StoredPluginConfiguration,
  StoredPluginConfigurationKey
} from "../persistence/repositories/pluginConfigurationModels.js"
import { SecretRef } from "../secrets/SecretRef.js"
import { SecretStore } from "../secrets/SecretStore.js"
import { mapPersistenceRead, mapPersistenceReadError, mapPersistenceWriteError } from "./errors.js"

const MAXIMUM_PLUGIN_CONNECTIONS = 100

const decodeNegotiatedDescriptor = (descriptorJson: string) => {
  const json = Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(descriptorJson)
  return Result.isSuccess(json)
    ? Schema.decodeUnknownResult(NegotiatedPluginDescriptorV1)(json.success)
    : json
}

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

const readRuntime = (
  persistence: Persistence["Service"],
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId
) =>
  persistence.pluginRuntime.getRuntime(workspaceId, pluginConnectionId).pipe(
    Effect.mapError(() => unavailable())
  )

const connectionSummary = Effect.fn("PluginAdministration.connectionSummary")(function*(
  persistence: Persistence["Service"],
  connection: PluginConnectionRecord
) {
  const runtime = yield* persistence.pluginRuntime.getRuntime(
    connection.workspaceId,
    connection.pluginConnectionId
  ).pipe(
    Effect.map(Option.some),
    Effect.catchTag("RecordNotFoundError", () => Effect.succeed(Option.none())),
    Effect.mapError(() => unavailable())
  )
  return {
    pluginConnectionId: connection.pluginConnectionId,
    providerId: connection.providerId,
    displayName: connection.displayName,
    isEnabled: connection.isEnabled,
    health: Option.isSome(runtime) ? runtime.value.health : null,
    updatedAt: connection.updatedAt
  } satisfies PluginConnectionSummary
})

const listPluginConnections = Effect.fn("PluginAdministration.listConnections")(function*(
  persistence: Persistence["Service"],
  workspaceId: WorkspaceId
) {
  const connections = yield* persistence.pluginConnections.list(workspaceId).pipe(
    Effect.mapError(() => unavailable())
  )
  if (connections.length > MAXIMUM_PLUGIN_CONNECTIONS) return yield* unavailable()
  const summaries: Array<PluginConnectionSummary> = []
  for (const connection of connections) {
    summaries.push(yield* connectionSummary(persistence, connection))
  }
  return summaries
})

const requireConnection = (
  persistence: Persistence["Service"],
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId
) => mapPersistenceRead(persistence.pluginConnections.get(workspaceId, pluginConnectionId))

const metadata = Effect.fn("PluginAdministration.metadata")(function*(
  persistence: Persistence["Service"],
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId
) {
  yield* requireConnection(persistence, workspaceId, pluginConnectionId)
  const runtime = yield* readRuntime(persistence, workspaceId, pluginConnectionId)
  const negotiated = decodeNegotiatedDescriptor(runtime.descriptorJson)
  if (Result.isFailure(negotiated)) return yield* unavailable()
  return {
    pluginConnectionId,
    pluginId: negotiated.success.descriptor.pluginId,
    contractVersion: negotiated.success.descriptor.contractVersion,
    adapterVersion: negotiated.success.descriptor.adapterVersion,
    configurationFields: negotiated.success.descriptor.configurationFields,
    capabilities: negotiated.success.capabilities
  } satisfies PluginConfigurationMetadata
})

const negotiatedDescriptor = Effect.fn("PluginAdministration.negotiatedDescriptor")(function*(
  persistence: Persistence["Service"],
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId
) {
  const runtime = yield* readRuntime(persistence, workspaceId, pluginConnectionId)
  const negotiated = decodeNegotiatedDescriptor(runtime.descriptorJson)
  if (Result.isFailure(negotiated)) return yield* unavailable()
  return negotiated.success
})

const redactValue = Effect.fn("PluginAdministration.redactValue")(function*(
  secrets: SecretStore["Service"],
  value: StoredPluginConfigurationValue
) {
  const key = yield* Schema.decodeUnknownEffect(PluginConfigurationKey)(value.key).pipe(
    Effect.mapError(() => unavailable())
  )
  if (value._tag === "secret-reference") {
    const resolution = yield* Effect.scoped(secrets.resolve(value.ref).pipe(Effect.asVoid)).pipe(Effect.result)
    if (Result.isFailure(resolution) && resolution.failure._tag !== "SecretNotFoundError") {
      return yield* unavailable()
    }
    return {
      _tag: "secret-reference",
      key,
      state: Result.isSuccess(resolution) ? "configured" : "missing"
    } satisfies RedactedPluginConfigurationValue
  }
  return { ...value, key } satisfies RedactedPluginConfigurationValue
})

const configuration = Effect.fn("PluginAdministration.configuration")(function*(
  persistence: Persistence["Service"],
  secrets: SecretStore["Service"],
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId
) {
  yield* requireConnection(persistence, workspaceId, pluginConnectionId)
  const descriptor = yield* negotiatedDescriptor(persistence, workspaceId, pluginConnectionId)
  const current = yield* persistence.pluginConfigurations.get(workspaceId, pluginConnectionId).pipe(
    Effect.mapError(mapPersistenceReadError)
  )
  const storedValues = Option.isSome(current)
    ? yield* Effect.forEach(current.value.values, (value) => redactValue(secrets, value))
    : []
  const valuesByKey = new Map<string, RedactedPluginConfigurationValue>(
    storedValues.map((value) => [value.key, value])
  )
  const values: Array<RedactedPluginConfigurationValue> = []
  for (const field of descriptor.descriptor.configurationFields) {
    const stored = valuesByKey.get(field.key)
    if (stored !== undefined && stored._tag === field._tag) {
      values.push(stored)
    } else if (field._tag === "secret-reference") {
      const key = yield* Schema.decodeUnknownEffect(PluginConfigurationKey)(field.key).pipe(
        Effect.mapError(() => unavailable())
      )
      values.push({ _tag: "secret-reference", key, state: "missing" })
    }
  }
  if (Option.isNone(current)) {
    return {
      pluginConnectionId,
      revision: 0,
      values,
      updatedAt: null
    } satisfies PluginConfiguration
  }
  return {
    pluginConnectionId,
    revision: current.value.revision,
    values,
    updatedAt: current.value.updatedAt
  } satisfies PluginConfiguration
})

const matchesField = (
  field: typeof NegotiatedPluginDescriptorV1.Type["descriptor"]["configurationFields"][number],
  value: PluginConfigurationPatchValue
): boolean => {
  if (field.key !== value.key || field._tag !== value._tag) return false
  if (field._tag === "integer" && value._tag === "integer") {
    return (field.minimum === null || value.value >= field.minimum) &&
      (field.maximum === null || value.value <= field.maximum)
  }
  if (field._tag === "select" && value._tag === "select") {
    return field.options.some(({ value: option }) => option === value.value)
  }
  return true
}

const validatePatch = Effect.fn("PluginAdministration.validatePatch")(function*(
  descriptor: typeof NegotiatedPluginDescriptorV1.Type,
  patch: PatchPluginConfigurationRequest
) {
  const valuesByKey = new Map<string, PluginConfigurationPatchValue>(
    patch.values.map((value) => [value.key, value])
  )
  for (const field of descriptor.descriptor.configurationFields) {
    const value = valuesByKey.get(field.key)
    const clearsRequiredSecret = field.required &&
      value?._tag === "secret-reference" &&
      value.operation._tag === "clear"
    if (
      (field.required && value === undefined) ||
      clearsRequiredSecret ||
      (value !== undefined && !matchesField(field, value))
    ) {
      return yield* new ApplicationInvalidRequest()
    }
  }
  if (
    patch.values.some((value) => !descriptor.descriptor.configurationFields.some((field) => field.key === value.key))
  ) {
    return yield* new ApplicationInvalidRequest()
  }
})

const storeValue = Effect.fn("PluginAdministration.storeValue")(function*(
  secrets: SecretStore["Service"],
  currentValues: ReadonlyMap<string, StoredPluginConfigurationValue>,
  value: PluginConfigurationPatchValue
) {
  const key = yield* Schema.decodeUnknownEffect(StoredPluginConfigurationKey)(value.key).pipe(
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
  if (value._tag !== "secret-reference") return { ...value, key } satisfies StoredPluginConfigurationValue
  if (value.operation._tag === "clear") return null
  let candidateReference: string
  if (value.operation._tag === "replace") {
    candidateReference = value.operation.reference
  } else {
    const currentValue = currentValues.get(value.key)
    if (currentValue?._tag !== "secret-reference") {
      return yield* new ApplicationInvalidRequest()
    }
    candidateReference = currentValue.ref
  }
  const ref = yield* Schema.decodeUnknownEffect(SecretRef)(candidateReference).pipe(
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
  yield* Effect.scoped(secrets.resolve(ref).pipe(Effect.asVoid)).pipe(
    Effect.mapError((error) =>
      error._tag === "SecretNotFoundError" || error._tag === "SecretStoreInputError"
        ? new ApplicationInvalidRequest()
        : unavailable()
    )
  )
  return { _tag: "secret-reference", key, ref } satisfies StoredPluginConfigurationValue
})

const canonicalValues = Effect.fn("PluginAdministration.canonicalValues")(function*(
  secrets: SecretStore["Service"],
  currentValues: ReadonlyMap<string, StoredPluginConfigurationValue>,
  values: PatchPluginConfigurationRequest["values"]
) {
  const stored: Array<StoredPluginConfigurationValue> = []
  for (const value of values) {
    const candidate = yield* storeValue(secrets, currentValues, value)
    if (candidate !== null) stored.push(candidate)
  }
  stored.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  return yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(stored).pipe(
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
})

/** Construct the secret-free plugin administration adapter over durable host state. */
export const makePluginAdministration = Effect.gen(function*() {
  const persistence = yield* Persistence
  const secrets = yield* SecretStore

  return {
    list: (workspaceId) => listPluginConnections(persistence, workspaceId),
    health: Effect.fn("PluginAdministration.health")(function*({ pluginConnectionId, workspaceId }) {
      yield* requireConnection(persistence, workspaceId, pluginConnectionId)
      const runtime = yield* readRuntime(persistence, workspaceId, pluginConnectionId)
      return { pluginConnectionId, health: runtime.health }
    }),
    configurationMetadata: ({ pluginConnectionId, workspaceId }) =>
      metadata(persistence, workspaceId, pluginConnectionId),
    configuration: ({ pluginConnectionId, workspaceId }) =>
      configuration(persistence, secrets, workspaceId, pluginConnectionId),
    patchConfiguration: Effect.fn("PluginAdministration.patchConfiguration")(function*({
      patch,
      pluginConnectionId,
      workspaceId
    }) {
      yield* requireConnection(persistence, workspaceId, pluginConnectionId)
      const descriptor = yield* negotiatedDescriptor(persistence, workspaceId, pluginConnectionId)
      yield* validatePatch(descriptor, patch)
      const current = yield* persistence.pluginConfigurations.get(workspaceId, pluginConnectionId).pipe(
        Effect.mapError(mapPersistenceReadError)
      )
      const currentRevision = Option.isSome(current) ? current.value.revision : 0
      if (currentRevision !== patch.expectedRevision) return yield* new ApplicationConflict()
      const currentValues = new Map<string, StoredPluginConfigurationValue>(
        Option.isSome(current)
          ? current.value.values.map((value) => [value.key, value])
          : []
      )
      // PATCH is a full replacement: all required descriptor fields must be present.
      // Keep operations resolve only the reference stored at the expected revision. The
      // repository CAS then prevents that reference from surviving a concurrent replacement.
      const values = yield* canonicalValues(secrets, currentValues, patch.values)
      yield* persistence.pluginConfigurations.update(
        workspaceId,
        pluginConnectionId,
        values,
        patch.expectedRevision,
        DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
      ).pipe(Effect.mapError(mapPersistenceWriteError))
      return yield* configuration(persistence, secrets, workspaceId, pluginConnectionId)
    })
  } satisfies PluginAdministrationService
})

/** Live plugin administration layer. */
export const pluginAdministrationLayer = Layer.effect(PluginAdministration, makePluginAdministration)

/** Internal factual projection reused by the portfolio adapter. */
export const listPluginConnectionSummaries = listPluginConnections
