import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import { PluginFailureClass, PluginHealth } from "../domain/freshness.js"
import { PluginConnectionId } from "../domain/identifiers.js"
import {
  NegotiatedPluginCapabilityV1,
  PluginConfigurationFieldV1,
  PluginId,
  SemanticVersion
} from "../domain/plugins/descriptor.js"
import { ProviderId } from "../domain/sourceRevision.js"
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import {
  ConflictApiError,
  ForbiddenApiError,
  InvalidRequestApiError,
  NotFoundApiError,
  PayloadTooLargeApiError,
  RateLimitedApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { SessionCookieAuth, SessionMutationAuth } from "./session.js"

const MAXIMUM_PLUGIN_CONNECTIONS = 100
const MAXIMUM_CONFIGURATION_VALUES = 100
const MAXIMUM_SECRET_VALUE_LENGTH = 16_384

const isProviderHttpUrl = Schema.makeFilter((value: string) => {
  const decoded = Schema.decodeUnknownResult(Schema.URLFromString)(value)
  if (Result.isFailure(decoded)) return false
  const url = decoded.success
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.hostname.length > 0 &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.hash.length === 0
  )
}, { expected: "an HTTP(S) provider URL without credentials or a fragment" })

/** Stable field key shared by descriptor metadata and configuration values. */
export const PluginConfigurationKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(100)
).pipe(Schema.brand("PluginConfigurationKey"))

/** Decoded plugin configuration field key. */
export type PluginConfigurationKey = typeof PluginConfigurationKey.Type

/** Opaque reference created through the separate secret-management boundary. */
export const OpaqueSecretReference = Schema.String.check(
  Schema.isPattern(/^secret_[0-9a-f]{64}$/u, { expected: "an opaque secret reference" })
).pipe(Schema.brand("OpaqueSecretReference"))

/** Decoded opaque secret reference. */
export type OpaqueSecretReference = typeof OpaqueSecretReference.Type

const configurationValueFields = { key: PluginConfigurationKey }
const BoundedConfigurationText = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096)
)
const BoundedConfigurationUrl = BoundedConfigurationText.check(isProviderHttpUrl)

/** Explicit replacement semantics for a redacted secret in a full configuration update. */
export const SecretReferencePatchOperation = Schema.Union([
  Schema.TaggedStruct("keep", {}),
  Schema.TaggedStruct("clear", {}),
  Schema.TaggedStruct("replace", { reference: OpaqueSecretReference })
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded secret update operation that never requires the current reference to leave the server. */
export type SecretReferencePatchOperation = typeof SecretReferencePatchOperation.Type

/** Secret-safe current value; secret fields reveal only whether a reference is configured. */
export const RedactedPluginConfigurationValue = Schema.Union([
  Schema.TaggedStruct("text", { ...configurationValueFields, value: BoundedConfigurationText }),
  Schema.TaggedStruct("url", { ...configurationValueFields, value: BoundedConfigurationUrl }),
  Schema.TaggedStruct("boolean", { ...configurationValueFields, value: Schema.Boolean }),
  Schema.TaggedStruct("integer", { ...configurationValueFields, value: Schema.Int }),
  Schema.TaggedStruct("select", { ...configurationValueFields, value: BoundedConfigurationText }),
  Schema.TaggedStruct("secret-reference", {
    ...configurationValueFields,
    state: Schema.Literals(["configured", "missing"])
  })
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded secret-safe current configuration value. */
export type RedactedPluginConfigurationValue = typeof RedactedPluginConfigurationValue.Type

/** Typed configuration update; secret bytes remain outside this endpoint. */
export const PluginConfigurationPatchValue = Schema.Union([
  Schema.TaggedStruct("text", { ...configurationValueFields, value: BoundedConfigurationText }),
  Schema.TaggedStruct("url", { ...configurationValueFields, value: BoundedConfigurationUrl }),
  Schema.TaggedStruct("boolean", { ...configurationValueFields, value: Schema.Boolean }),
  Schema.TaggedStruct("integer", { ...configurationValueFields, value: Schema.Int }),
  Schema.TaggedStruct("select", { ...configurationValueFields, value: BoundedConfigurationText }),
  Schema.TaggedStruct("secret-reference", {
    ...configurationValueFields,
    operation: SecretReferencePatchOperation
  })
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded typed plugin configuration update value. */
export type PluginConfigurationPatchValue = typeof PluginConfigurationPatchValue.Type

const boundedConfigurationValues = <T extends { readonly key: string }, E extends { readonly key: string }, RD, RE>(
  value: Schema.Codec<T, E, RD, RE>
) =>
  Schema.Array(value).check(
    Schema.makeFilter((values) => values.length <= MAXIMUM_CONFIGURATION_VALUES, {
      expected: `at most ${MAXIMUM_CONFIGURATION_VALUES} plugin configuration values`
    }),
    Schema.makeFilter((values) => new Set(values.map(({ key }) => key)).size === values.length, {
      expected: "unique plugin configuration keys"
    })
  )

/** Redacted current configuration with its compare-and-swap revision. */
export const PluginConfiguration = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  values: boundedConfigurationValues(RedactedPluginConfigurationValue),
  updatedAt: Schema.NullOr(UtcTimestamp)
}).annotate({ identifier: "PluginConfiguration" })

/** Decoded redacted current plugin configuration. */
export type PluginConfiguration = typeof PluginConfiguration.Type

/** Bounded compare-and-swap update request for one plugin connection. */
export const PatchPluginConfigurationRequest = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  values: boundedConfigurationValues(PluginConfigurationPatchValue)
}).annotate({ identifier: "PatchPluginConfigurationRequest" })

/** Decoded compare-and-swap plugin configuration update. */
export type PatchPluginConfigurationRequest = typeof PatchPluginConfigurationRequest.Type

/** Secret-free plugin connection row used by navigation and portfolio views. */
export const PluginConnectionSummary = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  providerId: ProviderId,
  displayName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  isEnabled: Schema.Boolean,
  health: Schema.NullOr(PluginHealth),
  updatedAt: UtcTimestamp
}).annotate({ identifier: "PluginConnectionSummary" })

/** Decoded plugin connection summary. */
export type PluginConnectionSummary = typeof PluginConnectionSummary.Type

const CatalogFieldText = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500))

/** Secret-free setup field shown before a first-party provider has runtime state. */
export const PluginServiceCatalogField = Schema.Struct({
  key: PluginConfigurationKey,
  label: CatalogFieldText,
  description: CatalogFieldText,
  kind: Schema.Literals(["text", "url", "integer", "secret"]),
  scope: Schema.Literals(["adapter", "credential"]),
  required: Schema.Boolean,
  defaultValue: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_096))),
  isReadOnly: Schema.Boolean,
  minimum: Schema.NullOr(Schema.Int),
  maximum: Schema.NullOr(Schema.Int)
}).annotate({ identifier: "PluginServiceCatalogField" })

/** Decoded safe setup metadata for one catalog field. */
export type PluginServiceCatalogField = typeof PluginServiceCatalogField.Type

/** One fixed first-party service available whether or not it is configured. */
export const PluginServiceCatalogEntry = Schema.Struct({
  providerId: ProviderId,
  displayName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
  configurationFields: Schema.Array(PluginServiceCatalogField).check(
    Schema.isNonEmpty(),
    Schema.makeFilter((fields) => fields.length <= MAXIMUM_CONFIGURATION_VALUES, {
      expected: `at most ${MAXIMUM_CONFIGURATION_VALUES} catalog configuration fields`
    })
  )
}).annotate({ identifier: "PluginServiceCatalogEntry" })

/** Decoded safe metadata for one fixed first-party service. */
export type PluginServiceCatalogEntry = typeof PluginServiceCatalogEntry.Type

/** Bounded plugin-navigation overview with the fixed catalog and durable connections. */
export const PluginListResponse = Schema.Struct({
  catalog: Schema.Array(PluginServiceCatalogEntry).check(
    Schema.makeFilter((entries) => entries.length === 5, { expected: "the five first-party services" })
  ),
  connections: Schema.Array(PluginConnectionSummary).check(
    Schema.makeFilter((plugins) => plugins.length <= MAXIMUM_PLUGIN_CONNECTIONS, {
      expected: `at most ${MAXIMUM_PLUGIN_CONNECTIONS} plugin connections`
    })
  )
}).annotate({ identifier: "PluginListResponse" })

/** Decoded bounded plugin list. */
export type PluginListResponse = typeof PluginListResponse.Type

const createValueFields = { key: PluginConfigurationKey }

/** Typed setup input; only the secret variant carries transport-only secret text. */
export const CreatePluginConnectionValue = Schema.Union([
  Schema.TaggedStruct("text", { ...createValueFields, value: BoundedConfigurationText }),
  Schema.TaggedStruct("url", { ...createValueFields, value: BoundedConfigurationUrl }),
  Schema.TaggedStruct("integer", { ...createValueFields, value: Schema.Int }),
  Schema.TaggedStruct("secret", {
    ...createValueFields,
    value: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAXIMUM_SECRET_VALUE_LENGTH))
  })
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded typed value for first-party connection setup. */
export type CreatePluginConnectionValue = typeof CreatePluginConnectionValue.Type

/** Bounded owner request to create, configure, enable, and immediately test a connection. */
export const CreatePluginConnectionRequest = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  providerId: ProviderId,
  displayName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  values: boundedConfigurationValues(CreatePluginConnectionValue)
}).annotate({ identifier: "CreatePluginConnectionRequest" })

/** Decoded request for first-party connection setup. */
export type CreatePluginConnectionRequest = typeof CreatePluginConnectionRequest.Type

/** Current health for one authenticated plugin connection lookup. */
export const PluginHealthResponse = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  health: PluginHealth
}).annotate({ identifier: "PluginHealthResponse" })

/** Decoded plugin health response. */
export type PluginHealthResponse = typeof PluginHealthResponse.Type

const ConnectionIdentityText = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512)
)

/** Secret-free provider identity proven by a live connection test. */
export const PluginConnectionIdentity = Schema.Struct({
  kind: Schema.Literals(["user", "account", "workspace"]),
  label: ConnectionIdentityText,
  displayName: ConnectionIdentityText,
  providerImmutableId: ConnectionIdentityText
}).annotate({ identifier: "PluginConnectionIdentity" })

/** Decoded provider identity proven by a live connection test. */
export type PluginConnectionIdentity = typeof PluginConnectionIdentity.Type

const connectionTestTiming = {
  pluginConnectionId: PluginConnectionId,
  providerId: ProviderId,
  checkedAt: UtcTimestamp,
  latencyMilliseconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}

/** Normalized result of live health and identity discovery against one connection. */
export const PluginConnectionTestResult = Schema.Union([
  Schema.TaggedStruct("healthy", {
    ...connectionTestTiming,
    identity: PluginConnectionIdentity
  }),
  Schema.TaggedStruct("failed", {
    ...connectionTestTiming,
    failureClass: PluginFailureClass,
    retryAt: Schema.NullOr(UtcTimestamp),
    safeMessage: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))
  })
]).pipe(Schema.toTaggedUnion("_tag"), Schema.annotate({ identifier: "PluginConnectionTestResult" }))

/** Decoded live connection test result. */
export type PluginConnectionTestResult = typeof PluginConnectionTestResult.Type

/** Redacted result of durable setup and its immediate live identity check. */
export const CreatePluginConnectionResponse = Schema.Struct({
  connection: PluginConnectionSummary,
  configuration: PluginConfiguration,
  test: PluginConnectionTestResult
}).annotate({ identifier: "CreatePluginConnectionResponse" })

/** Decoded redacted first-party connection setup response. */
export type CreatePluginConnectionResponse = typeof CreatePluginConnectionResponse.Type

/** Secret-free configuration contract exposed to settings views. */
export const PluginConfigurationMetadata = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  pluginId: PluginId,
  contractVersion: SemanticVersion,
  adapterVersion: SemanticVersion,
  configurationFields: Schema.Array(PluginConfigurationFieldV1).check(
    Schema.makeFilter((fields) => fields.length <= 100, { expected: "at most 100 configuration fields" })
  ),
  capabilities: Schema.Array(NegotiatedPluginCapabilityV1).check(
    Schema.makeFilter((capabilities) => capabilities.length <= 32, {
      expected: "at most 32 negotiated plugin capabilities"
    })
  )
}).annotate({ identifier: "PluginConfigurationMetadata" })

/** Decoded secret-free plugin configuration metadata. */
export type PluginConfigurationMetadata = typeof PluginConfigurationMetadata.Type

const pluginReadErrors = [
  UnauthorizedApiError,
  ForbiddenApiError,
  RateLimitedApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError
]

const list = HttpApiEndpoint.get("list", "/", {
  success: PluginListResponse,
  error: pluginReadErrors
}).middleware(SessionCookieAuth)

const createConnection = HttpApiEndpoint.post("createConnection", "/connections", {
  payload: CreatePluginConnectionRequest,
  success: CreatePluginConnectionResponse,
  error: [...pluginReadErrors, InvalidRequestApiError, NotFoundApiError, ConflictApiError, PayloadTooLargeApiError]
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const health = HttpApiEndpoint.get("health", "/:pluginConnectionId/health", {
  params: Schema.Struct({ pluginConnectionId: PluginConnectionId }),
  success: PluginHealthResponse,
  error: [...pluginReadErrors, NotFoundApiError]
}).middleware(SessionCookieAuth)

const testConnection = HttpApiEndpoint.post("testConnection", "/:pluginConnectionId/test", {
  params: Schema.Struct({ pluginConnectionId: PluginConnectionId }),
  success: PluginConnectionTestResult,
  error: [...pluginReadErrors, NotFoundApiError]
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const configurationMetadata = HttpApiEndpoint.get(
  "configurationMetadata",
  "/:pluginConnectionId/configuration-metadata",
  {
    params: Schema.Struct({ pluginConnectionId: PluginConnectionId }),
    success: PluginConfigurationMetadata,
    error: [...pluginReadErrors, NotFoundApiError]
  }
).middleware(SessionCookieAuth)

const configuration = HttpApiEndpoint.get("configuration", "/:pluginConnectionId/configuration", {
  params: Schema.Struct({ pluginConnectionId: PluginConnectionId }),
  success: PluginConfiguration,
  error: [...pluginReadErrors, NotFoundApiError]
}).middleware(SessionCookieAuth)

const patchConfiguration = HttpApiEndpoint.patch("patchConfiguration", "/:pluginConnectionId/configuration", {
  params: Schema.Struct({ pluginConnectionId: PluginConnectionId }),
  payload: PatchPluginConfigurationRequest,
  success: PluginConfiguration,
  error: [...pluginReadErrors, InvalidRequestApiError, NotFoundApiError, ConflictApiError, PayloadTooLargeApiError]
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

/** Authenticated plugin list, health, and secret-free configuration contract. */
export class PluginsApiGroup extends HttpApiGroup.make("plugins")
  .add(list, createConnection, health, testConnection, configurationMetadata, configuration, patchConfiguration)
  .prefix("/api/v1/plugins")
{}
