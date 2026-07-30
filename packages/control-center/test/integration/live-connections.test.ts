import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { HttpApiClient } from "effect/unstable/httpapi"

import { ControlCenterApi } from "../../src/api/controlCenterApi.js"
import {
  type CreatePluginConnectionRequest,
  type CreatePluginConnectionValue,
  PluginConfigurationKey
} from "../../src/api/plugins.js"
import { PairingCode } from "../../src/api/session.js"
import { PersonId, PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import type { ProviderId } from "../../src/domain/sourceRevision.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { BlobRoot, LocalDatabaseUrl, type PersistenceConfig } from "../../src/server/persistence/PersistenceConfig.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { firstPartyService } from "../../src/server/plugins/catalog/firstPartyServiceCatalog.js"
import { ControlCenterBootstrap } from "../../src/server/runtime/Bootstrap.js"
import { makeControlCenterServer } from "../../src/server/runtime/ControlCenterServer.js"
import { SecretRoot } from "../../src/server/secrets/SecretStore.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"
import { type LiveConnectionConfiguration, loadLiveConnectionConfiguration } from "./liveConnectionConfiguration.js"
import { opaqueProviderBindingEvidence, opaqueProviderIdentityEvidence } from "./liveEvidence.js"
import {
  assertSensitiveTextAbsent,
  makeSecretSafeLiveHttpClient,
  redactAuthenticatedLiveResponse,
  redactLiveRequestFailure
} from "./liveSecretAssertions.js"
import { startWithRetriedEphemeralPort } from "./liveServerPort.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-0000000000a0")
const OWNER_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-0000000000a1")
const CONNECTIONS = {
  codecommit: PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-0000000000a2"),
  codepipeline: PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-0000000000a3"),
  jira: PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-0000000000a4"),
  confluence: PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-0000000000a5")
}
const AUTHENTICATION_REGRESSION_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-0000000000a6")
const INVALID_API_TOKEN = "control-center-live-invalid-api-token"

const text = (key: string, value: string): CreatePluginConnectionValue => ({
  _tag: "text",
  key: PluginConfigurationKey.make(key),
  value
})
const url = (key: string, value: string): CreatePluginConnectionValue => ({
  _tag: "url",
  key: PluginConfigurationKey.make(key),
  value
})
const integer = (key: string, value: number): CreatePluginConnectionValue => ({
  _tag: "integer",
  key: PluginConfigurationKey.make(key),
  value
})
const secret = (key: string, value: string): CreatePluginConnectionValue => ({
  _tag: "secret",
  key: PluginConfigurationKey.make(key),
  value
})

const jiraValues = (
  configuration: LiveConnectionConfiguration,
  apiToken: string,
  maximumPages = 5
): ReadonlyArray<CreatePluginConnectionValue> => [
  url("webBaseUrl", configuration.atlassianSiteUrl),
  text("siteId", configuration.atlassianSiteId),
  text("projectId", configuration.jiraProjectId),
  text("authMode", "api-token"),
  text("email", configuration.jiraEmail),
  secret("apiToken", apiToken),
  integer("pageSize", 50),
  integer("maximumPages", maximumPages),
  integer("operationTimeoutMillis", 30_000)
]

const connectionRequests = (
  configuration: LiveConnectionConfiguration
): ReadonlyArray<CreatePluginConnectionRequest> => [
  {
    pluginConnectionId: CONNECTIONS.codecommit,
    providerId: "codecommit",
    displayName: `Live CodeCommit · ${configuration.codeCommitRepository}`,
    values: [
      text("profile", "default"),
      text("region", configuration.awsRegion),
      text("repositoryName", configuration.codeCommitRepository)
    ]
  },
  {
    pluginConnectionId: CONNECTIONS.codepipeline,
    providerId: "codepipeline",
    displayName: `Live CodePipeline · ${configuration.codePipelinePipeline}`,
    values: [
      text("profile", "default"),
      text("region", configuration.awsRegion),
      text("pipelineName", configuration.codePipelinePipeline),
      integer("maximumExecutionPages", 5),
      integer("actionPageSize", 50),
      integer("maximumActionPages", 3),
      integer("maximumActionsPerExecution", 100),
      integer("maximumLogBytes", 262_144),
      integer("operationTimeoutMillis", 30_000)
    ]
  },
  {
    pluginConnectionId: CONNECTIONS.jira,
    providerId: "jira",
    displayName: `Live Jira · ${configuration.jiraProjectId}`,
    values: jiraValues(configuration, Redacted.value(configuration.jiraApiKey))
  },
  {
    pluginConnectionId: CONNECTIONS.confluence,
    providerId: "confluence",
    displayName: `Live Confluence · ${configuration.confluenceSpaceId}`,
    values: [
      url("siteBaseUrl", configuration.atlassianSiteUrl),
      text("authMode", "api-token"),
      text("email", configuration.confluenceEmail),
      secret("apiToken", Redacted.value(configuration.confluenceApiKey)),
      text("siteId", configuration.atlassianSiteId),
      text("spaceId", configuration.confluenceSpaceId),
      text("probePageId", configuration.confluenceProbePageId)
    ]
  }
]

const executeLiveJourney = Effect.fn("controlCenter.executeLiveConnectionJourney")(function*(
  configuration: LiveConnectionConfiguration
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const started = yield* startWithRetriedEphemeralPort((port) =>
    Effect.gen(function*() {
      const dataRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "control-center-live-integration-"
      })
      yield* fileSystem.chmod(dataRoot, 0o700)
      const staticRoot = path.join(dataRoot, "static")
      yield* fileSystem.makeDirectory(staticRoot)
      yield* fileSystem.writeFileString(
        path.join(staticRoot, "index.html"),
        "<main>Control Center live integration</main>"
      )
      const persistenceConfig: PersistenceConfig = {
        blobRoot: BlobRoot.make(path.join(dataRoot, "blobs")),
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: LocalDatabaseUrl.make(`file:${path.join(dataRoot, "control-center.db")}`),
        maxConnections: 1
      }
      const bindConfig = yield* decodeBindConfig({ port })
      const runtime = yield* Layer.build(
        makeControlCenterServer({
          bindConfig,
          persistenceConfig,
          secretRoot: SecretRoot.make(path.join(dataRoot, "secrets")),
          staticAssets: { root: staticRoot },
          bootstrap: {
            workspaceId: WORKSPACE_ID,
            workspaceName: WorkspaceName.make("Live provider acceptance"),
            owner: { _tag: "human", personId: OWNER_ID }
          },
          firstPartyPluginRuntime: true
        })
      )
      return { dataRoot, persistenceConfig, runtime }
    })
  )
  const origin = `http://127.0.0.1:${started.port}`
  const { dataRoot, persistenceConfig, runtime } = started.value
  const bootstrap = Context.get(runtime, ControlCenterBootstrap)
  if (bootstrap._tag !== "pairing-issued") {
    return yield* Effect.die("live integration did not issue the first owner pairing code")
  }

  const httpClient = yield* HttpClient.HttpClient
  const pairClient = yield* HttpApiClient.makeWith(ControlCenterApi, {
    baseUrl: origin,
    httpClient: httpClient.pipe(makeSecretSafeLiveHttpClient("pair-owner", { origin })),
    transformResponse: redactLiveRequestFailure("pair-owner")
  })
  const [paired, pairResponse] = yield* pairClient.session.pair({
    payload: { pairingCode: PairingCode.make(Redacted.value(bootstrap.pairingCode)) },
    responseMode: "decoded-and-response"
  }).pipe(redactLiveRequestFailure("pair-owner"))
  const sessionCookie = pairResponse.cookies.cookies.cc_session
  if (sessionCookie === undefined) {
    return yield* Effect.die("live integration pairing did not issue a session cookie")
  }
  const cookie = `cc_session=${sessionCookie.valueEncoded}`
  const authenticatedClient = yield* HttpApiClient.makeWith(ControlCenterApi, {
    baseUrl: origin,
    httpClient: httpClient.pipe(makeSecretSafeLiveHttpClient("authenticated-api", { cookie, origin })),
    transformResponse: redactAuthenticatedLiveResponse
  })
  const mutationClient = yield* HttpApiClient.makeWith(ControlCenterApi, {
    baseUrl: origin,
    httpClient: httpClient.pipe(
      makeSecretSafeLiveHttpClient("authenticated-api", {
        cookie,
        origin,
        "x-csrf-token": paired.csrfToken
      })
    ),
    transformResponse: redactAuthenticatedLiveResponse
  })

  const setupResponses = []
  for (const request of connectionRequests(configuration)) {
    setupResponses.push(
      yield* mutationClient.plugins
        .createConnection({ payload: request })
        .pipe(redactLiveRequestFailure("create-connection"))
    )
  }
  assert.isTrue(setupResponses.every(({ test }) => test._tag === "healthy"))
  const serializedSetup = JSON.stringify(setupResponses)
  for (
    const forbidden of [
      Redacted.value(configuration.jiraApiKey),
      Redacted.value(configuration.confluenceApiKey),
      configuration.jiraEmail,
      configuration.confluenceEmail
    ]
  ) {
    assertSensitiveTextAbsent(serializedSetup, forbidden)
  }

  const repeatedTests = []
  for (const pluginConnectionId of Object.values(CONNECTIONS)) {
    repeatedTests.push(yield* mutationClient.plugins.testConnection({ params: { pluginConnectionId } }))
  }
  assert.isTrue(
    repeatedTests.every(
      (result) => result._tag === "healthy" && result.identity.providerImmutableId.length > 0
    )
  )
  const awsIdentities = repeatedTests.filter(
    (result) =>
      result._tag === "healthy" && (result.providerId === "codecommit" || result.providerId === "codepipeline")
  )
  assert.isTrue(awsIdentities.length === 2, "Live integration must resolve exactly two AWS provider identities")
  if (awsIdentities[0]?._tag === "healthy" && awsIdentities[1]?._tag === "healthy") {
    assert.isTrue(
      /^[0-9]{12}$/u.test(awsIdentities[0].identity.providerImmutableId),
      "AWS live provider identity must be a twelve-digit account identifier"
    )
    assert.isTrue(
      awsIdentities[0].identity.providerImmutableId === awsIdentities[1].identity.providerImmutableId,
      "AWS live provider connections must resolve the same account"
    )
  }

  const synchronizations = []
  for (const pluginConnectionId of Object.values(CONNECTIONS)) {
    synchronizations.push(yield* mutationClient.plugins.synchronizeConnection({ params: { pluginConnectionId } }))
  }
  assert.isTrue(
    synchronizations.every(({ pagesCommitted, result }) => result === "synchronized" && pagesCommitted >= 1)
  )

  const overview = yield* authenticatedClient.plugins.overview()
  assert.lengthOf(overview.connections, 4)
  assert.deepStrictEqual([...new Set(overview.accounts.map(({ providerFamily }) => providerFamily))].sort(), [
    "atlassian",
    "aws"
  ])
  assert.deepStrictEqual(
    overview.accounts.flatMap(({ resources }) => resources.map(({ providerId }) => providerId)).sort(),
    ["codecommit", "codepipeline", "confluence", "jira"]
  )
  assert.isTrue(
    overview.connections.every(
      ({ followedResourceId, providerAccountId }) => followedResourceId !== null && providerAccountId !== null
    )
  )

  const items = yield* authenticatedClient.deliveryGraph.workspaceEntityProjections({ query: {} })
  assert.isFalse(items.truncated)
  const inspections = []
  for (const item of items.items) {
    inspections.push(
      yield* authenticatedClient.deliveryGraph.workspaceEntity({
        params: { entityId: item.projection.entityId }
      })
    )
  }
  assert.deepStrictEqual([...new Set(inspections.map(({ source }) => source.providerId))].sort(), [
    "codecommit",
    "codepipeline",
    "confluence",
    "jira"
  ])
  const jiraIssues = inspections.filter(
    ({ entity, source }) => source.providerId === "jira" && entity.projection.details._tag === "issue"
  )
  if (jiraIssues.length === 0) {
    return yield* Effect.die("live Jira synchronization produced no canonical issue")
  }
  assert.isTrue(
    jiraIssues.every(
      ({ entity }) =>
        entity.projection.details._tag === "issue" &&
        entity.projection.details.project?.sourceId === configuration.jiraProjectId
    )
  )
  assert.isTrue(
    jiraIssues.some(
      ({ entity }) =>
        entity.projection.details._tag === "issue" &&
        (entity.projection.details.comments?.length ?? 0) > 0 &&
        (entity.projection.details.history?.length ?? 0) > 0
    )
  )

  const confluencePages = inspections.filter(
    ({ entity, source }) => source.providerId === "confluence" && entity.projection.details._tag === "page"
  )
  if (confluencePages.length === 0) {
    return yield* Effect.die("live Confluence synchronization produced no canonical page")
  }
  assert.isTrue(
    confluencePages.every(
      ({ entity }) =>
        entity.projection.details._tag === "page" &&
        entity.projection.details.sourceSpaceId === configuration.confluenceSpaceId
    )
  )
  assert.isTrue(
    confluencePages.some(
      ({ entity }) =>
        entity.projection.details._tag === "page" &&
        (entity.projection.details.versions?.length ?? 0) > 0 &&
        (entity.projection.details.contributors?.length ?? 0) > 0
    )
  )

  const pipelineExecution = inspections.find(
    ({ entity, source }) =>
      source.providerId === "codepipeline" && entity.projection.details._tag === "pipeline-execution"
  )
  if (pipelineExecution?.entity.projection.details._tag !== "pipeline-execution") {
    return yield* Effect.die("live CodePipeline synchronization produced no canonical execution")
  }
  assert.strictEqual(pipelineExecution.entity.projection.details.pipelineName, configuration.codePipelinePipeline)
  assert.isAbove(pipelineExecution.entity.projection.details.actionCount ?? 0, 0)
  assert.isAbove(pipelineExecution.entity.projection.details.actions?.length ?? 0, 0)
  assert.isAbove(pipelineExecution.entity.projection.details.actionPagesRead ?? 0, 0)

  const pullRequest = inspections.find(
    ({ entity, source }) => source.providerId === "codecommit" && entity.projection.entityType === "pull-request"
  )
  if (pullRequest === undefined) {
    return yield* Effect.die("live CodeCommit synchronization produced no canonical pull request")
  }
  const inventory = yield* authenticatedClient.diff.inventory({
    params: {
      pluginConnectionId: pullRequest.source.pluginConnectionId,
      vendorImmutableId: pullRequest.source.vendorImmutableId
    },
    query: { revision: pullRequest.source.revision }
  })
  assert.isTrue(inventory.ready)
  assert.isAbove(inventory.entries.length, 0)

  const timeline = yield* authenticatedClient.timeline.page({ query: { limit: 100 } })
  assert.deepStrictEqual(
    [...new Set(timeline.events.flatMap(({ service }) => (service === null ? [] : [service])))]
      .filter(
        (service) =>
          service === "codecommit" || service === "codepipeline" || service === "confluence" || service === "jira"
      )
      .sort(),
    ["codecommit", "codepipeline", "confluence", "jira"]
  )

  const authenticationRegression = yield* mutationClient.plugins
    .createConnection({
      payload: {
        pluginConnectionId: AUTHENTICATION_REGRESSION_CONNECTION_ID,
        providerId: "jira",
        displayName: "Live Jira authentication regression",
        values: jiraValues(configuration, INVALID_API_TOKEN, 1)
      }
    })
    .pipe(redactLiveRequestFailure("create-connection"))
  assert.strictEqual(authenticationRegression.test._tag, "failed")
  if (authenticationRegression.test._tag === "failed") {
    assert.include(["authentication", "authorization"], authenticationRegression.test.failureClass)
    assertSensitiveTextAbsent(JSON.stringify(authenticationRegression.test), INVALID_API_TOKEN)
    assertSensitiveTextAbsent(JSON.stringify(authenticationRegression.test), configuration.jiraEmail)
  }

  const inspectionDatabaseContext = yield* Layer.build(databaseLayer(persistenceConfig))
  const database = Context.get(inspectionDatabaseContext, Database)
  const storedConfigurations = yield* database.sql<{ readonly configurationJson: string }>`SELECT
    configuration_json AS configuration_json
    FROM plugin_configurations
    ORDER BY plugin_connection_id`
  const serializedDatabaseConfiguration = JSON.stringify(storedConfigurations)
  for (const providerId of ["jira", "confluence"] satisfies ReadonlyArray<ProviderId>) {
    const fields = firstPartyService(providerId)?.metadata.configurationFields
    const emailField = fields?.find(({ key }) => key === "email")
    const apiTokenField = fields?.find(({ key }) => key === "apiToken")
    assert.strictEqual(emailField?.kind, "text")
    assert.strictEqual(emailField?.scope, "credential")
    assert.strictEqual(apiTokenField?.kind, "secret")
    assert.strictEqual(apiTokenField?.scope, "credential")
  }
  const credentialStorageViolations = yield* database.sql<{ readonly count: number }>`SELECT
    COUNT(*) AS count
    FROM plugin_configurations, json_each(plugin_configurations.configuration_json)
    WHERE json_extract(json_each.value, '$.key') IN ('email', 'apiToken')
      AND json_extract(json_each.value, '$._tag') <> 'secret-reference'`
  assert.strictEqual(credentialStorageViolations[0]?.count, 0)
  for (
    const forbidden of [
      Redacted.value(configuration.jiraApiKey),
      Redacted.value(configuration.confluenceApiKey),
      INVALID_API_TOKEN,
      configuration.jiraEmail,
      configuration.confluenceEmail
    ]
  ) {
    assertSensitiveTextAbsent(serializedDatabaseConfiguration, forbidden)
  }

  return {
    dataRoot,
    bindings: overview.accounts.map(opaqueProviderBindingEvidence),
    identities: repeatedTests.map(opaqueProviderIdentityEvidence)
  }
})

describe("Control Center live provider integration", () => {
  it.effect("pairs an owner and materializes four production provider connections", () =>
    Effect.gen(function*() {
      const configuration = yield* loadLiveConnectionConfiguration
      const evidence = yield* Effect.scoped(executeLiveJourney(configuration))
      const fileSystem = yield* FileSystem.FileSystem

      assert.isFalse(yield* fileSystem.exists(evidence.dataRoot))
      assert.lengthOf(evidence.identities, 4)
      assert.deepStrictEqual(evidence.identities.map(({ providerId }) => providerId).sort(), [
        "codecommit",
        "codepipeline",
        "confluence",
        "jira"
      ])
      assert.isTrue(
        evidence.identities.every(({ status }) => status === "healthy")
      )
      yield* Effect.logInfo("Control Center live provider identities", {
        bindings: evidence.bindings,
        identities: evidence.identities
      })
    }).pipe(Effect.provide([FetchHttpClient.layer, NodeServices.layer])))
})
