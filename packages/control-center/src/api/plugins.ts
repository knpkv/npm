import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import { PluginHealth } from "../domain/freshness.js"
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
const BoundedConfigurationText = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(4_096))

/** Secret-safe current value; secret fields reveal only whether a reference is configured. */
export const RedactedPluginConfigurationValue = Schema.Union([
  Schema.TaggedStruct("text", { ...configurationValueFields, value: BoundedConfigurationText }),
  Schema.TaggedStruct("url", { ...configurationValueFields, value: BoundedConfigurationText }),
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
  Schema.TaggedStruct("url", { ...configurationValueFields, value: BoundedConfigurationText }),
  Schema.TaggedStruct("boolean", { ...configurationValueFields, value: Schema.Boolean }),
  Schema.TaggedStruct("integer", { ...configurationValueFields, value: Schema.Int }),
  Schema.TaggedStruct("select", { ...configurationValueFields, value: BoundedConfigurationText }),
  Schema.TaggedStruct("secret-reference", {
    ...configurationValueFields,
    reference: Schema.NullOr(OpaqueSecretReference)
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

/** Bounded plugin-navigation and portfolio response. */
export const PluginListResponse = Schema.Array(PluginConnectionSummary).check(
  Schema.makeFilter((plugins) => plugins.length <= MAXIMUM_PLUGIN_CONNECTIONS, {
    expected: `at most ${MAXIMUM_PLUGIN_CONNECTIONS} plugin connections`
  })
)

/** Decoded bounded plugin list. */
export type PluginListResponse = typeof PluginListResponse.Type

/** Current health for one authenticated plugin connection lookup. */
export const PluginHealthResponse = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  health: PluginHealth
}).annotate({ identifier: "PluginHealthResponse" })

/** Decoded plugin health response. */
export type PluginHealthResponse = typeof PluginHealthResponse.Type

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

const health = HttpApiEndpoint.get("health", "/:pluginConnectionId/health", {
  params: Schema.Struct({ pluginConnectionId: PluginConnectionId }),
  success: PluginHealthResponse,
  error: [...pluginReadErrors, NotFoundApiError]
}).middleware(SessionCookieAuth)

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
  .add(list, health, configurationMetadata, configuration, patchConfiguration)
  .prefix("/api/v1/plugins")
{}
