import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import { PluginFailureClass, PluginHealth } from "../domain/freshness.js"
import { FollowedResourceId, PluginConnectionId, ProviderAccountId } from "../domain/identifiers.js"
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
const MAXIMUM_PROVIDER_ACCOUNTS = 100
const MAXIMUM_FOLLOWED_RESOURCES = 100
const MAXIMUM_DISCOVERED_AWS_PROFILES = 100
const MAXIMUM_DISCOVERED_ATLASSIAN_PROFILES = 100
const MAXIMUM_ATLASSIAN_OAUTH_SITES = 100
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
const AtlassianCloudSiteUrl = BoundedConfigurationUrl.check(
  Schema.makeFilter((value: string) => {
    const decoded = Schema.decodeUnknownResult(Schema.URLFromString)(value)
    if (Result.isFailure(decoded)) return false
    const url = decoded.success
    return (
      url.protocol === "https:" &&
      url.port.length === 0 &&
      url.hostname.endsWith(".atlassian.net") &&
      url.hostname.length > ".atlassian.net".length &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search.length === 0
    )
  }, { expected: "an HTTPS Atlassian Cloud site root" })
)

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
const NullableProviderAccountId = Schema.NullOr(ProviderAccountId)
const NullableFollowedResourceId = Schema.NullOr(FollowedResourceId)

export const PluginConnectionSummary = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  providerAccountId: Schema.optional(NullableProviderAccountId).pipe(
    Schema.decodeTo(Schema.toType(NullableProviderAccountId), {
      decode: SchemaGetter.withDefault(Effect.succeed<typeof NullableProviderAccountId.Type>(null)),
      encode: SchemaGetter.required()
    })
  ),
  followedResourceId: Schema.optional(NullableFollowedResourceId).pipe(
    Schema.decodeTo(Schema.toType(NullableFollowedResourceId), {
      decode: SchemaGetter.withDefault(Effect.succeed<typeof NullableFollowedResourceId.Type>(null)),
      encode: SchemaGetter.required()
    })
  ),
  providerId: ProviderId,
  displayName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  isEnabled: Schema.Boolean,
  health: Schema.NullOr(PluginHealth),
  updatedAt: UtcTimestamp
}).annotate({ identifier: "PluginConnectionSummary" })

/** Decoded plugin connection summary. */
export type PluginConnectionSummary = typeof PluginConnectionSummary.Type

/** Secret-free provider resource shown inside its owning account. */
export const FollowedResourceSummary = Schema.Struct({
  followedResourceId: FollowedResourceId,
  providerId: ProviderId,
  displayName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  providerImmutableId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)),
  isEnabled: Schema.Boolean
}).annotate({ identifier: "FollowedResourceSummary" })

/** Decoded followed-resource overview. */
export type FollowedResourceSummary = typeof FollowedResourceSummary.Type

/** One provider account and the resources this workspace follows within it. */
export const ProviderAccountSummary = Schema.Struct({
  providerAccountId: ProviderAccountId,
  providerFamily: Schema.Literals(["aws", "atlassian", "clockify"]),
  displayName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  providerImmutableId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)),
  resources: Schema.Array(FollowedResourceSummary).check(
    Schema.makeFilter((resources) => resources.length <= MAXIMUM_FOLLOWED_RESOURCES, {
      expected: `at most ${MAXIMUM_FOLLOWED_RESOURCES} followed resources per provider account`
    })
  )
}).annotate({ identifier: "ProviderAccountSummary" })

/** Decoded provider-account overview. */
export type ProviderAccountSummary = typeof ProviderAccountSummary.Type

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

/** One local AWS CLI profile available to first-party AWS adapters. */
export const DiscoveredAwsProfile = Schema.Struct({
  profile: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  region: Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)))
}).annotate({ identifier: "DiscoveredAwsProfile" })

/** Decoded local AWS profile metadata; credentials never cross this contract. */
export type DiscoveredAwsProfile = typeof DiscoveredAwsProfile.Type

/** Bounded local AWS profile discovery response. */
export const AwsProfileDiscoveryResponse = Schema.Array(DiscoveredAwsProfile).check(
  Schema.makeFilter((profiles) => profiles.length <= MAXIMUM_DISCOVERED_AWS_PROFILES, {
    expected: `at most ${MAXIMUM_DISCOVERED_AWS_PROFILES} discovered AWS profiles`
  })
)

/** Decoded bounded AWS profile discovery response. */
export type AwsProfileDiscoveryResponse = typeof AwsProfileDiscoveryResponse.Type

/** One local OAuth profile available to first-party Atlassian adapters. */
export const DiscoveredAtlassianProfile = Schema.Struct({
  profileId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
  siteUrl: BoundedConfigurationUrl,
  cloudId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
  accountName: Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500))),
  accountEmail: Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500))),
  status: Schema.Literals(["valid", "expired"]),
  providers: Schema.Array(Schema.Literals(["jira", "confluence"])).check(Schema.isNonEmpty())
}).annotate({ identifier: "DiscoveredAtlassianProfile" })

/** Decoded secret-free metadata for one local Atlassian OAuth profile. */
export type DiscoveredAtlassianProfile = typeof DiscoveredAtlassianProfile.Type

/** Bounded local Atlassian OAuth profile discovery response. */
export const AtlassianProfileDiscoveryResponse = Schema.Array(DiscoveredAtlassianProfile).check(
  Schema.makeFilter((profiles) => profiles.length <= MAXIMUM_DISCOVERED_ATLASSIAN_PROFILES, {
    expected: `at most ${MAXIMUM_DISCOVERED_ATLASSIAN_PROFILES} discovered Atlassian profiles`
  })
)

/** Decoded bounded local Atlassian profile discovery response. */
export type AtlassianProfileDiscoveryResponse = typeof AtlassianProfileDiscoveryResponse.Type

/** Single-use browser OAuth grant identifier; it is also the provider state parameter. */
export const AtlassianOAuthGrantId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u, { expected: "a base64url-encoded 256-bit OAuth state" })
).pipe(Schema.brand("AtlassianOAuthGrantId"))

/** Decoded single-use Atlassian OAuth grant identifier. */
export type AtlassianOAuthGrantId = typeof AtlassianOAuthGrantId.Type

/** Atlassian product requested by one browser OAuth grant. */
export const AtlassianOAuthProvider = Schema.Literals(["jira", "confluence"])

/** Decoded Atlassian product requested by OAuth. */
export type AtlassianOAuthProvider = typeof AtlassianOAuthProvider.Type

/** One or both distinct Atlassian products requested by an OAuth grant. */
export const AtlassianOAuthProviderIntent = Schema.Array(AtlassianOAuthProvider).check(
  Schema.isNonEmpty(),
  Schema.makeFilter((providers) => providers.length <= 2, { expected: "at most two Atlassian OAuth providers" }),
  Schema.makeFilter((providers) => new Set(providers).size === providers.length, {
    expected: "distinct Atlassian OAuth providers"
  })
)

/** Decoded one- or two-product Atlassian OAuth intent. */
export type AtlassianOAuthProviderIntent = typeof AtlassianOAuthProviderIntent.Type

/** Owner request to start OAuth for the products currently being configured. */
export const CreateAtlassianOAuthGrantRequest = Schema.Struct({
  providers: AtlassianOAuthProviderIntent
}).annotate({ identifier: "CreateAtlassianOAuthGrantRequest" })

/** Decoded owner request to start OAuth for the products currently being configured. */
export type CreateAtlassianOAuthGrantRequest = typeof CreateAtlassianOAuthGrantRequest.Type

/** Safe result of preparing the browser authorization redirect. */
export const AtlassianOAuthGrantStartResponse = Schema.Union([
  Schema.TaggedStruct("ready", {
    authorizationUrl: Schema.String.check(isProviderHttpUrl),
    callbackUrl: BoundedConfigurationUrl
  }),
  Schema.TaggedStruct("configuration-required", { callbackUrl: BoundedConfigurationUrl })
]).pipe(Schema.toTaggedUnion("_tag"), Schema.annotate({ identifier: "AtlassianOAuthGrantStartResponse" }))

/** Decoded browser authorization preparation result. */
export type AtlassianOAuthGrantStartResponse = typeof AtlassianOAuthGrantStartResponse.Type

/** Authorization code returned by Atlassian to the same authenticated browser. */
export const ExchangeAtlassianOAuthGrantRequest = Schema.Struct({
  code: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_096))
}).annotate({ identifier: "ExchangeAtlassianOAuthGrantRequest" })

/** One accessible Atlassian site awaiting explicit selection. */
export const AtlassianOAuthSite = Schema.Struct({
  cloudId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
  siteUrl: AtlassianCloudSiteUrl
}).annotate({ identifier: "AtlassianOAuthSite" })

/** Secret-free account and site choices returned after code exchange. */
export const AtlassianOAuthGrantExchangeResponse = Schema.Struct({
  grantId: AtlassianOAuthGrantId,
  accountName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
  accountEmail: Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500))),
  sites: Schema.Array(AtlassianOAuthSite).check(
    Schema.isNonEmpty(),
    Schema.makeFilter((sites) => sites.length <= MAXIMUM_ATLASSIAN_OAUTH_SITES, {
      expected: `at most ${MAXIMUM_ATLASSIAN_OAUTH_SITES} accessible Atlassian sites`
    })
  )
}).annotate({ identifier: "AtlassianOAuthGrantExchangeResponse" })

/** Decoded secret-free site-selection state. */
export type AtlassianOAuthGrantExchangeResponse = typeof AtlassianOAuthGrantExchangeResponse.Type

/** Explicit site choice that completes a pending browser OAuth grant. */
export const CompleteAtlassianOAuthGrantRequest = Schema.Struct({
  cloudId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500))
}).annotate({ identifier: "CompleteAtlassianOAuthGrantRequest" })

/** Bounded plugin-navigation and portfolio response retained for v1 clients. */
export const PluginListResponse = Schema.Array(PluginConnectionSummary).check(
  Schema.makeFilter((plugins) => plugins.length <= MAXIMUM_PLUGIN_CONNECTIONS, {
    expected: `at most ${MAXIMUM_PLUGIN_CONNECTIONS} plugin connections`
  })
)

/** Decoded bounded plugin list. */
export type PluginListResponse = typeof PluginListResponse.Type

const ProviderAccountSummaries = Schema.Array(ProviderAccountSummary).check(
  Schema.makeFilter((accounts) => accounts.length <= MAXIMUM_PROVIDER_ACCOUNTS, {
    expected: `at most ${MAXIMUM_PROVIDER_ACCOUNTS} provider accounts`
  })
)

/** Bounded Services overview with the fixed catalog and durable connections. */
export const PluginOverviewResponse = Schema.Struct({
  catalog: Schema.Array(PluginServiceCatalogEntry).check(
    Schema.makeFilter((entries) => entries.length === 5, { expected: "the five first-party services" })
  ),
  connections: Schema.Array(PluginConnectionSummary).check(
    Schema.makeFilter((plugins) => plugins.length <= MAXIMUM_PLUGIN_CONNECTIONS, {
      expected: `at most ${MAXIMUM_PLUGIN_CONNECTIONS} plugin connections`
    })
  ),
  accounts: Schema.optional(ProviderAccountSummaries).pipe(
    Schema.decodeTo(Schema.toType(ProviderAccountSummaries), {
      decode: SchemaGetter.withDefault(Effect.succeed<typeof ProviderAccountSummaries.Type>([])),
      encode: SchemaGetter.required()
    })
  )
}).annotate({ identifier: "PluginOverviewResponse" })

/** Decoded bounded Services overview. */
export type PluginOverviewResponse = typeof PluginOverviewResponse.Type

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

const MAXIMUM_BATCH_PLUGIN_CONNECTIONS = 40

/** Bounded setup batch owned by one authenticated workspace. */
export const CreatePluginConnectionsRequest = Schema.Struct({
  connections: Schema.Array(CreatePluginConnectionRequest).check(
    Schema.makeFilter(
      (connections) => connections.length >= 1 && connections.length <= MAXIMUM_BATCH_PLUGIN_CONNECTIONS,
      { expected: `between 1 and ${MAXIMUM_BATCH_PLUGIN_CONNECTIONS} plugin connections` }
    ),
    Schema.makeFilter(
      (connections) =>
        new Set(connections.map(({ pluginConnectionId }) => pluginConnectionId)).size === connections.length,
      { expected: "unique plugin connection identifiers" }
    )
  )
}).annotate({ identifier: "CreatePluginConnectionsRequest" })

/** Decoded bounded multi-connection setup request. */
export type CreatePluginConnectionsRequest = typeof CreatePluginConnectionsRequest.Type

export const PluginConnectionSetupFailureClass = Schema.Literals([
  "conflict",
  "invalid-request",
  "not-found",
  "rate-limited",
  "service-unavailable"
])

/** Safe classification for one failed setup item. */
export type PluginConnectionSetupFailureClass = typeof PluginConnectionSetupFailureClass.Type

/** One ordered result from a multi-connection setup request. */
export const CreatePluginConnectionBatchResult = Schema.Union([
  Schema.TaggedStruct("succeeded", { response: CreatePluginConnectionResponse }),
  Schema.TaggedStruct("failed", {
    pluginConnectionId: PluginConnectionId,
    failureClass: PluginConnectionSetupFailureClass
  })
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded result for one connection in a setup batch. */
export type CreatePluginConnectionBatchResult = typeof CreatePluginConnectionBatchResult.Type

/** Ordered redacted results for a bounded setup batch. */
export const CreatePluginConnectionsResponse = Schema.Struct({
  results: Schema.Array(CreatePluginConnectionBatchResult).check(
    Schema.makeFilter(
      (results) => results.length >= 1 && results.length <= MAXIMUM_BATCH_PLUGIN_CONNECTIONS,
      { expected: `between 1 and ${MAXIMUM_BATCH_PLUGIN_CONNECTIONS} plugin connection results` }
    )
  )
}).annotate({ identifier: "CreatePluginConnectionsResponse" })

/** Decoded ordered multi-connection setup response. */
export type CreatePluginConnectionsResponse = typeof CreatePluginConnectionsResponse.Type

/** Owner-only transition for independently enabling or disabling one connection. */
export const SetPluginConnectionEnabledRequest = Schema.Struct({
  isEnabled: Schema.Boolean
}).annotate({ identifier: "SetPluginConnectionEnabledRequest" })

/** Decoded connection enablement transition. */
export type SetPluginConnectionEnabledRequest = typeof SetPluginConnectionEnabledRequest.Type

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

const overview = HttpApiEndpoint.get("overview", "/overview", {
  success: PluginOverviewResponse,
  error: pluginReadErrors
}).middleware(SessionCookieAuth)

const discoverAwsProfiles = HttpApiEndpoint.get("discoverAwsProfiles", "/discovery/aws-profiles", {
  success: AwsProfileDiscoveryResponse,
  error: pluginReadErrors
}).middleware(SessionCookieAuth)

const discoverAtlassianProfiles = HttpApiEndpoint.get(
  "discoverAtlassianProfiles",
  "/discovery/atlassian-profiles",
  {
    success: AtlassianProfileDiscoveryResponse,
    error: pluginReadErrors
  }
).middleware(SessionCookieAuth)

const createAtlassianOAuthGrant = HttpApiEndpoint.post(
  "createAtlassianOAuthGrant",
  "/oauth/atlassian/grants",
  {
    payload: CreateAtlassianOAuthGrantRequest,
    success: AtlassianOAuthGrantStartResponse,
    error: [...pluginReadErrors, InvalidRequestApiError, ConflictApiError]
  }
)
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const exchangeAtlassianOAuthGrant = HttpApiEndpoint.post(
  "exchangeAtlassianOAuthGrant",
  "/oauth/atlassian/grants/:grantId/exchange",
  {
    params: Schema.Struct({ grantId: AtlassianOAuthGrantId }),
    payload: ExchangeAtlassianOAuthGrantRequest,
    success: AtlassianOAuthGrantExchangeResponse,
    error: [...pluginReadErrors, InvalidRequestApiError, NotFoundApiError, ConflictApiError]
  }
)
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const completeAtlassianOAuthGrant = HttpApiEndpoint.post(
  "completeAtlassianOAuthGrant",
  "/oauth/atlassian/grants/:grantId/complete",
  {
    params: Schema.Struct({ grantId: AtlassianOAuthGrantId }),
    payload: CompleteAtlassianOAuthGrantRequest,
    success: DiscoveredAtlassianProfile,
    error: [...pluginReadErrors, InvalidRequestApiError, NotFoundApiError, ConflictApiError]
  }
)
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const createConnection = HttpApiEndpoint.post("createConnection", "/connections", {
  payload: CreatePluginConnectionRequest,
  success: CreatePluginConnectionResponse,
  error: [...pluginReadErrors, InvalidRequestApiError, NotFoundApiError, ConflictApiError, PayloadTooLargeApiError]
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const createConnections = HttpApiEndpoint.post("createConnections", "/connections/batch", {
  payload: CreatePluginConnectionsRequest,
  success: CreatePluginConnectionsResponse,
  error: [...pluginReadErrors, InvalidRequestApiError, ConflictApiError, PayloadTooLargeApiError]
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const setConnectionEnabled = HttpApiEndpoint.patch("setConnectionEnabled", "/connections/:pluginConnectionId", {
  params: Schema.Struct({ pluginConnectionId: PluginConnectionId }),
  payload: SetPluginConnectionEnabledRequest,
  success: PluginConnectionSummary,
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
  .add(
    list,
    overview,
    discoverAwsProfiles,
    discoverAtlassianProfiles,
    createAtlassianOAuthGrant,
    exchangeAtlassianOAuthGrant,
    completeAtlassianOAuthGrant,
    createConnection,
    createConnections,
    setConnectionEnabled,
    health,
    testConnection,
    configurationMetadata,
    configuration,
    patchConfiguration
  )
  .prefix("/api/v1/plugins")
{}
