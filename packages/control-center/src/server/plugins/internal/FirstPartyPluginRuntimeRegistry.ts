import { HomeDirectoryLive } from "@knpkv/atlassian-common/profile-storage"
import { ClockifyApiClient, ClockifyApiConfig } from "@knpkv/clockify-api-client"
import { AwsClientConfig, ReadClient } from "@knpkv/codecommit-core"
import { ConfluenceApiClient, ConfluenceApiConfig } from "@knpkv/confluence-api-client"
import {
  AdfSchemaValidatorLayer,
  AtlaskitTransformersLayer,
  MarkdownConverterLayer
} from "@knpkv/confluence-to-markdown"
import { JiraApiClient, JiraApiConfig, type JiraApiConfigShape } from "@knpkv/jira-api-client"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"

import { NegotiatedPluginDescriptorV1 } from "../../../domain/plugins/descriptor.js"
import type { ProviderId } from "../../../domain/sourceRevision.js"
import { Persistence } from "../../persistence/Persistence.js"
import type { StoredPluginConfiguration } from "../../persistence/repositories/pluginConfigurationModels.js"
import type { PluginRuntimeRecord } from "../../persistence/repositories/pluginRuntimeModels.js"
import type { SecretRef } from "../../secrets/SecretRef.js"
import { SecretStore } from "../../secrets/SecretStore.js"
import { loadAtlassianProfile } from "../atlassian/AtlassianProfiles.js"
import { AtlassianBasicAuthEmail } from "../AtlassianBasicAuth.js"
import {
  ClockifyReadPluginConfiguration,
  clockifyReadPluginDescriptor,
  makeClockifyReadPluginRuntime
} from "../clockify/ClockifyReadPlugin.js"
import { codeCommitPluginDefinition } from "../codecommit/CodeCommitPluginDefinition.js"
import { codePipelinePluginDefinition } from "../codepipeline/CodePipelinePluginDefinition.js"
import { CodePipelineReadClient } from "../codepipeline/CodePipelineReadClient.js"
import { ConfluencePageAdapterConfiguration } from "../confluence/ConfluencePageAdapter.js"
import { confluencePageClientLayer } from "../confluence/ConfluencePageClient.js"
import {
  confluencePagePluginDefinition,
  confluencePagePluginDescriptor
} from "../confluence/ConfluencePagePluginDefinition.js"
import { PluginConfigurationFailure, PluginUnsupportedCapabilityFailure } from "../failures.js"
import {
  JiraReadPluginConfiguration,
  jiraReadPluginDescriptor,
  makeJiraReadPluginRuntime
} from "../jira/JiraReadPlugin.js"
import { negotiatePluginDescriptorV1 } from "../negotiation.js"
import type { PluginRuntimeScope } from "../PluginConnectionMap.js"
import { buildPluginDefinitionLayer } from "../PluginDefinition.js"
import { AuthorizedPluginExecutor } from "./AuthorizedPluginExecutor.js"
import {
  PluginRuntimeAccountDigest,
  PluginRuntimeAuthority,
  PluginRuntimeAuthorityToken
} from "./PluginRuntimeAuthority.js"
import { PluginRuntimeRegistry, type PluginRuntimeRegistryV1 } from "./PluginRuntimeRegistry.js"

const CLOCKIFY_API_ORIGIN = "https://api.clockify.me/api"
const readOnlyExecutorLayer = Layer.succeed(AuthorizedPluginExecutor, {
  preflight: () =>
    Effect.fail(
      new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.execute",
        requestedVersion: 1,
        diagnosticCode: "first-party-runtime-read-only"
      })
    ),
  executeAuthorizedAction: () =>
    Effect.fail(
      new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.execute",
        requestedVersion: 1,
        diagnosticCode: "first-party-runtime-read-only"
      })
    ),
  requestCancellation: () =>
    Effect.fail(
      new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.cancel",
        requestedVersion: 1,
        diagnosticCode: "first-party-runtime-read-only"
      })
    ),
  reconcile: () =>
    Effect.fail(
      new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.reconcile",
        requestedVersion: 1,
        diagnosticCode: "first-party-runtime-read-only"
      })
    )
})

type Configuration = StoredPluginConfiguration
type ConfigurationValue = Configuration[number]

interface LoadedRuntime {
  readonly configuration: Configuration
  readonly configurationDigest: string
  readonly configurationRevision: number
  readonly connectionRevision: number
  readonly descriptor: NegotiatedPluginDescriptorV1
  readonly descriptorGeneration: "current" | "legacy-atlassian"
  readonly runtime: PluginRuntimeRecord
}

const configurationFailure = (diagnosticCode: string): PluginConfigurationFailure =>
  new PluginConfigurationFailure({ diagnosticCode })

const mapConfigurationFailure = <Success, Failure, Requirements>(
  diagnosticCode: string,
  effect: Effect.Effect<Success, Failure, Requirements>
): Effect.Effect<Success, PluginConfigurationFailure, Requirements> =>
  Effect.catch(effect, () => Effect.fail(configurationFailure(diagnosticCode)))

const findValue = (configuration: Configuration, key: string): ConfigurationValue | undefined =>
  configuration.find((value) => value.key === key)

const textValue = (
  configuration: Configuration,
  key: string,
  tag: "text" | "url" = "text"
): Effect.Effect<string, PluginConfigurationFailure> => {
  const value = findValue(configuration, key)
  return value?._tag === tag
    ? Effect.succeed(value.value)
    : Effect.fail(configurationFailure(`plugin-configuration-${key}-invalid`))
}

const integerValue = (
  configuration: Configuration,
  key: string
): Effect.Effect<number, PluginConfigurationFailure> => {
  const value = findValue(configuration, key)
  return value?._tag === "integer"
    ? Effect.succeed(value.value)
    : Effect.fail(configurationFailure(`plugin-configuration-${key}-invalid`))
}

const secretValue = (
  configuration: Configuration,
  key: string
): Effect.Effect<SecretRef, PluginConfigurationFailure> => {
  const value = findValue(configuration, key)
  return value?._tag === "secret-reference"
    ? Effect.succeed(value.ref)
    : Effect.fail(configurationFailure(`plugin-configuration-${key}-invalid`))
}

const requireExactKeys = (
  configuration: Configuration,
  expectedKeys: ReadonlySet<string>
): Effect.Effect<void, PluginConfigurationFailure> =>
  configuration.length === expectedKeys.size && configuration.every(({ key }) => expectedKeys.has(key))
    ? Effect.void
    : Effect.fail(configurationFailure("plugin-configuration-keys-invalid"))

const decodeSecret = Effect.fn("FirstPartyPluginRuntime.decodeSecret")(function*(ref: SecretRef) {
  const secrets = yield* SecretStore
  const lease = yield* mapConfigurationFailure("plugin-credential-unavailable", secrets.resolve(ref))
  return yield* lease.withBytes((bytes) =>
    Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => configurationFailure("plugin-credential-encoding-invalid")
    }).pipe(
      Effect.filterOrFail(
        (value) => value.length > 0,
        () => configurationFailure("plugin-credential-empty")
      )
    )
  )
})

const credentialTextValue = Effect.fn("FirstPartyPluginRuntime.credentialTextValue")(function*(
  configuration: Configuration,
  key: string
) {
  const value = findValue(configuration, key)
  if (value?._tag === "text") {
    return { generation: "legacy-text", value: value.value }
  }
  if (value?._tag === "secret-reference") {
    return { generation: value.ref, value: yield* decodeSecret(value.ref) }
  }
  return yield* configurationFailure(`plugin-configuration-${key}-invalid`)
})

const decodeDescriptor = (
  runtime: PluginRuntimeRecord
): Effect.Effect<NegotiatedPluginDescriptorV1, PluginConfigurationFailure> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(NegotiatedPluginDescriptorV1))(
    runtime.descriptorJson
  ).pipe(Effect.mapError(() => configurationFailure("plugin-runtime-descriptor-invalid")))

const expectedDescriptor = (providerId: ProviderId): unknown => {
  switch (providerId) {
    case "codecommit":
      return codeCommitPluginDefinition.rawDescriptor
    case "codepipeline":
      return codePipelinePluginDefinition.rawDescriptor
    case "jira":
      return jiraReadPluginDescriptor
    case "confluence":
      return confluencePagePluginDescriptor
    case "clockify":
      return clockifyReadPluginDescriptor
  }
}

const jiraDescriptorSnapshot = (configurationFields: ReadonlyArray<unknown>) => ({
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.jira.read",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  displayName: "Jira issue reader",
  configurationFields,
  capabilities: [{ capabilityId: "entity.read", supportedVersions: [1], requirement: "required" }]
})

const jiraWebBaseUrlField = {
  _tag: "url",
  key: "webBaseUrl",
  label: "Jira site URL",
  description: "HTTPS Jira Cloud tenant root URL under atlassian.net, without query or credentials.",
  required: true
}
const jiraSiteIdField = {
  _tag: "text",
  key: "siteId",
  label: "Site ID",
  description: "Stable Atlassian cloud identity, discovered automatically by OAuth.",
  required: true
}
const jiraOAuthFields = [
  {
    _tag: "text",
    key: "authMode",
    label: "Authentication",
    description: "OAuth profile or API token fallback.",
    required: true
  },
  {
    _tag: "text",
    key: "oauthProfileId",
    label: "OAuth profile",
    description: "Shared local Atlassian OAuth profile identifier.",
    required: false
  },
  {
    _tag: "text",
    key: "email",
    label: "Account email",
    description: "Atlassian account email used only for API token fallback.",
    required: false
  },
  {
    _tag: "secret-reference",
    key: "apiToken",
    label: "API token",
    description: "Owner-only Atlassian API token resolved only for the scoped runtime.",
    required: false,
    secretKind: "token"
  }
]
const jiraLegacyCredentialFields = [
  {
    _tag: "text",
    key: "email",
    label: "Account email",
    description: "Atlassian account email used for Jira Cloud basic authentication.",
    required: true
  },
  { ...jiraOAuthFields[3], required: true }
]
const jiraReaderFields = [
  {
    _tag: "integer",
    key: "pageSize",
    label: "Activity page size",
    description: "Comments and history entries requested per Jira page.",
    required: true,
    minimum: 1,
    maximum: 50
  },
  {
    _tag: "integer",
    key: "maximumPages",
    label: "Maximum activity pages",
    description: "Hard request limit for comments and history independently.",
    required: true,
    minimum: 1,
    maximum: 5
  },
  {
    _tag: "integer",
    key: "operationTimeoutMillis",
    label: "Request timeout",
    description: "Maximum milliseconds for each Jira provider request.",
    required: true,
    minimum: 1_000,
    maximum: 120_000
  }
]
const historicalJiraDescriptors = [
  jiraDescriptorSnapshot([jiraWebBaseUrlField, ...jiraLegacyCredentialFields, ...jiraReaderFields]),
  jiraDescriptorSnapshot([jiraWebBaseUrlField, ...jiraOAuthFields, ...jiraReaderFields]),
  jiraDescriptorSnapshot([jiraWebBaseUrlField, jiraSiteIdField, ...jiraOAuthFields, ...jiraReaderFields])
]

const legacyConfluenceDescriptor = () => {
  const descriptor = confluencePagePluginDescriptor
  return {
    ...descriptor,
    configurationFields: descriptor.configurationFields.flatMap((field) => {
      if (field.key === "authMode" || field.key === "oauthProfileId") return []
      if (field.key !== "email") return [{ ...field, required: field.key === "apiToken" ? true : field.required }]
      return [{
        ...field,
        description: "Atlassian account email used for Confluence Cloud basic authentication.",
        required: true
      }]
    })
  }
}

const expectedDescriptors = (providerId: ProviderId): ReadonlyArray<unknown> => {
  if (providerId === "jira") return [jiraReadPluginDescriptor, ...historicalJiraDescriptors]
  if (providerId === "confluence") return [confluencePagePluginDescriptor, legacyConfluenceDescriptor()]
  return [expectedDescriptor(providerId)]
}

const loadRuntime = Effect.fn("FirstPartyPluginRuntime.load")(function*(scope: PluginRuntimeScope) {
  const persistence = yield* Persistence
  const connection = yield* mapConfigurationFailure(
    "plugin-connection-unavailable",
    persistence.pluginConnections.get(scope.workspaceId, scope.pluginConnectionId)
  )
  if (!connection.isEnabled) {
    return yield* configurationFailure("plugin-connection-disabled")
  }
  const configurationOption = yield* mapConfigurationFailure(
    "plugin-configuration-unavailable",
    persistence.pluginConfigurations.get(scope.workspaceId, scope.pluginConnectionId)
  )
  if (Option.isNone(configurationOption)) {
    return yield* configurationFailure("plugin-configuration-missing")
  }
  const runtime = yield* mapConfigurationFailure(
    "plugin-runtime-unavailable",
    persistence.pluginRuntime.getRuntime(scope.workspaceId, scope.pluginConnectionId)
  )
  const descriptor = yield* decodeDescriptor(runtime)
  const expected = yield* Effect.forEach(expectedDescriptors(connection.providerId), negotiatePluginDescriptorV1)
  const descriptorGeneration = expected.findIndex(
    (candidate) => JSON.stringify(descriptor) === JSON.stringify(candidate)
  )
  if (
    runtime.providerId !== connection.providerId ||
    runtime.descriptorSchemaVersion !== descriptor.descriptor.contractVersion.major ||
    descriptorGeneration < 0
  ) {
    return yield* configurationFailure("plugin-runtime-source-mismatch")
  }
  return {
    configuration: configurationOption.value.values,
    configurationDigest: configurationOption.value.configurationDigest,
    configurationRevision: configurationOption.value.revision,
    connectionRevision: connection.revision,
    descriptor,
    descriptorGeneration: descriptorGeneration === 0 ? "current" : "legacy-atlassian",
    runtime
  } satisfies LoadedRuntime
})

const runtimeDigest = Effect.fn("FirstPartyPluginRuntime.digest")(function*(value: string) {
  const cryptoService = yield* Crypto.Crypto
  const bytes = yield* Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(value))).pipe(
    Effect.mapError(() => configurationFailure("plugin-runtime-authority-encoding-failed"))
  )
  const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
    Effect.mapError(() => configurationFailure("plugin-runtime-authority-digest-failed"))
  )
  return Encoding.encodeHex(digest)
})

const authorityLayer = Effect.fn("FirstPartyPluginRuntime.authorityLayer")(function*(
  scope: PluginRuntimeScope,
  loaded: LoadedRuntime,
  credentialGeneration: string
) {
  const source = JSON.stringify([
    scope.workspaceId,
    scope.pluginConnectionId,
    loaded.runtime.providerId,
    loaded.connectionRevision,
    loaded.configurationRevision,
    loaded.configurationDigest,
    loaded.runtime.revision,
    loaded.runtime.descriptorGeneration,
    loaded.runtime.descriptorDigest,
    credentialGeneration
  ])
  const digest = yield* runtimeDigest(source)
  const accountDigest = PluginRuntimeAccountDigest.make(`sha256:${digest}`)
  return {
    accountDigest,
    layer: Layer.succeed(PluginRuntimeAuthority, PluginRuntimeAuthorityToken.make(`sha256:${digest}`))
  }
})

interface AtlassianAuthenticationMode {
  readonly includesModeKey: boolean
  readonly value: string
}

const atlassianAuthenticationMode = (
  loaded: LoadedRuntime
): Effect.Effect<AtlassianAuthenticationMode, PluginConfigurationFailure> => {
  const { configuration } = loaded
  if (findValue(configuration, "authMode") !== undefined) {
    return Effect.map(textValue(configuration, "authMode"), (value) => ({ includesModeKey: true, value }))
  }
  return loaded.descriptorGeneration === "legacy-atlassian" &&
      findValue(configuration, "email") !== undefined &&
      findValue(configuration, "apiToken") !== undefined
    ? Effect.succeed({ includesModeKey: false, value: "api-token" })
    : Effect.fail(configurationFailure("plugin-configuration-authMode-invalid"))
}

const atlassianAuthentication = Effect.fn("FirstPartyPluginRuntime.atlassianAuthentication")(function*(
  loaded: LoadedRuntime,
  authMode: string,
  provider: "jira" | "confluence",
  expectedSiteOrigin: string,
  expectedCloudId?: string
) {
  if (authMode === "oauth") {
    const profileId = yield* textValue(loaded.configuration, "oauthProfileId")
    const profile = yield* loadAtlassianProfile(provider, profileId).pipe(
      Effect.provide(HomeDirectoryLive),
      Effect.mapError(() => configurationFailure("plugin-oauth-profile-unavailable"))
    )
    if (profile === null) return yield* configurationFailure("plugin-oauth-profile-unavailable")
    const profileSite = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(profile.token.site_url).pipe(
      Effect.mapError(() => configurationFailure("plugin-oauth-profile-invalid"))
    )
    if (
      profileSite.origin !== expectedSiteOrigin ||
      (expectedCloudId !== undefined && profile.token.cloud_id !== expectedCloudId)
    ) {
      return yield* configurationFailure("plugin-oauth-profile-site-mismatch")
    }
    if (profile.token.expires_at <= (yield* Clock.currentTimeMillis)) {
      return yield* configurationFailure("plugin-oauth-profile-expired")
    }
    return {
      credentialGeneration: `oauth:${profile.id}:${profile.updated_at}`,
      auth: {
        type: "oauth2",
        accessToken: Redacted.make(profile.token.access_token),
        cloudId: profile.token.cloud_id
      }
    } satisfies { readonly credentialGeneration: string; readonly auth: JiraApiConfigShape["auth"] }
  }
  if (authMode !== "api-token") return yield* configurationFailure("plugin-authentication-mode-invalid")
  const emailCredential = yield* credentialTextValue(loaded.configuration, "email")
  const email = yield* Schema.decodeUnknownEffect(AtlassianBasicAuthEmail)(
    emailCredential.value
  ).pipe(Effect.mapError(() => configurationFailure("plugin-configuration-schema-invalid")))
  const apiTokenRef = yield* secretValue(loaded.configuration, "apiToken")
  const apiToken = yield* decodeSecret(apiTokenRef)
  return {
    credentialGeneration: `api-token:${emailCredential.generation}\0${apiTokenRef}`,
    auth: { type: "basic", email, apiToken: Redacted.make(apiToken) }
  } satisfies { readonly credentialGeneration: string; readonly auth: JiraApiConfigShape["auth"] }
})

const jiraLayer = Effect.fn("FirstPartyPluginRuntime.jiraLayer")(function*(loaded: LoadedRuntime) {
  // Pre-stability persistence is intentionally breaking: old Jira connections
  // have neither a verified cloud ID nor an immutable project scope. Recreate
  // them rather than silently loading an unscoped reader.
  if (loaded.descriptorGeneration === "legacy-atlassian") {
    return yield* configurationFailure("plugin-configuration-migration-required")
  }
  const authMode = yield* atlassianAuthenticationMode(loaded)
  const expectedKeys = new Set([
    ...(authMode.includesModeKey ? ["authMode"] : []),
    "maximumPages",
    "operationTimeoutMillis",
    "pageSize",
    "projectId",
    "siteId",
    "webBaseUrl",
    ...(authMode.value === "oauth" ? ["oauthProfileId"] : ["apiToken", "email"])
  ])
  yield* requireExactKeys(loaded.configuration, expectedKeys)
  const configurationInput = {
    webBaseUrl: yield* textValue(loaded.configuration, "webBaseUrl", "url"),
    siteId: yield* textValue(loaded.configuration, "siteId"),
    projectId: yield* textValue(loaded.configuration, "projectId"),
    pageSize: yield* integerValue(loaded.configuration, "pageSize"),
    maximumPages: yield* integerValue(loaded.configuration, "maximumPages"),
    operationTimeoutMillis: yield* integerValue(loaded.configuration, "operationTimeoutMillis")
  }
  const configuration = yield* Schema.decodeUnknownEffect(JiraReadPluginConfiguration)(configurationInput).pipe(
    Effect.mapError(() => configurationFailure("plugin-configuration-schema-invalid"))
  )
  const authentication = yield* atlassianAuthentication(
    loaded,
    authMode.value,
    "jira",
    configuration.webBaseUrl.origin,
    configuration.siteId
  )
  const client = JiraApiClient.layer.pipe(
    Layer.provide(Layer.succeed(JiraApiConfig, {
      baseUrl: configuration.webBaseUrl.origin,
      auth: authentication.auth
    }))
  )
  const plugin = Layer.unwrap(
    makeJiraReadPluginRuntime(
      configurationInput,
      authMode.value === "oauth" ? configuration.siteId : null
    ).pipe(Effect.map(({ layer }) => layer))
  ).pipe(Layer.provide(client))
  return { credentialGeneration: authentication.credentialGeneration, layer: plugin }
})

const clockifyLayer = Effect.fn("FirstPartyPluginRuntime.clockifyLayer")(function*(loaded: LoadedRuntime) {
  const expectedKeys = new Set([
    "apiKey",
    "maximumConcurrency",
    "maximumPages",
    "operationTimeoutMillis",
    "pageSize",
    "userIds",
    "webBaseUrl",
    "workspaceId"
  ])
  yield* requireExactKeys(loaded.configuration, expectedKeys)
  const configurationInput = {
    webBaseUrl: yield* textValue(loaded.configuration, "webBaseUrl", "url"),
    workspaceId: yield* textValue(loaded.configuration, "workspaceId"),
    userIds: yield* textValue(loaded.configuration, "userIds"),
    pageSize: yield* integerValue(loaded.configuration, "pageSize"),
    maximumPages: yield* integerValue(loaded.configuration, "maximumPages"),
    maximumConcurrency: yield* integerValue(loaded.configuration, "maximumConcurrency"),
    operationTimeoutMillis: yield* integerValue(loaded.configuration, "operationTimeoutMillis")
  }
  const configuration = yield* Schema.decodeUnknownEffect(ClockifyReadPluginConfiguration)(configurationInput).pipe(
    Effect.mapError(() => configurationFailure("plugin-configuration-schema-invalid"))
  )
  const apiKeyRef = yield* secretValue(loaded.configuration, "apiKey")
  const apiKey = yield* decodeSecret(apiKeyRef)
  const client = ClockifyApiClient.layer.pipe(
    Layer.provide(Layer.succeed(ClockifyApiConfig, {
      apiKey: Redacted.make(apiKey),
      workspaceId: configuration.workspaceId,
      userId: configuration.userIds.split(",")[0]?.trim() ?? "",
      baseUrl: CLOCKIFY_API_ORIGIN
    }))
  )
  const plugin = Layer.unwrap(
    makeClockifyReadPluginRuntime(configurationInput).pipe(Effect.map(({ layer }) => layer))
  ).pipe(Layer.provide(client))
  return { credentialGeneration: apiKeyRef, layer: plugin }
})

const confluenceLayer = Effect.fn("FirstPartyPluginRuntime.confluenceLayer")(function*(loaded: LoadedRuntime) {
  const authMode = yield* atlassianAuthenticationMode(loaded)
  const expectedKeys = new Set([
    ...(authMode.includesModeKey ? ["authMode"] : []),
    "probePageId",
    "siteBaseUrl",
    "siteId",
    "spaceId",
    ...(authMode.value === "oauth" ? ["oauthProfileId"] : ["apiToken", "email"])
  ])
  yield* requireExactKeys(loaded.configuration, expectedKeys)
  const configurationInput = {
    siteBaseUrl: yield* textValue(loaded.configuration, "siteBaseUrl", "url"),
    siteId: yield* textValue(loaded.configuration, "siteId"),
    spaceId: yield* textValue(loaded.configuration, "spaceId"),
    probePageId: yield* textValue(loaded.configuration, "probePageId"),
    ...(authMode.value === "oauth" ? { oauthVerifiedSiteId: yield* textValue(loaded.configuration, "siteId") } : {})
  }
  const configuration = yield* Schema.decodeUnknownEffect(ConfluencePageAdapterConfiguration)(configurationInput).pipe(
    Effect.mapError(() => configurationFailure("plugin-configuration-schema-invalid"))
  )
  const authentication = yield* atlassianAuthentication(
    loaded,
    authMode.value,
    "confluence",
    configuration.siteBaseUrl.origin,
    configuration.siteId
  )
  const apiClient = ConfluenceApiClient.layer.pipe(
    Layer.provide(Layer.succeed(ConfluenceApiConfig, {
      baseUrl: configuration.siteBaseUrl.origin,
      auth: authentication.auth
    }))
  )
  const pageClient = confluencePageClientLayer.pipe(Layer.provide(apiClient))
  const converter = MarkdownConverterLayer.pipe(
    Layer.provide(Layer.merge(AdfSchemaValidatorLayer, AtlaskitTransformersLayer))
  )
  const plugin = buildPluginDefinitionLayer(confluencePagePluginDefinition, configurationInput).pipe(
    Layer.provide(Layer.merge(pageClient, converter))
  )
  return { credentialGeneration: authentication.credentialGeneration, layer: plugin }
})

const codeCommitLayer = Effect.fn("FirstPartyPluginRuntime.codeCommitLayer")(function*(loaded: LoadedRuntime) {
  const expectedKeys = new Set(["profile", "region", "repositoryName"])
  yield* requireExactKeys(loaded.configuration, expectedKeys)
  const profile = yield* textValue(loaded.configuration, "profile")
  const region = yield* textValue(loaded.configuration, "region")
  const configuration = {
    profile,
    region,
    repositoryName: yield* textValue(loaded.configuration, "repositoryName")
  }
  const client = ReadClient.CodeCommitReadClient.live.pipe(Layer.provide(AwsClientConfig.Default))
  return {
    credentialGeneration: `${profile}\0${region}`,
    layer: buildPluginDefinitionLayer(codeCommitPluginDefinition, configuration).pipe(Layer.provide(client))
  }
})

const codePipelineLayer = Effect.fn("FirstPartyPluginRuntime.codePipelineLayer")(function*(loaded: LoadedRuntime) {
  const expectedKeys = new Set([
    "actionPageSize",
    "maximumActionPages",
    "maximumActionsPerExecution",
    "maximumExecutionPages",
    "operationTimeoutMillis",
    "pipelineName",
    "profile",
    "region"
  ])
  yield* requireExactKeys(loaded.configuration, expectedKeys)
  const profile = yield* textValue(loaded.configuration, "profile")
  const region = yield* textValue(loaded.configuration, "region")
  const configuration = {
    profile,
    region,
    pipelineName: yield* textValue(loaded.configuration, "pipelineName"),
    maximumExecutionPages: yield* integerValue(loaded.configuration, "maximumExecutionPages"),
    actionPageSize: yield* integerValue(loaded.configuration, "actionPageSize"),
    maximumActionPages: yield* integerValue(loaded.configuration, "maximumActionPages"),
    maximumActionsPerExecution: yield* integerValue(loaded.configuration, "maximumActionsPerExecution"),
    operationTimeoutMillis: yield* integerValue(loaded.configuration, "operationTimeoutMillis")
  }
  return {
    credentialGeneration: `${profile}\0${region}`,
    layer: buildPluginDefinitionLayer(codePipelinePluginDefinition, configuration).pipe(
      Layer.provide(CodePipelineReadClient.live)
    )
  }
})

const providerLayer = Effect.fn("FirstPartyPluginRuntime.providerLayer")(function*(loaded: LoadedRuntime) {
  switch (loaded.runtime.providerId) {
    case "jira":
      return yield* jiraLayer(loaded)
    case "clockify":
      return yield* clockifyLayer(loaded)
    case "confluence":
      return yield* confluenceLayer(loaded)
    case "codecommit":
      return yield* codeCommitLayer(loaded)
    case "codepipeline":
      return yield* codePipelineLayer(loaded)
  }
})

const makeRegistry = Effect.gen(function*() {
  const persistence = yield* Persistence
  const secrets = yield* SecretStore
  const cryptoService = yield* Crypto.Crypto
  const httpClient = yield* HttpClient.HttpClient
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const requirements = Layer.mergeAll(
    Layer.succeed(Persistence, persistence),
    Layer.succeed(SecretStore, secrets),
    Layer.succeed(Crypto.Crypto, cryptoService),
    Layer.succeed(HttpClient.HttpClient, httpClient),
    Layer.succeed(FileSystem.FileSystem, fileSystem),
    Layer.succeed(Path.Path, path)
  )

  return {
    layer: (scope) =>
      Layer.unwrap(
        Effect.gen(function*() {
          const loaded = yield* loadRuntime(scope)
          const provider = yield* providerLayer(loaded)
          const authority = yield* authorityLayer(scope, loaded, provider.credentialGeneration)
          return Layer.mergeAll(provider.layer, authority.layer, readOnlyExecutorLayer).pipe(
            Layer.provide(requirements)
          )
        }).pipe(
          Effect.provide(requirements)
        )
      )
  } satisfies PluginRuntimeRegistryV1
})

/** Production registry for the fixed first-party provider catalog. @internal */
export const FirstPartyPluginRuntimeRegistry = Layer.effect(PluginRuntimeRegistry, makeRegistry)
