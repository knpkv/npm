import { HomeDirectoryLive, isTokenExpired } from "@knpkv/atlassian-common/profile-storage"
import { discoverAwsProfiles } from "@knpkv/codecommit-core/ConfigService.js"
import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import type {
  CreatePluginConnectionRequest,
  CreatePluginConnectionResponse,
  PatchPluginConfigurationRequest,
  PluginConfiguration,
  PluginConfigurationMetadata,
  PluginConfigurationPatchValue,
  PluginConnectionIdentity,
  PluginConnectionSummary,
  PluginConnectionTestResult,
  RedactedPluginConfigurationValue
} from "../../api/plugins.js"
import { CreatePluginConnectionValue, PluginConfigurationKey } from "../../api/plugins.js"
import type { PluginHealth } from "../../domain/freshness.js"
import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import { NegotiatedPluginDescriptorV1 } from "../../domain/plugins/descriptor.js"
import type { PluginDiscoveryV1 } from "../../domain/plugins/discovery.js"
import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationServiceUnavailable,
  PluginAdministration,
  type PluginAdministrationService
} from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import type { PluginConnectionRecord } from "../persistence/repositories/models.js"
import { PluginConnectionDisplayName } from "../persistence/repositories/models.js"
import type { StoredPluginConfigurationValue } from "../persistence/repositories/pluginConfigurationModels.js"
import {
  StoredPluginConfiguration,
  StoredPluginConfigurationKey
} from "../persistence/repositories/pluginConfigurationModels.js"
import { discoverAtlassianProfiles, loadAtlassianProfile } from "../plugins/atlassian/AtlassianProfiles.js"
import { firstPartyService, firstPartyServiceCatalog } from "../plugins/catalog/firstPartyServiceCatalog.js"
import { type PluginFailure, pluginFailureClass } from "../plugins/failures.js"
import { negotiatePluginDescriptorV1 } from "../plugins/negotiation.js"
import { PluginConnection } from "../plugins/PluginConnection.js"
import type { PluginConnectionMapV1 } from "../plugins/PluginConnectionMap.js"
import { DomainEventWakeups } from "../runtime/DomainEventWakeups.js"
import { SecretRef } from "../secrets/SecretRef.js"
import { SecretStore } from "../secrets/SecretStore.js"
import { mapPersistenceRead, mapPersistenceReadError, mapPersistenceWriteError } from "./errors.js"
import { appendPortfolioInvalidation } from "./portfolioInvalidation.js"

const MAXIMUM_PLUGIN_CONNECTIONS = 100
const MAXIMUM_DISCOVERED_AWS_PROFILES = 100
const MAXIMUM_DISCOVERED_ATLASSIAN_PROFILES = 100
const MAXIMUM_CONNECTION_TEST_MESSAGE_LENGTH = 200
const secretEncoder = new TextEncoder()

type AtlassianProviderId = Extract<PluginConnectionRecord["providerId"], "jira" | "confluence">
type AtlassianConfigurationValue = CreatePluginConnectionValue | StoredPluginConfigurationValue

const isAtlassianProvider = (
  providerId: PluginConnectionRecord["providerId"]
): providerId is AtlassianProviderId => providerId === "jira" || providerId === "confluence"

const configuredText = (
  values: ReadonlyArray<AtlassianConfigurationValue>,
  key: string
): string | null => {
  const value = values.find((candidate) => candidate.key === key)
  return value !== undefined && (value._tag === "text" || value._tag === "url")
    ? value.value
    : null
}

const validateAtlassianOAuthProfile = Effect.fn("PluginAdministration.validateAtlassianOAuthProfile")(function*(
  providerId: PluginConnectionRecord["providerId"],
  values: ReadonlyArray<AtlassianConfigurationValue>,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path
) {
  if (!isAtlassianProvider(providerId) || configuredText(values, "authMode") !== "oauth") return
  const profileId = configuredText(values, "oauthProfileId")
  const siteUrl = configuredText(values, providerId === "jira" ? "webBaseUrl" : "siteBaseUrl")
  if (profileId === null || siteUrl === null) return yield* new ApplicationInvalidRequest()
  const profile = yield* loadAtlassianProfile(providerId, profileId).pipe(
    Effect.provide([
      HomeDirectoryLive,
      Layer.succeed(FileSystem.FileSystem, fileSystem),
      Layer.succeed(Path.Path, path)
    ]),
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
  if (profile === null || isTokenExpired(profile.token, 0)) return yield* new ApplicationInvalidRequest()
  const expectedSite = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(siteUrl).pipe(
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
  const profileSite = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(profile.token.site_url).pipe(
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
  if (
    profileSite.origin !== expectedSite.origin ||
    (providerId === "confluence" && profile.token.cloud_id !== configuredText(values, "siteId"))
  ) {
    return yield* new ApplicationInvalidRequest()
  }
})

const validateStoredAtlassianAuthentication = Effect.fn(
  "PluginAdministration.validateStoredAtlassianAuthentication"
)(function*(
  providerId: PluginConnectionRecord["providerId"],
  descriptor: typeof NegotiatedPluginDescriptorV1.Type,
  values: ReadonlyArray<StoredPluginConfigurationValue>,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path
) {
  if (
    !isAtlassianProvider(providerId) ||
    (descriptor.descriptor.pluginId !== "dev.knpkv.jira.read" &&
      descriptor.descriptor.pluginId !== "dev.knpkv.confluence")
  ) return
  const authMode = configuredText(values, "authMode")
  const valuesByKey = new Map<string, StoredPluginConfigurationValue>(
    values.map((value) => [value.key, value])
  )
  const hasCredential = (key: string): boolean => valuesByKey.get(key)?._tag === "secret-reference"
  const usesLegacyAuthentication = descriptor.descriptor.configurationFields.every(
    ({ key }) => key !== "authMode" && key !== "oauthProfileId"
  )
  if (authMode === null && usesLegacyAuthentication) {
    const email = valuesByKey.get("email")
    if ((email?._tag !== "text" && email?._tag !== "secret-reference") || !hasCredential("apiToken")) {
      return yield* new ApplicationInvalidRequest()
    }
    return
  }
  if (authMode === "api-token") {
    if (!hasCredential("email") || !hasCredential("apiToken") || valuesByKey.has("oauthProfileId")) {
      return yield* new ApplicationInvalidRequest()
    }
    return
  }
  if (
    authMode !== "oauth" ||
    configuredText(values, "oauthProfileId") === null ||
    valuesByKey.has("email") ||
    valuesByKey.has("apiToken")
  ) {
    return yield* new ApplicationInvalidRequest()
  }
  yield* validateAtlassianOAuthProfile(providerId, values, fileSystem, path)
})

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
  if (!connection.isEnabled) {
    return {
      pluginConnectionId: connection.pluginConnectionId,
      providerId: connection.providerId,
      displayName: connection.displayName,
      isEnabled: false,
      health: { _tag: "disabled", checkedAt: connection.updatedAt },
      updatedAt: connection.updatedAt
    } satisfies PluginConnectionSummary
  }
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

const setConnectionEnabled = Effect.fn("PluginAdministration.setConnectionEnabled")(function*(
  persistence: Persistence["Service"],
  cryptoService: Crypto.Crypto,
  wakeups: DomainEventWakeups["Service"],
  pluginConnections: PluginConnectionMapV1 | null,
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  isEnabled: boolean
) {
  const current = yield* requireConnection(persistence, workspaceId, pluginConnectionId)
  if (current.isEnabled === isEnabled) return yield* connectionSummary(persistence, current)
  if (isEnabled && pluginConnections === null) return yield* unavailable()
  const updatedAt = yield* DateTime.now
  const updated = yield* Effect.uninterruptible(
    persistence.transact(Effect.gen(function*() {
      const changed = yield* persistence.pluginConnections.updateMetadata(workspaceId, pluginConnectionId, {
        displayName: current.displayName,
        isEnabled,
        expectedRevision: current.revision,
        updatedAt
      })
      yield* appendPortfolioInvalidation({
        workspaceId,
        pluginConnectionId,
        releaseId: null,
        occurredAt: updatedAt,
        reason: "plugin-health"
      }).pipe(
        Effect.provideService(Crypto.Crypto, cryptoService),
        Effect.provideService(Persistence, persistence)
      )
      return changed
    })).pipe(
      Effect.mapError(mapPersistenceWriteError),
      Effect.tap(() =>
        pluginConnections === null
          ? Effect.void
          : pluginConnections.invalidate({ workspaceId, pluginConnectionId })
      ),
      Effect.tap(() => wakeups.notify(workspaceId))
    )
  )
  return yield* connectionSummary(persistence, updated)
})

const identityLabel = (providerId: PluginConnectionRecord["providerId"]): string => {
  switch (providerId) {
    case "jira":
    case "confluence":
      return "Atlassian user"
    case "codecommit":
    case "codepipeline":
      return "AWS account"
    case "clockify":
      return "Clockify user"
  }
}

const failureMessage = (failure: PluginFailure): string => {
  switch (failure._tag) {
    case "PluginAuthenticationFailure":
      return "The provider rejected these credentials."
    case "PluginAuthorizationFailure":
      return "These credentials cannot perform the connection check."
    case "PluginRateLimitFailure":
      return "The provider rate limit has been reached."
    case "PluginTimeoutFailure":
      return "The provider did not respond before the connection timed out."
    case "PluginMalformedResponseFailure":
      return "The provider returned an unexpected identity response."
    case "PluginOutageFailure":
      return "The provider is currently unavailable."
    case "PluginCancellationFailure":
      return "The connection check was interrupted."
    case "PluginConflictFailure":
    case "PluginUnsupportedCapabilityFailure":
    case "PluginConfigurationFailure":
    case "PluginUnknownOutcomeFailure":
      return "The connection could not be verified."
  }
}

const elapsedMilliseconds = (startedAt: bigint, finishedAt: bigint): number =>
  Math.max(0, Number((finishedAt - startedAt) / 1_000_000n))

const boundedConnectionTestMessage = (message: string): string =>
  message.slice(0, MAXIMUM_CONNECTION_TEST_MESSAGE_LENGTH).trimEnd()

type LiveConnectionTestOutcome =
  | { readonly _tag: "reported-failure"; readonly health: PluginHealth }
  | {
    readonly _tag: "discovered"
    readonly discovery: PluginDiscoveryV1
    readonly health: Extract<PluginHealth, { readonly _tag: "healthy" }>
  }

const testPluginConnection = Effect.fn("PluginAdministration.testConnection")(function*(
  persistence: Persistence["Service"],
  pluginConnections: PluginConnectionMapV1 | null,
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId
) {
  const record = yield* requireConnection(persistence, workspaceId, pluginConnectionId)
  const startedAt = yield* Clock.currentTimeNanos
  if (!record.isEnabled) {
    return {
      _tag: "failed",
      pluginConnectionId,
      providerId: record.providerId,
      checkedAt: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
      latencyMilliseconds: elapsedMilliseconds(startedAt, yield* Clock.currentTimeNanos),
      failureClass: "unknown",
      retryAt: null,
      safeMessage: "This connection is disabled."
    } satisfies PluginConnectionTestResult
  }
  if (pluginConnections === null) return yield* unavailable()

  const outcome = yield* Effect.scoped(
    Effect.gen(function*() {
      const context = yield* pluginConnections.contextEffect({ workspaceId, pluginConnectionId })
      const connection = Context.get(context, PluginConnection)
      const health = yield* connection.health
      if (health._tag !== "healthy") {
        return { _tag: "reported-failure", health } satisfies LiveConnectionTestOutcome
      }
      const discovery = yield* connection.discover
      return { _tag: "discovered", discovery, health } satisfies LiveConnectionTestOutcome
    })
  ).pipe(Effect.result)
  const latencyMilliseconds = elapsedMilliseconds(startedAt, yield* Clock.currentTimeNanos)
  const checkedAt = DateTime.makeUnsafe(yield* Clock.currentTimeMillis)

  if (Result.isFailure(outcome)) {
    const failure = outcome.failure
    return {
      _tag: "failed",
      pluginConnectionId,
      providerId: record.providerId,
      checkedAt,
      latencyMilliseconds,
      failureClass: pluginFailureClass(failure),
      retryAt: failure._tag === "PluginRateLimitFailure" ? failure.retryAt : null,
      safeMessage: failureMessage(failure)
    } satisfies PluginConnectionTestResult
  }
  if (outcome.success._tag === "reported-failure") {
    const health = outcome.success.health
    return {
      _tag: "failed",
      pluginConnectionId,
      providerId: record.providerId,
      checkedAt: health.checkedAt,
      latencyMilliseconds,
      failureClass: health._tag === "disabled" ? "unknown" : health.failureClass,
      retryAt: health._tag === "disabled" ? null : health.retryAt,
      safeMessage: health._tag === "disabled"
        ? "This connection is disabled."
        : boundedConnectionTestMessage(health.safeMessage)
    } satisfies PluginConnectionTestResult
  }

  const discoveredIdentity = outcome.success.discovery.account ?? outcome.success.discovery.workspace
  if (discoveredIdentity === null) {
    return {
      _tag: "failed",
      pluginConnectionId,
      providerId: record.providerId,
      checkedAt: outcome.success.health.checkedAt,
      latencyMilliseconds,
      failureClass: "malformed-response",
      retryAt: null,
      safeMessage: "The provider did not return a usable account identity."
    } satisfies PluginConnectionTestResult
  }
  const identity = {
    kind: outcome.success.discovery.account === null
      ? "workspace"
      : record.providerId === "jira" || record.providerId === "confluence" || record.providerId === "clockify"
      ? "user"
      : "account",
    label: identityLabel(record.providerId),
    displayName: discoveredIdentity.displayName,
    providerImmutableId: discoveredIdentity.providerImmutableId
  } satisfies PluginConnectionIdentity
  return {
    _tag: "healthy",
    pluginConnectionId,
    providerId: record.providerId,
    checkedAt: outcome.success.health.checkedAt,
    latencyMilliseconds,
    identity
  } satisfies PluginConnectionTestResult
})

const metadata = Effect.fn("PluginAdministration.metadata")(function*(
  persistence: Persistence["Service"],
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId
) {
  yield* requireConnection(persistence, workspaceId, pluginConnectionId)
  const negotiated = yield* negotiatedDescriptor(persistence, workspaceId, pluginConnectionId)
  return {
    pluginConnectionId,
    pluginId: negotiated.descriptor.pluginId,
    contractVersion: negotiated.descriptor.contractVersion,
    adapterVersion: negotiated.descriptor.adapterVersion,
    configurationFields: negotiated.descriptor.configurationFields,
    capabilities: negotiated.capabilities
  } satisfies PluginConfigurationMetadata
})

const negotiatedDescriptor = Effect.fn("PluginAdministration.negotiatedDescriptor")(function*(
  persistence: Persistence["Service"],
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId
) {
  const connection = yield* requireConnection(persistence, workspaceId, pluginConnectionId)
  const runtime = yield* persistence.pluginRuntime.getRuntime(workspaceId, pluginConnectionId).pipe(
    Effect.map(Option.some),
    Effect.catchTag("RecordNotFoundError", () => Effect.succeed(Option.none())),
    Effect.mapError(() => unavailable())
  )
  if (Option.isSome(runtime)) {
    const negotiated = decodeNegotiatedDescriptor(runtime.value.descriptorJson)
    if (Result.isFailure(negotiated)) return yield* unavailable()
    return negotiated.success
  }
  const catalog = firstPartyService(connection.providerId)
  if (catalog === undefined) return yield* unavailable()
  return yield* negotiatePluginDescriptorV1(catalog.rawDescriptor).pipe(
    Effect.mapError(() => unavailable())
  )
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
  const connection = yield* requireConnection(persistence, workspaceId, pluginConnectionId)
  const descriptor = yield* negotiatedDescriptor(persistence, workspaceId, pluginConnectionId)
  const credentialKeys = new Set<string>(
    firstPartyService(connection.providerId)?.metadata.configurationFields
      .filter(({ scope }) => scope === "credential")
      .map(({ key }) => key) ?? []
  )
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
    if (
      stored !== undefined &&
      ((stored._tag === field._tag && !credentialKeys.has(field.key)) ||
        (credentialKeys.has(field.key) && stored._tag === "secret-reference"))
    ) {
      values.push(stored)
    } else if (field._tag === "secret-reference" || credentialKeys.has(field.key)) {
      const key = yield* Schema.decodeUnknownEffect(PluginConfigurationKey)(field.key).pipe(
        Effect.mapError(() => unavailable())
      )
      values.push({
        _tag: "secret-reference",
        key,
        state: stored === undefined ? "missing" : "configured"
      })
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
  value: PluginConfigurationPatchValue,
  credentialKeys: ReadonlySet<string>
): boolean => {
  if (field.key !== value.key) return false
  if (credentialKeys.has(field.key)) return value._tag === "secret-reference"
  if (field._tag !== value._tag) return false
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
  patch: PatchPluginConfigurationRequest,
  credentialKeys: ReadonlySet<string>
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
      (value !== undefined && !matchesField(field, value, credentialKeys))
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
  value: PluginConfigurationPatchValue,
  credentialKeys: ReadonlySet<string>
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
    if (currentValue?._tag === "text" && credentialKeys.has(value.key)) return currentValue
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
  values: PatchPluginConfigurationRequest["values"],
  credentialKeys: ReadonlySet<string>
) {
  const stored: Array<StoredPluginConfigurationValue> = []
  for (const value of values) {
    const candidate = yield* storeValue(secrets, currentValues, value, credentialKeys)
    if (candidate !== null) stored.push(candidate)
  }
  stored.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  return yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(stored).pipe(
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
})

type FirstPartyCatalogEntry = NonNullable<ReturnType<typeof firstPartyService>>
type FirstPartyCatalogField = FirstPartyCatalogEntry["metadata"]["configurationFields"][number]

const valueMatchesCatalogField = (
  field: FirstPartyCatalogField,
  value: CreatePluginConnectionValue
): boolean => {
  if (field.key !== value.key || field.kind !== value._tag) return false
  if (value._tag === "integer") {
    return (field.minimum === null || value.value >= field.minimum) &&
      (field.maximum === null || value.value <= field.maximum)
  }
  return true
}

const defaultSetupValue = Effect.fn("PluginAdministration.defaultSetupValue")(function*(
  field: FirstPartyCatalogField
) {
  if (field.defaultValue === null) return yield* new ApplicationInvalidRequest()
  const candidate = field.kind === "integer"
    ? { _tag: "integer", key: field.key, value: Number(field.defaultValue) }
    : field.kind === "secret"
    ? null
    : { _tag: field.kind, key: field.key, value: field.defaultValue }
  if (candidate === null) return yield* new ApplicationInvalidRequest()
  const decoded = yield* Schema.decodeUnknownEffect(CreatePluginConnectionValue)(candidate).pipe(
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
  if (!valueMatchesCatalogField(field, decoded)) return yield* new ApplicationInvalidRequest()
  return decoded
})

const validateSetup = Effect.fn("PluginAdministration.validateSetup")(function*(
  catalog: FirstPartyCatalogEntry,
  request: CreatePluginConnectionRequest
) {
  yield* negotiatePluginDescriptorV1(catalog.rawDescriptor).pipe(
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
  yield* Schema.decodeUnknownEffect(PluginConnectionDisplayName)(request.displayName).pipe(
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
  const valuesByKey = new Map(request.values.map((value) => [value.key, value]))
  if (request.values.some((value) => !catalog.metadata.configurationFields.some((field) => field.key === value.key))) {
    return yield* new ApplicationInvalidRequest()
  }
  const values: Array<CreatePluginConnectionValue> = []
  for (const field of catalog.metadata.configurationFields) {
    const supplied = valuesByKey.get(field.key)
    if (supplied === undefined && field.defaultValue === null && !field.required) continue
    const value = supplied ?? (yield* defaultSetupValue(field))
    if (!valueMatchesCatalogField(field, value)) return yield* new ApplicationInvalidRequest()
    if (field.isReadOnly && field.defaultValue !== String(value.value)) {
      return yield* new ApplicationInvalidRequest()
    }
    values.push(value)
  }
  if (!catalog.validatesSetup(values)) return yield* new ApplicationInvalidRequest()
  return values
})

const storeSetupValues = Effect.fn("PluginAdministration.storeSetupValues")(function*(
  secrets: SecretStore["Service"],
  catalog: FirstPartyCatalogEntry,
  values: ReadonlyArray<CreatePluginConnectionValue>,
  createdSecretReferences: Array<SecretRef>
) {
  const stored: Array<StoredPluginConfigurationValue> = []
  for (const value of values) {
    const key = yield* Schema.decodeUnknownEffect(StoredPluginConfigurationKey)(value.key).pipe(
      Effect.mapError(() => new ApplicationInvalidRequest())
    )
    const field = catalog.metadata.configurationFields.find((candidate) => candidate.key === value.key)
    if (field === undefined) return yield* new ApplicationInvalidRequest()
    if (value._tag === "secret" || field.scope === "credential") {
      if (typeof value.value !== "string") return yield* new ApplicationInvalidRequest()
      const ref = yield* secrets.create(secretEncoder.encode(value.value)).pipe(
        Effect.mapError(() => unavailable())
      )
      createdSecretReferences.push(ref)
      stored.push({ _tag: "secret-reference", key, ref })
    } else {
      stored.push({ ...value, key })
    }
  }
  stored.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  return yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(stored).pipe(
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
})

const removeSetupSecrets = (
  secrets: SecretStore["Service"],
  references: ReadonlyArray<SecretRef>
): Effect.Effect<void> =>
  Effect.forEach(
    references,
    (reference) => secrets.remove(reference).pipe(Effect.catch(() => Effect.void)),
    { discard: true }
  )

const removeSetupSecretsUnlessConfigured = Effect.fn(
  "PluginAdministration.removeSetupSecretsUnlessConfigured"
)(function*(
  persistence: Persistence["Service"],
  secrets: SecretStore["Service"],
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  references: ReadonlyArray<SecretRef>
) {
  const configuration = yield* persistence.pluginConfigurations.get(workspaceId, pluginConnectionId).pipe(
    Effect.result
  )
  if (Result.isSuccess(configuration) && Option.isNone(configuration.success)) {
    yield* removeSetupSecrets(secrets, references)
  }
})

const disableAfterSetupFailure = (
  persistence: Persistence["Service"],
  workspaceId: WorkspaceId,
  connection: PluginConnectionRecord
): Effect.Effect<void> =>
  persistence.pluginConnections.updateMetadata(workspaceId, connection.pluginConnectionId, {
    displayName: connection.displayName,
    isEnabled: false,
    expectedRevision: connection.revision,
    updatedAt: connection.updatedAt
  }).pipe(
    Effect.asVoid,
    Effect.catch(() => Effect.void)
  )

const persistSetupTestHealth = Effect.fn("PluginAdministration.persistSetupTestHealth")(function*(
  persistence: Persistence["Service"],
  cryptoService: Crypto.Crypto,
  wakeups: DomainEventWakeups["Service"],
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  test: PluginConnectionTestResult
) {
  const health: PluginHealth = test._tag === "healthy"
    ? { _tag: "healthy", checkedAt: test.checkedAt }
    : {
      _tag: "unavailable",
      checkedAt: test.checkedAt,
      failureClass: test.failureClass,
      retryAt: test.retryAt,
      safeMessage: test.safeMessage
    }
  yield* persistence.transact(Effect.gen(function*() {
    const runtime = yield* persistence.pluginRuntime.getRuntime(workspaceId, pluginConnectionId)
    yield* persistence.pluginRuntime.recordHealth(
      workspaceId,
      pluginConnectionId,
      runtime.revision,
      health,
      test._tag === "healthy" ? 0 : runtime.consecutiveFailures + 1
    )
    yield* appendPortfolioInvalidation({
      workspaceId,
      pluginConnectionId,
      releaseId: null,
      occurredAt: test.checkedAt,
      reason: "plugin-health"
    }).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.provideService(Persistence, persistence)
    )
  })).pipe(Effect.mapError(mapPersistenceWriteError))
  yield* wakeups.notify(workspaceId)
})

const connectAndTest = Effect.fn("PluginAdministration.connectAndTest")(function*(
  persistence: Persistence["Service"],
  cryptoService: Crypto.Crypto,
  wakeups: DomainEventWakeups["Service"],
  secrets: SecretStore["Service"],
  pluginConnections: PluginConnectionMapV1 | null,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  workspaceId: WorkspaceId,
  request: CreatePluginConnectionRequest
) {
  const catalog = firstPartyService(request.providerId)
  if (catalog === undefined) return yield* new ApplicationInvalidRequest()
  const setupValues = yield* validateSetup(catalog, request)
  yield* validateAtlassianOAuthProfile(request.providerId, setupValues, fileSystem, path)
  const displayName = yield* Schema.decodeUnknownEffect(PluginConnectionDisplayName)(request.displayName).pipe(
    Effect.mapError(() => new ApplicationInvalidRequest())
  )
  const createdSecretReferences: Array<SecretRef> = []

  return yield* Effect.gen(function*() {
    const values = yield* storeSetupValues(secrets, catalog, setupValues, createdSecretReferences)
    const createdAt = yield* DateTime.now
    const draft = yield* persistence.pluginConnections.createBounded(workspaceId, {
      pluginConnectionId: request.pluginConnectionId,
      providerId: request.providerId,
      displayName,
      isEnabled: false,
      createdAt,
      maximum: MAXIMUM_PLUGIN_CONNECTIONS
    }).pipe(Effect.mapError(mapPersistenceWriteError))
    yield* persistence.pluginConfigurations.update(
      workspaceId,
      request.pluginConnectionId,
      values,
      0,
      createdAt
    ).pipe(Effect.mapError(mapPersistenceWriteError))
    yield* Effect.uninterruptible(Effect.gen(function*() {
      const runtime = yield* persistence.pluginRuntime.acceptPluginDescriptor(
        workspaceId,
        request.pluginConnectionId,
        request.providerId,
        catalog.rawDescriptor,
        0,
        createdAt
      ).pipe(Effect.mapError(mapPersistenceWriteError))
      yield* persistence.pluginRuntime.recordHealth(
        workspaceId,
        request.pluginConnectionId,
        runtime.revision,
        { _tag: "disabled", checkedAt: createdAt },
        0
      ).pipe(Effect.mapError(mapPersistenceWriteError))
    }))

    if (pluginConnections === null) return yield* unavailable()
    const enabled = yield* persistence.pluginConnections.updateMetadata(workspaceId, request.pluginConnectionId, {
      displayName: draft.displayName,
      isEnabled: true,
      expectedRevision: draft.revision,
      updatedAt: yield* DateTime.now
    }).pipe(Effect.mapError(mapPersistenceWriteError))

    return yield* Effect.gen(function*() {
      yield* pluginConnections.invalidate({ workspaceId, pluginConnectionId: request.pluginConnectionId })
      const test = yield* testPluginConnection(
        persistence,
        pluginConnections,
        workspaceId,
        request.pluginConnectionId
      )
      yield* persistSetupTestHealth(
        persistence,
        cryptoService,
        wakeups,
        workspaceId,
        request.pluginConnectionId,
        test
      )
      return {
        connection: yield* connectionSummary(persistence, enabled),
        configuration: yield* configuration(persistence, secrets, workspaceId, request.pluginConnectionId),
        test
      } satisfies CreatePluginConnectionResponse
    }).pipe(Effect.tapError(() => disableAfterSetupFailure(persistence, workspaceId, enabled)))
  }).pipe(
    Effect.onExit(() =>
      removeSetupSecretsUnlessConfigured(
        persistence,
        secrets,
        workspaceId,
        request.pluginConnectionId,
        createdSecretReferences
      )
    )
  )
})

/** Construct the secret-free plugin administration adapter over durable host state. */
export const makePluginAdministrationWithConnections = Effect.fn("PluginAdministration.makeWithConnections")(function*(
  pluginConnections: PluginConnectionMapV1 | null
) {
  const persistence = yield* Persistence
  const cryptoService = yield* Crypto.Crypto
  const wakeups = yield* DomainEventWakeups
  const secrets = yield* SecretStore
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  return {
    list: (workspaceId) => listPluginConnections(persistence, workspaceId),
    discoverAwsProfiles: Effect.fn("PluginAdministration.discoverAwsProfiles")(function*() {
      const home = yield* Config.string("HOME").pipe(
        Config.orElse(() => Config.string("USERPROFILE")),
        Effect.mapError(() => unavailable())
      )
      const profiles = yield* discoverAwsProfiles(home).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path)
      )
      if (profiles.length > MAXIMUM_DISCOVERED_AWS_PROFILES) return yield* unavailable()
      return profiles
        .map(({ name, region }) => ({ profile: name, region: region ?? null }))
        .sort((left, right) => left.profile.localeCompare(right.profile))
    }),
    discoverAtlassianProfiles: Effect.fn("PluginAdministration.discoverAtlassianProfiles")(function*() {
      const profiles = yield* discoverAtlassianProfiles().pipe(
        Effect.provide([
          HomeDirectoryLive,
          Layer.succeed(FileSystem.FileSystem, fileSystem),
          Layer.succeed(Path.Path, path)
        ]),
        Effect.mapError(() => unavailable())
      )
      if (profiles.length > MAXIMUM_DISCOVERED_ATLASSIAN_PROFILES) return yield* unavailable()
      return [...profiles].sort((left, right) => left.name.localeCompare(right.name))
    }),
    connectAndTest: ({ request, workspaceId }) =>
      connectAndTest(
        persistence,
        cryptoService,
        wakeups,
        secrets,
        pluginConnections,
        fileSystem,
        path,
        workspaceId,
        request
      ),
    setConnectionEnabled: ({ isEnabled, pluginConnectionId, workspaceId }) =>
      setConnectionEnabled(
        persistence,
        cryptoService,
        wakeups,
        pluginConnections,
        workspaceId,
        pluginConnectionId,
        isEnabled
      ),
    health: Effect.fn("PluginAdministration.health")(function*({ pluginConnectionId, workspaceId }) {
      const connection = yield* requireConnection(persistence, workspaceId, pluginConnectionId)
      if (!connection.isEnabled) {
        return {
          pluginConnectionId,
          health: { _tag: "disabled", checkedAt: connection.updatedAt }
        }
      }
      const runtime = yield* readRuntime(persistence, workspaceId, pluginConnectionId)
      return { pluginConnectionId, health: runtime.health }
    }),
    testConnection: Effect.fn("PluginAdministration.testConnection")(function*({ pluginConnectionId, workspaceId }) {
      const connection = yield* requireConnection(persistence, workspaceId, pluginConnectionId)
      const test = yield* testPluginConnection(persistence, pluginConnections, workspaceId, pluginConnectionId)
      if (connection.isEnabled) {
        yield* persistSetupTestHealth(
          persistence,
          cryptoService,
          wakeups,
          workspaceId,
          pluginConnectionId,
          test
        ).pipe(
          Effect.mapError(() => unavailable())
        )
      }
      return test
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
      const connection = yield* requireConnection(persistence, workspaceId, pluginConnectionId)
      const credentialKeys = new Set<string>(
        firstPartyService(connection.providerId)?.metadata.configurationFields
          .filter(({ scope }) => scope === "credential")
          .map(({ key }) => key) ?? []
      )
      const descriptor = yield* negotiatedDescriptor(persistence, workspaceId, pluginConnectionId)
      yield* validatePatch(descriptor, patch, credentialKeys)
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
      const values = yield* canonicalValues(secrets, currentValues, patch.values, credentialKeys)
      yield* validateStoredAtlassianAuthentication(
        connection.providerId,
        descriptor,
        values,
        fileSystem,
        path
      )
      const updatedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
      yield* Effect.uninterruptible(
        persistence.pluginConfigurations.update(
          workspaceId,
          pluginConnectionId,
          values,
          patch.expectedRevision,
          updatedAt
        ).pipe(
          Effect.mapError(mapPersistenceWriteError),
          Effect.andThen(
            pluginConnections === null
              ? Effect.void
              : pluginConnections.invalidate({ workspaceId, pluginConnectionId })
          )
        )
      )
      return yield* configuration(persistence, secrets, workspaceId, pluginConnectionId)
    })
  } satisfies PluginAdministrationService
})

/** Construct administration reads when no provider runtime registry is configured. */
export const makePluginAdministration = makePluginAdministrationWithConnections(null)

/** Live plugin administration layer. */
export const pluginAdministrationLayer = Layer.effect(PluginAdministration, makePluginAdministration)

/** Live administration layer backed by the same scoped provider registry as synchronization. */
export const pluginAdministrationLayerWithConnections = (pluginConnections: PluginConnectionMapV1) =>
  Layer.effect(PluginAdministration, makePluginAdministrationWithConnections(pluginConnections))

/** Internal factual projection reused by the portfolio adapter. */
export const listPluginConnectionSummaries = listPluginConnections

/** Secret-free fixed catalog projection consumed by the authenticated overview handler. */
export const listFirstPartyServiceMetadata = () => firstPartyServiceCatalog.map(({ metadata }) => metadata)
