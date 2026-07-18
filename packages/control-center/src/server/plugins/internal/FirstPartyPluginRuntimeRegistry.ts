import { ClockifyApiClient, ClockifyApiConfig } from "@knpkv/clockify-api-client"
import { AwsClientConfig, ReadClient } from "@knpkv/codecommit-core"
import { ConfluenceApiClient, ConfluenceApiConfig } from "@knpkv/confluence-api-client"
import {
  AdfSchemaValidatorLayer,
  AtlaskitTransformersLayer,
  MarkdownConverterLayer
} from "@knpkv/confluence-to-markdown"
import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
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
  const expected = yield* negotiatePluginDescriptorV1(expectedDescriptor(connection.providerId))
  if (
    runtime.providerId !== connection.providerId ||
    runtime.descriptorSchemaVersion !== descriptor.descriptor.contractVersion.major ||
    JSON.stringify(descriptor) !== JSON.stringify(expected)
  ) {
    return yield* configurationFailure("plugin-runtime-source-mismatch")
  }
  return {
    configuration: configurationOption.value.values,
    configurationDigest: configurationOption.value.configurationDigest,
    configurationRevision: configurationOption.value.revision,
    connectionRevision: connection.revision,
    descriptor,
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

const jiraLayer = Effect.fn("FirstPartyPluginRuntime.jiraLayer")(function*(loaded: LoadedRuntime) {
  const expectedKeys = new Set([
    "apiToken",
    "email",
    "maximumPages",
    "operationTimeoutMillis",
    "pageSize",
    "webBaseUrl"
  ])
  yield* requireExactKeys(loaded.configuration, expectedKeys)
  const configurationInput = {
    webBaseUrl: yield* textValue(loaded.configuration, "webBaseUrl", "url"),
    pageSize: yield* integerValue(loaded.configuration, "pageSize"),
    maximumPages: yield* integerValue(loaded.configuration, "maximumPages"),
    operationTimeoutMillis: yield* integerValue(loaded.configuration, "operationTimeoutMillis")
  }
  const configuration = yield* Schema.decodeUnknownEffect(JiraReadPluginConfiguration)(configurationInput).pipe(
    Effect.mapError(() => configurationFailure("plugin-configuration-schema-invalid"))
  )
  const emailCredential = yield* credentialTextValue(loaded.configuration, "email")
  const email = yield* Schema.decodeUnknownEffect(AtlassianBasicAuthEmail)(
    emailCredential.value
  ).pipe(Effect.mapError(() => configurationFailure("plugin-configuration-schema-invalid")))
  const apiTokenRef = yield* secretValue(loaded.configuration, "apiToken")
  const apiToken = yield* decodeSecret(apiTokenRef)
  const client = JiraApiClient.layer.pipe(
    Layer.provide(Layer.succeed(JiraApiConfig, {
      baseUrl: configuration.webBaseUrl.origin,
      auth: { type: "basic", email, apiToken: Redacted.make(apiToken) }
    }))
  )
  const plugin = Layer.unwrap(
    makeJiraReadPluginRuntime(configurationInput).pipe(Effect.map(({ layer }) => layer))
  ).pipe(Layer.provide(client))
  return { credentialGeneration: `${emailCredential.generation}\0${apiTokenRef}`, layer: plugin }
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
  const expectedKeys = new Set(["apiToken", "email", "probePageId", "siteBaseUrl", "siteId", "spaceId"])
  yield* requireExactKeys(loaded.configuration, expectedKeys)
  const configurationInput = {
    siteBaseUrl: yield* textValue(loaded.configuration, "siteBaseUrl", "url"),
    siteId: yield* textValue(loaded.configuration, "siteId"),
    spaceId: yield* textValue(loaded.configuration, "spaceId"),
    probePageId: yield* textValue(loaded.configuration, "probePageId")
  }
  const configuration = yield* Schema.decodeUnknownEffect(ConfluencePageAdapterConfiguration)(configurationInput).pipe(
    Effect.mapError(() => configurationFailure("plugin-configuration-schema-invalid"))
  )
  const emailCredential = yield* credentialTextValue(loaded.configuration, "email")
  const email = yield* Schema.decodeUnknownEffect(AtlassianBasicAuthEmail)(
    emailCredential.value
  ).pipe(Effect.mapError(() => configurationFailure("plugin-configuration-schema-invalid")))
  const apiTokenRef = yield* secretValue(loaded.configuration, "apiToken")
  const apiToken = yield* decodeSecret(apiTokenRef)
  const apiClient = ConfluenceApiClient.layer.pipe(
    Layer.provide(Layer.succeed(ConfluenceApiConfig, {
      baseUrl: configuration.siteBaseUrl.origin,
      auth: { type: "basic", email, apiToken: Redacted.make(apiToken) }
    }))
  )
  const pageClient = confluencePageClientLayer.pipe(Layer.provide(apiClient))
  const converter = MarkdownConverterLayer.pipe(
    Layer.provide(Layer.merge(AdfSchemaValidatorLayer, AtlaskitTransformersLayer))
  )
  const plugin = buildPluginDefinitionLayer(confluencePagePluginDefinition, configurationInput).pipe(
    Layer.provide(Layer.merge(pageClient, converter))
  )
  return { credentialGeneration: `${emailCredential.generation}\0${apiTokenRef}`, layer: plugin }
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

  const requirements = Layer.mergeAll(
    Layer.succeed(Persistence, persistence),
    Layer.succeed(SecretStore, secrets),
    Layer.succeed(Crypto.Crypto, cryptoService),
    Layer.succeed(HttpClient.HttpClient, httpClient)
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
