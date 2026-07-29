import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { CONFLUENCE_SCOPES, JIRA_SCOPES } from "@knpkv/atlassian-common/auth"
import { ReadClient, ReviewClient } from "@knpkv/codecommit-core"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { ReviewAgentProfile, ReviewAgentProfileId, ReviewSuggestionPublicationContent } from "../../src/api/agent.js"
import { PatchPluginConfigurationRequest } from "../../src/api/plugins.js"
import { GovernedActionUnknownOutcome } from "../../src/domain/governedAction/index.js"
import {
  EntityId,
  GovernedActionId,
  JobId,
  PersonId,
  PluginConnectionId,
  PrReviewSuggestionRevisionId,
  SessionId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import {
  AuthorizedPluginActionV1,
  PluginActionPreflightV1,
  PluginPipelineArtifactRangeRequestV1,
  PluginPipelineLogPageRequestV1,
  PluginSyncRequestV1,
  ProposePluginActionRequestV1
} from "../../src/domain/plugins/index.js"
import { PrReviewSuggestion, PrReviewSuggestionId } from "../../src/domain/prReview.js"
import { Revision, SourceRevision, VendorImmutableId } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { CompleteDiffReads, PluginAdministration } from "../../src/server/api/ApplicationServices.js"
import { projectClockifyApproval } from "../../src/server/application/clockifyApprovalProjection.js"
import { firstPartyManualPluginSyncDrivers } from "../../src/server/application/manualPluginSynchronization.js"
import { materializeNormalizedPluginPage } from "../../src/server/application/normalizedPluginPageMaterialization.js"
import {
  ReviewSuggestionPublicationGateway,
  type ReviewSuggestionPublicationTarget
} from "../../src/server/application/ReviewSuggestionPublicationGateway.js"
import { governedActionExecutionStoreLayer } from "../../src/server/governance/internal/execution-store/live.js"
import { GovernedActionExecutionEngine } from "../../src/server/governance/internal/GovernedActionExecutionEngine.js"
import { GovernedActionExecutionStore } from "../../src/server/governance/internal/GovernedActionExecutionStore.js"
import { GovernedActionPolicyEvaluator } from "../../src/server/governance/internal/GovernedActionPolicyEvaluator.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PersistenceConfig } from "../../src/server/persistence/PersistenceConfig.js"
import { DeliveryGraphRepository } from "../../src/server/persistence/repositories/deliveryGraphRepository.js"
import { GovernedActionRepository } from "../../src/server/persistence/repositories/governedActionRepository.js"
import {
  PluginConnectionDisplayName,
  RecordRevision,
  WorkspaceName
} from "../../src/server/persistence/repositories/models.js"
import { StoredPluginConfiguration } from "../../src/server/persistence/repositories/pluginConfigurationModels.js"
import { PluginStreamKey } from "../../src/server/persistence/repositories/pluginRuntimeModels.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import {
  clockifyReadOnlyPluginDescriptor,
  clockifyReadPluginDescriptor
} from "../../src/server/plugins/clockify/ClockifyReadPlugin.js"
import {
  codeCommitPluginDefinition,
  codeCommitPluginDescriptor
} from "../../src/server/plugins/codecommit/CodeCommitPluginDefinition.js"
import {
  codePipelinePluginDefinition,
  codePipelinePluginDescriptor
} from "../../src/server/plugins/codepipeline/CodePipelinePluginDefinition.js"
import {
  canonicalCodePipelinePrincipalArn,
  type CodePipelineExecutionSnapshot,
  type CodePipelinePipeline,
  type CodePipelineReadClientService
} from "../../src/server/plugins/codepipeline/CodePipelineReadClient.js"
import { codePipelineRuntimeIdentityMatches } from "../../src/server/plugins/codepipeline/CodePipelineReadProvider.js"
import {
  confluencePagePluginDescriptor,
  historicalConfluenceReadPluginDescriptor
} from "../../src/server/plugins/confluence/ConfluencePagePluginDefinition.js"
import { PluginConflictFailure } from "../../src/server/plugins/failures.js"
import { AuthorizedPluginExecutor } from "../../src/server/plugins/internal/AuthorizedPluginExecutor.js"
import { AuthorizedPluginExecutorMap } from "../../src/server/plugins/internal/AuthorizedPluginExecutorMap.js"
import {
  historicalActionCodeCommitDescriptor,
  historicalCodeCommitDescriptor,
  historicalCompleteDiffCodeCommitDescriptor,
  historicalReadOnlyCodePipelineDescriptor,
  makeFirstPartyPluginRuntimeRegistry
} from "../../src/server/plugins/internal/FirstPartyPluginRuntimeRegistry.js"
import {
  PluginRuntimeAuthority,
  PluginRuntimeAuthorityToken
} from "../../src/server/plugins/internal/PluginRuntimeAuthority.js"
import { pluginRuntimeAuthoritySourceLayer } from "../../src/server/plugins/internal/PluginRuntimeAuthorityRepository.js"
import { pluginRuntimeKey, PluginRuntimeMap } from "../../src/server/plugins/internal/PluginRuntimeMap.js"
import { PluginRuntimeRegistry } from "../../src/server/plugins/internal/PluginRuntimeRegistry.js"
import { jiraReadPluginDescriptor } from "../../src/server/plugins/jira/JiraReadPlugin.js"
import { hasPluginCapability } from "../../src/server/plugins/negotiation.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import { PluginConnectionMap } from "../../src/server/plugins/PluginConnectionMap.js"
import { makeControlCenterApplicationComposition } from "../../src/server/runtime/ControlCenterServer.js"
import { DomainEventWakeups } from "../../src/server/runtime/DomainEventWakeups.js"
import { firstPartyPluginConnectionMapLayer } from "../../src/server/runtime/FirstPartyPluginRuntime.js"
import { GovernedActionExecutionStartup } from "../../src/server/runtime/GovernedActionExecutionStartup.js"
import { SecretRef } from "../../src/server/secrets/SecretRef.js"
import { SecretRoot, SecretStore } from "../../src/server/secrets/SecretStore.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"
import {
  ACTION_ID as GOVERNED_ACTION_ID,
  CONNECTION_ID as GOVERNED_CONNECTION_ID,
  ENTITY_ID as GOVERNED_ENTITY_ID,
  seedGovernedAction,
  seedGovernedActionAuthorityRoots,
  seedGovernedActionCurrentInputs,
  WORKSPACE_ID as GOVERNED_WORKSPACE_ID
} from "../governance/fixtures/authorizedGovernedAction.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000081")
const OTHER_WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000082")
const CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000083")
const UNCONFIGURED_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000084")
const PREVIOUS_CODECOMMIT_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000085")
const FUTURE_CODECOMMIT_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000086")
const HISTORICAL_CLOCKIFY_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000087")
const GOVERNED_WORKSPACE = WorkspaceId.make(GOVERNED_WORKSPACE_ID)
const GOVERNED_CONNECTION = PluginConnectionId.make(GOVERNED_CONNECTION_ID)
const GOVERNED_ACTION = GovernedActionId.make(GOVERNED_ACTION_ID)
const CREATED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-18T10:00:00.000Z")
const historicalJiraDescriptor = {
  ...jiraReadPluginDescriptor,
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  capabilities: [{ capabilityId: "entity.read", supportedVersions: [1], requirement: "required" }]
}
const historicalJiraV02Descriptor = {
  ...jiraReadPluginDescriptor,
  adapterVersion: { major: 0, minor: 2, patch: 0 },
  capabilities: ["entity.read", "sync.incremental"].map((capabilityId) => ({
    capabilityId,
    supportedVersions: [1],
    requirement: "required"
  }))
}

const historicalConfluenceOAuthDescriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.confluence",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  displayName: "Confluence Cloud",
  configurationFields: [
    {
      _tag: "url",
      key: "siteBaseUrl",
      label: "Site URL",
      description: "HTTPS Confluence Cloud tenant root URL under atlassian.net.",
      required: true
    },
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
    },
    {
      _tag: "text",
      key: "siteId",
      label: "Site ID",
      description: "Stable Atlassian site identity used for connection isolation.",
      required: true
    },
    {
      _tag: "text",
      key: "spaceId",
      label: "Space ID",
      description: "Confluence space visible through this connection.",
      required: true
    },
    {
      _tag: "text",
      key: "probePageId",
      label: "Health page ID",
      description: "Readable page used for a bounded connection health check.",
      required: true
    }
  ],
  capabilities: [{ capabilityId: "entity.read", supportedVersions: [1], requirement: "required" }]
}

const preOAuthDescriptor = (providerId: "jira" | "confluence") => {
  const descriptor = providerId === "jira" ? historicalJiraDescriptor : historicalConfluenceOAuthDescriptor
  return {
    ...descriptor,
    capabilities: descriptor.capabilities,
    configurationFields: descriptor.configurationFields.flatMap((field) => {
      if (providerId === "jira" && (field.key === "siteId" || field.key === "projectId")) return []
      if (field.key === "authMode" || field.key === "oauthProfileId") return []
      if (field.key !== "email") return [{ ...field, required: field.key === "apiToken" ? true : field.required }]
      return [{
        ...field,
        description: providerId === "jira"
          ? "Atlassian account email used for Jira Cloud basic authentication."
          : "Atlassian account email used for Confluence Cloud basic authentication.",
        required: true
      }]
    })
  }
}

const jiraOAuthDescriptorWithoutIdentity = {
  ...historicalJiraDescriptor,
  configurationFields: historicalJiraDescriptor.configurationFields.filter(
    ({ key }) => key !== "siteId" && key !== "projectId"
  )
}

const jiraOAuthDescriptorWithSiteOnly = {
  ...historicalJiraDescriptor,
  configurationFields: historicalJiraDescriptor.configurationFields.filter(({ key }) => key !== "projectId")
}

const oauthProfile = (id: string, expiresAt: number, userName = "Avery Bell") => ({
  id,
  name: `${id} @ knpkv.atlassian.net`,
  token: {
    access_token: `${id}-access-token`,
    refresh_token: `${id}-refresh-token`,
    expires_at: expiresAt,
    scope: Array.from(new Set([...JIRA_SCOPES, ...CONFLUENCE_SCOPES])).join(" "),
    cloud_id: "cloud-1",
    site_url: "https://knpkv.atlassian.net/",
    user: { account_id: "account-1", name: userName, email: "avery@example.com" }
  },
  created_at: "2026-07-18T10:00:00.000Z",
  updated_at: "2026-07-18T10:00:00.000Z"
})

const fakeClockifyClient = (
  requests: Array<HttpClientRequest.HttpClientRequest>
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      const body = request.url.includes("/wiki/api/v2/spaces/")
        ? { results: [] }
        : request.url.endsWith("/v1/user")
        ? { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", status: "ACTIVE" }
        : [{ id: "clockify-workspace", name: "Delivery" }]
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    })
  )

const unusedCodeCommitClients = (() => {
  const readClient = Layer.succeed(ReadClient.CodeCommitReadClient, {
    discoverAccount: () => Effect.die("unused discoverAccount"),
    listRepositoriesPage: () => Effect.die("unused listRepositoriesPage"),
    getBlob: () => Effect.die("unused getBlob"),
    listPullRequestsPage: () => Effect.die("unused listPullRequestsPage"),
    streamPullRequests: () => Stream.empty,
    getPullRequest: () => Effect.die("unused getPullRequest"),
    getChangedFilesPage: () => Effect.die("unused getChangedFilesPage"),
    streamChangedFiles: () => Stream.empty
  })
  const reviewProvider = Layer.succeed(ReviewClient.CodeCommitReviewProvider, {
    postComment: () => Effect.die("unused postComment"),
    updateApprovalState: () => Effect.die("unused updateApprovalState"),
    getApprovalStates: () => Effect.die("unused getApprovalStates"),
    getCommentsPage: () => Effect.die("unused getCommentsPage")
  })
  const reviewClient = ReviewClient.CodeCommitReviewClient.layer.pipe(
    Layer.provide(Layer.merge(readClient, reviewProvider))
  )
  return Layer.merge(readClient, reviewClient)
})()

describe("first-party plugin runtime", () => {
  it("canonicalizes only assumed-role sessions for stable CodePipeline authority", () => {
    assert.strictEqual(
      canonicalCodePipelinePrincipalArn(
        "arn:aws:sts::123456789012:assumed-role/team/control-center/session-a"
      ),
      "arn:aws:iam::123456789012:role/team/control-center"
    )
    assert.strictEqual(
      canonicalCodePipelinePrincipalArn("arn:aws:iam::123456789012:user/control-center"),
      "arn:aws:iam::123456789012:user/control-center"
    )
    assert.strictEqual(
      canonicalCodePipelinePrincipalArn("arn:aws:sts::123456789012:federated-user/control-center"),
      "arn:aws:sts::123456789012:federated-user/control-center"
    )
  })

  it.effect("keeps the CodeCommit action executor when composing the production registry", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
      const readCalls = yield* Ref.make(0)
      const mutationCalls = yield* Ref.make(0)
      const identityArn = yield* Ref.make("arn:aws:iam::123456789012:user/reviewer")
      const pullRequest = Schema.decodeUnknownSync(ReadClient.CodeCommitPullRequestRevision)({
        pullRequestId: "17",
        revisionId: "revision-17",
        repositoryName: "payments-api",
        title: "Registry wiring",
        authorArn: "arn:aws:iam::123456789012:user/alice",
        status: "OPEN",
        sourceReference: "refs/heads/feature/registry",
        destinationReference: "refs/heads/main",
        sourceCommit: "head-commit-17",
        destinationCommit: "base-commit-17",
        mergeBase: "base-commit-17",
        creationDate: new Date("2026-07-18T08:00:00.000Z"),
        lastActivityDate: new Date("2026-07-18T09:00:00.000Z")
      })
      const readClient = Layer.succeed(ReadClient.CodeCommitReadClient, {
        discoverAccount: () =>
          Ref.get(identityArn).pipe(
            Effect.map((arn) =>
              new ReadClient.CodeCommitAccountIdentity({
                accountId: "123456789012",
                arn
              })
            )
          ),
        listRepositoriesPage: () =>
          Effect.succeed(
            new ReadClient.CodeCommitRepositoryPage({
              repositoryNames: [pullRequest.repositoryName],
              nextToken: null
            })
          ),
        getBlob: () => Effect.die("unused getBlob"),
        listPullRequestsPage: () =>
          Effect.succeed(new ReadClient.CodeCommitPullRequestPage({ pullRequests: [pullRequest], nextToken: null })),
        streamPullRequests: () => Stream.make(pullRequest),
        getPullRequest: () => Ref.update(readCalls, (count) => count + 1).pipe(Effect.as(pullRequest)),
        getChangedFilesPage: () => Effect.die("unused getChangedFilesPage"),
        streamChangedFiles: () => Stream.empty
      })
      const reviewProvider = Layer.succeed(ReviewClient.CodeCommitReviewProvider, {
        postComment: (action) =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({
              comment: {
                commentId: "registry-comment-1",
                clientRequestToken: action.clientRequestToken
              }
            })
          ),
        updateApprovalState: () => Effect.die("unused updateApprovalState"),
        getApprovalStates: () => Effect.die("unused getApprovalStates"),
        getCommentsPage: () => Effect.die("unused getCommentsPage")
      })
      const reviewClient = ReviewClient.CodeCommitReviewClient.layer.pipe(
        Layer.provide(Layer.merge(readClient, reviewProvider))
      )
      const clients = Layer.merge(readClient, reviewClient)
      const config = yield* makePersistenceTestConfig("control-center-first-party-codecommit-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
      const governedActions = GovernedActionRepository.layer.pipe(Layer.provide(foundation))
      const deliveryGraph = DeliveryGraphRepository.layer.pipe(Layer.provide(foundation))
      const runtimeAuthority = pluginRuntimeAuthoritySourceLayer.pipe(Layer.provide(foundation))
      const dependencies = Layer.mergeAll(
        persistence,
        database,
        foundation,
        governedActions,
        deliveryGraph,
        runtimeAuthority,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient([]))
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        yield* persistenceService.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Delivery"),
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: CONNECTION_ID,
          providerId: "codecommit",
          displayName: PluginConnectionDisplayName.make("Payments CodeCommit"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "text", key: "profile", value: "production" },
          { _tag: "text", key: "region", value: "eu-west-1" },
          { _tag: "text", key: "repositoryName", value: "payments-api" }
        ])
        yield* persistenceService.pluginConfigurations.update(
          WORKSPACE_ID,
          CONNECTION_ID,
          configuration,
          0,
          CREATED_AT
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          CONNECTION_ID,
          "codecommit",
          codeCommitPluginDefinition.rawDescriptor,
          0,
          CREATED_AT
        )

        const registry = yield* PluginRuntimeRegistry
        const result = yield* Effect.gen(function*() {
          const authority = yield* PluginRuntimeAuthority
          return { authority }
        }).pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: CONNECTION_ID
          }))),
          Effect.scoped
        )
        const repeatedAuthority = yield* Effect.gen(function*() {
          return yield* PluginRuntimeAuthority
        }).pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: CONNECTION_ID
          }))),
          Effect.scoped
        )
        assert.strictEqual(repeatedAuthority, result.authority)

        yield* Ref.set(identityArn, "arn:aws:iam::123456789012:role/rotated-reviewer")
        const rotatedAuthority = yield* Effect.gen(function*() {
          return yield* PluginRuntimeAuthority
        }).pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: CONNECTION_ID
          }))),
          Effect.scoped
        )
        yield* Ref.set(identityArn, "arn:aws:iam::123456789012:user/reviewer")
        const refreshedAuthority = yield* Effect.gen(function*() {
          return yield* PluginRuntimeAuthority
        }).pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: CONNECTION_ID
          }))),
          Effect.scoped
        )
        assert.notStrictEqual(rotatedAuthority, result.authority)
        assert.notStrictEqual(refreshedAuthority, result.authority)
        assert.notStrictEqual(refreshedAuthority, rotatedAuthority)

        yield* TestClock.setTime(DateTime.toEpochMillis(
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")
        ))
        yield* seedGovernedActionAuthorityRoots("codecommit")
        const governedConfiguration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "text", key: "profile", value: "production" },
          { _tag: "text", key: "region", value: "eu-west-1" },
          { _tag: "text", key: "repositoryName", value: "payments-api" }
        ])
        yield* persistenceService.pluginConfigurations.update(
          GOVERNED_WORKSPACE,
          GOVERNED_CONNECTION,
          governedConfiguration,
          0,
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          GOVERNED_WORKSPACE,
          GOVERNED_CONNECTION,
          "codecommit",
          codeCommitPluginDefinition.rawDescriptor,
          0,
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
        )
        const governedAuthority = yield* Effect.gen(function*() {
          return yield* PluginRuntimeAuthority
        }).pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: GOVERNED_WORKSPACE,
            pluginConnectionId: GOVERNED_CONNECTION
          }))),
          Effect.scoped
        )
        yield* seedGovernedAction({
          pluginConnectionAuthorityDigest: governedAuthority,
          seedAuthorityRoots: false,
          variant: "codecommit"
        })
        yield* seedGovernedActionCurrentInputs("codecommit")

        const registryLayer = Layer.succeed(PluginRuntimeRegistry, registry)
        const runtimeMap = PluginRuntimeMap.layer.pipe(Layer.provide(registryLayer))
        const executors = AuthorizedPluginExecutorMap.layer.pipe(Layer.provide(runtimeMap))
        const store = governedActionExecutionStoreLayer(GOVERNED_WORKSPACE).pipe(
          Layer.provideMerge(pluginRuntimeAuthoritySourceLayer),
          Layer.provideMerge(GovernedActionPolicyEvaluator.layer),
          Layer.provideMerge(QuarantineRepository.layer)
        )
        const engineLayer = GovernedActionExecutionEngine.layer.pipe(
          Layer.provide(store),
          Layer.provide(executors)
        )
        const execution = yield* Effect.gen(function*() {
          const engine = yield* GovernedActionExecutionEngine
          return yield* engine.run({
            workspaceId: GOVERNED_WORKSPACE,
            actionId: GOVERNED_ACTION
          })
        }).pipe(Effect.provide(engineLayer))
        const governedActionRepository = yield* GovernedActionRepository
        const governedRecord = yield* governedActionRepository.read({
          workspaceId: GOVERNED_WORKSPACE,
          actionId: GOVERNED_ACTION
        })

        assert.deepStrictEqual(execution, { _tag: "advanced", state: "succeeded" })
        assert.strictEqual(governedRecord.head.state, "succeeded")
        assert.strictEqual(governedRecord.head.lineage._tag, "terminal")
        if (governedRecord.head.lineage._tag === "terminal") {
          assert.strictEqual(governedRecord.head.lineage.receipt.status, "succeeded")
        }
        assert.strictEqual(yield* Ref.get(readCalls), 2)
        assert.strictEqual(yield* Ref.get(mutationCalls), 1)

        yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: UNCONFIGURED_CONNECTION_ID,
          providerId: "codecommit",
          displayName: PluginConnectionDisplayName.make("Historical CodeCommit"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConfigurations.update(
          WORKSPACE_ID,
          UNCONFIGURED_CONNECTION_ID,
          configuration,
          0,
          CREATED_AT
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          UNCONFIGURED_CONNECTION_ID,
          "codecommit",
          historicalCodeCommitDescriptor,
          0,
          CREATED_AT
        )
        const historicalConnection = yield* Effect.gen(function*() {
          return yield* PluginConnection
        }).pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: UNCONFIGURED_CONNECTION_ID
          }))),
          Effect.scoped
        )
        assert.isFalse(hasPluginCapability(historicalConnection.descriptor, "action.execute", 1))

        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: PREVIOUS_CODECOMMIT_CONNECTION_ID,
          providerId: "codecommit",
          displayName: PluginConnectionDisplayName.make("Previous action-capable CodeCommit"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConfigurations.update(
          WORKSPACE_ID,
          PREVIOUS_CODECOMMIT_CONNECTION_ID,
          configuration,
          0,
          CREATED_AT
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          PREVIOUS_CODECOMMIT_CONNECTION_ID,
          "codecommit",
          historicalCompleteDiffCodeCommitDescriptor,
          0,
          CREATED_AT
        )
        const previousConnection = yield* Effect.gen(function*() {
          return yield* PluginConnection
        }).pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: PREVIOUS_CODECOMMIT_CONNECTION_ID
          }))),
          Effect.scoped
        )
        const previousCapabilities = [
          "action.propose",
          "action.execute",
          "action.reconcile",
          "diff.inventory",
          "diff.content"
        ] satisfies ReadonlyArray<Parameters<typeof hasPluginCapability>[1]>
        for (const capabilityId of previousCapabilities) {
          assert.isTrue(hasPluginCapability(previousConnection.descriptor, capabilityId, 1))
        }
        assert.isFalse(hasPluginCapability(previousConnection.descriptor, "diff.content", 2))

        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: FUTURE_CODECOMMIT_CONNECTION_ID,
          providerId: "codecommit",
          displayName: PluginConnectionDisplayName.make("Unknown future CodeCommit"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConfigurations.update(
          WORKSPACE_ID,
          FUTURE_CODECOMMIT_CONNECTION_ID,
          configuration,
          0,
          CREATED_AT
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          FUTURE_CODECOMMIT_CONNECTION_ID,
          "codecommit",
          {
            ...historicalActionCodeCommitDescriptor,
            capabilities: [
              ...historicalActionCodeCommitDescriptor.capabilities,
              {
                capabilityId: "action.cancel",
                supportedVersions: [1],
                requirement: "required"
              }
            ]
          },
          0,
          CREATED_AT
        )
        const futureResult = yield* Effect.gen(function*() {
          return yield* PluginConnection
        }).pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: FUTURE_CODECOMMIT_CONNECTION_ID
          }))),
          Effect.scoped,
          Effect.result
        )
        assert.strictEqual(futureResult._tag, "Failure")
        if (futureResult._tag === "Failure") {
          assert.strictEqual(futureResult.failure._tag, "PluginConfigurationFailure")
          if (futureResult.failure._tag === "PluginConfigurationFailure") {
            assert.strictEqual(futureResult.failure.diagnosticCode, "plugin-runtime-source-mismatch")
          }
        }
      }).pipe(
        Effect.provide(makeFirstPartyPluginRuntimeRegistry(clients)),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("keeps the current Jira runtime proposal-only in the production registry", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
      const config = yield* makePersistenceTestConfig("control-center-first-party-jira-proposal-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
      const runtimeAuthority = pluginRuntimeAuthoritySourceLayer.pipe(Layer.provide(foundation))
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const dependencies = Layer.mergeAll(
        persistence,
        database,
        foundation,
        runtimeAuthority,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient(requests))
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        const secretStore = yield* SecretStore
        const apiTokenRef = yield* secretStore.create(new TextEncoder().encode("atlassian-token"))
        yield* persistenceService.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Delivery"),
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: CONNECTION_ID,
          providerId: "jira",
          displayName: PluginConnectionDisplayName.make("Payments Jira"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "secret-reference", key: "apiToken", ref: apiTokenRef },
          { _tag: "text", key: "authMode", value: "api-token" },
          { _tag: "text", key: "email", value: "owner@example.com" },
          { _tag: "integer", key: "maximumPages", value: 3 },
          { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
          { _tag: "integer", key: "pageSize", value: 10 },
          { _tag: "text", key: "projectId", value: "project-1" },
          { _tag: "text", key: "siteId", value: "cloud-1" },
          { _tag: "url", key: "webBaseUrl", value: "https://knpkv.atlassian.net/" }
        ])
        yield* persistenceService.pluginConfigurations.update(
          WORKSPACE_ID,
          CONNECTION_ID,
          configuration,
          0,
          CREATED_AT
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          CONNECTION_ID,
          "jira",
          jiraReadPluginDescriptor,
          0,
          CREATED_AT
        )
        const registry = yield* PluginRuntimeRegistry
        const connection = yield* Effect.gen(function*() {
          return yield* PluginConnection
        }).pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: CONNECTION_ID
          }))),
          Effect.scoped
        )

        assert.deepStrictEqual(
          connection.descriptor.capabilities.map(({ capabilityId }) => capabilityId),
          ["entity.read", "sync.incremental", "action.propose"]
        )
        assert.isFalse(hasPluginCapability(connection.descriptor, "action.execute", 1))
        assert.isFalse(hasPluginCapability(connection.descriptor, "action.reconcile", 1))
        assert.lengthOf(requests, 0)
      }).pipe(
        Effect.provide(makeFirstPartyPluginRuntimeRegistry(unusedCodeCommitClients)),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("executes an authorized Confluence publication through the production registry exactly once", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(
        Schema.decodeSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")
      ))
      const readCalls = yield* Ref.make(0)
      const mutationCalls = yield* Ref.make(0)
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          const currentPage = {
            id: "42",
            status: "current",
            title: "Payments release runbook",
            spaceId: "space-payments",
            createdAt: "2026-07-15T09:00:00.000Z",
            version: {
              number: 3,
              createdAt: "2026-07-15T09:50:00.000Z",
              message: "Initial publication"
            }
          }
          if (
            request.method === "GET" &&
            request.url.endsWith("/wiki/api/v2/pages/42") &&
            new Map(request.urlParams).get("get-draft") === "true"
          ) {
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ message: "No draft" }), {
                status: 404,
                headers: { "content-type": "application/json" }
              })
            )
          }
          if (request.method === "GET" && request.url.endsWith("/wiki/api/v2/pages/42")) {
            yield* Ref.update(readCalls, (count) => count + 1)
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(currentPage), {
                status: 200,
                headers: { "content-type": "application/json" }
              })
            )
          }
          if (request.method === "PUT" && request.url.endsWith("/wiki/api/v2/pages/42")) {
            yield* Ref.update(mutationCalls, (count) => count + 1)
            if (request.body._tag !== "Uint8Array") return yield* Effect.die("missing Confluence update body")
            const payload = Schema.decodeUnknownSync(Schema.Struct({
              title: Schema.String,
              version: Schema.Struct({
                number: Schema.Int,
                message: Schema.String
              })
            }))(JSON.parse(new TextDecoder().decode(request.body.body)))
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  ...currentPage,
                  title: payload.title,
                  version: {
                    ...currentPage.version,
                    number: payload.version.number,
                    message: payload.version.message,
                    createdAt: "2026-07-15T10:02:00.000Z"
                  }
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" }
                }
              )
            )
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ message: "unexpected request" }), {
              status: 500,
              headers: { "content-type": "application/json" }
            })
          )
        })
      )
      const config = yield* makePersistenceTestConfig("control-center-first-party-confluence-governed-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
      const governedActions = GovernedActionRepository.layer.pipe(Layer.provide(foundation))
      const deliveryGraph = DeliveryGraphRepository.layer.pipe(Layer.provide(foundation))
      const runtimeAuthority = pluginRuntimeAuthoritySourceLayer.pipe(Layer.provide(foundation))
      const dependencies = Layer.mergeAll(
        persistence,
        database,
        foundation,
        governedActions,
        deliveryGraph,
        runtimeAuthority,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, httpClient)
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        const secretStore = yield* SecretStore
        yield* seedGovernedActionAuthorityRoots("confluence")
        const apiTokenRef = yield* secretStore.create(new TextEncoder().encode("atlassian-token"))
        const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "secret-reference", key: "apiToken", ref: apiTokenRef },
          { _tag: "text", key: "authMode", value: "api-token" },
          { _tag: "text", key: "email", value: "owner@example.com" },
          { _tag: "text", key: "probePageId", value: "42" },
          { _tag: "url", key: "siteBaseUrl", value: "https://acme.atlassian.net/" },
          { _tag: "text", key: "siteId", value: "site-acme" },
          { _tag: "text", key: "spaceId", value: "space-payments" }
        ])
        yield* persistenceService.pluginConfigurations.update(
          GOVERNED_WORKSPACE,
          GOVERNED_CONNECTION,
          configuration,
          0,
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          GOVERNED_WORKSPACE,
          GOVERNED_CONNECTION,
          "confluence",
          confluencePagePluginDescriptor,
          0,
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
        )

        const registry = yield* PluginRuntimeRegistry
        const authority = yield* PluginRuntimeAuthority.pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: GOVERNED_WORKSPACE,
            pluginConnectionId: GOVERNED_CONNECTION
          }))),
          Effect.scoped
        )
        yield* seedGovernedAction({
          pluginConnectionAuthorityDigest: authority,
          seedAuthorityRoots: false,
          variant: "confluence"
        })
        yield* seedGovernedActionCurrentInputs("confluence")

        const registryLayer = Layer.succeed(PluginRuntimeRegistry, registry)
        const runtimeMap = PluginRuntimeMap.layer.pipe(Layer.provide(registryLayer))
        const executors = AuthorizedPluginExecutorMap.layer.pipe(Layer.provide(runtimeMap))
        const store = governedActionExecutionStoreLayer(GOVERNED_WORKSPACE).pipe(
          Layer.provideMerge(pluginRuntimeAuthoritySourceLayer),
          Layer.provideMerge(GovernedActionPolicyEvaluator.layer),
          Layer.provideMerge(QuarantineRepository.layer)
        )
        const execution = yield* Effect.gen(function*() {
          const engine = yield* GovernedActionExecutionEngine
          return yield* engine.run({
            workspaceId: GOVERNED_WORKSPACE,
            actionId: GOVERNED_ACTION
          })
        }).pipe(
          Effect.provide(GovernedActionExecutionEngine.layer.pipe(
            Layer.provide(store),
            Layer.provide(executors)
          ))
        )
        const governedActionRepository = yield* GovernedActionRepository
        const record = yield* governedActionRepository.read({
          workspaceId: GOVERNED_WORKSPACE,
          actionId: GOVERNED_ACTION
        })

        assert.deepStrictEqual(execution, { _tag: "advanced", state: "succeeded" })
        assert.strictEqual(record.head.state, "succeeded")
        assert.strictEqual(record.head.lineage._tag, "terminal")
        if (record.head.lineage._tag === "terminal") {
          assert.strictEqual(record.head.lineage.receipt.status, "succeeded")
        }
        assert.strictEqual(yield* Ref.get(readCalls), 1)
        assert.strictEqual(yield* Ref.get(mutationCalls), 1)
      }).pipe(
        Effect.provide(makeFirstPartyPluginRuntimeRegistry(unusedCodeCommitClients)),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("starts from a synchronized durable pipeline authority and blocks stale definitions", () => {
    const runScenario = (mode: "current" | "rotated" | "stale") =>
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")
        ))
        const pipelineVersion = yield* Ref.make(7)
        const mutationCalls = yield* Ref.make(0)
        const mutationIdentity = mode === "rotated"
          ? {
            accountId: "210987654321",
            arn: "arn:aws:iam::210987654321:role/rotated-control-center"
          }
          : {
            accountId: "123456789012",
            arn: "arn:aws:sts::123456789012:assumed-role/control-center/mutation-session"
          }
        const pipelineFor = (version: number): CodePipelinePipeline => ({
          name: "release",
          arn: "arn:aws:codepipeline:eu-west-1:123456789012:release",
          version,
          pipelineType: "V2",
          executionMode: "SUPERSEDED",
          createdAt: new Date("2026-07-15T08:00:00.000Z"),
          updatedAt: new Date(
            version === 7
              ? "2026-07-15T09:40:00.000Z"
              : "2026-07-15T09:41:00.000Z"
          ),
          variables: [],
          stages: [{
            name: "Source",
            actions: [{
              name: "Checkout",
              actionType: {
                category: "Source",
                owner: "AWS",
                provider: "CodeCommit",
                version: "1"
              },
              allowS3ObjectKeyOverride: false,
              runOrder: 1,
              region: "eu-west-1",
              roleArn: null,
              inputArtifactNames: [],
              outputArtifactNames: ["Source"]
            }]
          }]
        })
        const codePipelineClient: CodePipelineReadClientService = {
          discoverAccount: () =>
            Effect.succeed({
              accountId: "123456789012",
              arn: "arn:aws:sts::123456789012:assumed-role/control-center/start-session"
            }),
          getPipeline: () => Ref.get(pipelineVersion).pipe(Effect.map(pipelineFor)),
          listExecutionsPage: () =>
            Effect.succeed({
              executions: [],
              nextToken: null,
              providerPageLimit: 1
            }),
          listPipelinesPage: () => Effect.die("unused listPipelinesPage"),
          findActionExecution: () => Effect.die("unused findActionExecution"),
          getExecutionSnapshot: () => Effect.die("unused getExecutionSnapshot"),
          getPipelineState: () => Effect.die("unused getPipelineState"),
          getLogPage: () => Effect.die("unused getLogPage"),
          getArtifactRange: () => Effect.die("unused getArtifactRange"),
          startPipelineExecution: (request) =>
            codePipelineRuntimeIdentityMatches(request.runtimeIdentity, mutationIdentity)
              ? Ref.update(mutationCalls, (count) => count + 1).pipe(
                Effect.as("execution-started-from-declaration")
              )
              : Effect.fail(
                new PluginConflictFailure({
                  operation: "codepipeline-start-execution",
                  diagnosticCode: "codepipeline-runtime-identity-changed"
                })
              ),
          stopPipelineExecution: () => Effect.die("unused stopPipelineExecution"),
          putApprovalResult: () => Effect.die("unused putApprovalResult")
        }
        const config = yield* makePersistenceTestConfig(
          `control-center-first-party-codepipeline-start-${mode}-`
        )
        const root = config.blobRoot.slice(0, -"/blobs".length)
        const database = databaseLayer(config)
        const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
        const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
        const governedActions = GovernedActionRepository.layer.pipe(Layer.provide(foundation))
        const deliveryGraph = DeliveryGraphRepository.layer.pipe(Layer.provide(foundation))
        const runtimeAuthority = pluginRuntimeAuthoritySourceLayer.pipe(Layer.provide(foundation))
        const dependencies = Layer.mergeAll(
          persistence,
          database,
          foundation,
          governedActions,
          deliveryGraph,
          runtimeAuthority,
          SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
          Layer.succeed(HttpClient.HttpClient, fakeClockifyClient([]))
        )

        return yield* Effect.gen(function*() {
          const persistenceService = yield* Persistence
          yield* seedGovernedActionAuthorityRoots("codepipeline-start")
          const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
            { _tag: "integer", key: "actionPageSize", value: 20 },
            { _tag: "integer", key: "maximumActionPages", value: 2 },
            { _tag: "integer", key: "maximumActionsPerExecution", value: 40 },
            { _tag: "integer", key: "maximumExecutionPages", value: 2 },
            { _tag: "integer", key: "maximumLogBytes", value: 262_144 },
            { _tag: "integer", key: "operationTimeoutMillis", value: 10_000 },
            { _tag: "text", key: "pipelineName", value: "release" },
            { _tag: "text", key: "profile", value: "production" },
            { _tag: "text", key: "region", value: "eu-west-1" }
          ])
          const synchronizedAt = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
          yield* persistenceService.pluginConfigurations.update(
            GOVERNED_WORKSPACE,
            GOVERNED_CONNECTION,
            configuration,
            0,
            synchronizedAt
          )
          yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
            GOVERNED_WORKSPACE,
            GOVERNED_CONNECTION,
            "codepipeline",
            codePipelinePluginDefinition.rawDescriptor,
            0,
            synchronizedAt
          )

          const registry = yield* PluginRuntimeRegistry
          const authority = yield* PluginRuntimeAuthority.pipe(
            Effect.provide(registry.layer(pluginRuntimeKey({
              workspaceId: GOVERNED_WORKSPACE,
              pluginConnectionId: GOVERNED_CONNECTION
            }))),
            Effect.scoped
          )
          const syncRequest = Schema.decodeUnknownSync(PluginSyncRequestV1)({
            streamKey: "executions",
            checkpoint: null
          })
          const pages = yield* Effect.gen(function*() {
            const connection = yield* PluginConnection
            return yield* connection.sync(syncRequest).pipe(Stream.runCollect)
          }).pipe(
            Effect.provide(registry.layer(pluginRuntimeKey({
              workspaceId: GOVERNED_WORKSPACE,
              pluginConnectionId: GOVERNED_CONNECTION
            }))),
            Effect.scoped
          )
          assert.strictEqual(pages.length, 1)
          const page = pages[0]
          if (page === undefined) return yield* Effect.die("expected one CodePipeline synchronization page")
          yield* materializeNormalizedPluginPage({
            workspaceId: GOVERNED_WORKSPACE,
            pluginConnectionId: GOVERNED_CONNECTION,
            providerId: "codepipeline",
            streamKey: PluginStreamKey.make("executions"),
            expectedRevision: 0,
            committedAt: synchronizedAt,
            successfulHealth: { _tag: "healthy", checkedAt: synchronizedAt }
          }, page)
          const target = yield* persistenceService.entities.findBySourceIdentity(
            GOVERNED_WORKSPACE,
            {
              pluginConnectionId: GOVERNED_CONNECTION,
              providerId: "codepipeline",
              vendorImmutableId: VendorImmutableId.make(
                "arn:aws:codepipeline:eu-west-1:123456789012:release"
              )
            }
          )
          assert.strictEqual(target.entityType, "pipeline")
          assert.strictEqual(target.sourceRevision.revision, "7:2026-07-15T09:40:00.000Z")
          yield* seedGovernedAction({
            pluginConnectionAuthorityDigest: authority,
            seedAuthorityRoots: false,
            targetEntityId: target.entityId,
            variant: "codepipeline-start"
          })
          if (mode === "stale") yield* Ref.set(pipelineVersion, 8)

          const registryLayer = Layer.succeed(PluginRuntimeRegistry, registry)
          const runtimeMap = PluginRuntimeMap.layer.pipe(Layer.provide(registryLayer))
          const executors = AuthorizedPluginExecutorMap.layer.pipe(Layer.provide(runtimeMap))
          const store = governedActionExecutionStoreLayer(GOVERNED_WORKSPACE).pipe(
            Layer.provideMerge(pluginRuntimeAuthoritySourceLayer),
            Layer.provideMerge(GovernedActionPolicyEvaluator.layer),
            Layer.provideMerge(QuarantineRepository.layer)
          )
          const execution = yield* Effect.gen(function*() {
            const engine = yield* GovernedActionExecutionEngine
            return yield* engine.run({
              workspaceId: GOVERNED_WORKSPACE,
              actionId: GOVERNED_ACTION
            })
          }).pipe(
            Effect.provide(GovernedActionExecutionEngine.layer.pipe(
              Layer.provide(store),
              Layer.provide(executors)
            ))
          )
          const record = yield* GovernedActionRepository.pipe(
            Effect.flatMap((repository) =>
              repository.read({
                workspaceId: GOVERNED_WORKSPACE,
                actionId: GOVERNED_ACTION
              })
            )
          )
          return {
            execution,
            mutationCalls: yield* Ref.get(mutationCalls),
            record
          }
        }).pipe(
          Effect.provide(makeFirstPartyPluginRuntimeRegistry(unusedCodeCommitClients, codePipelineClient)),
          Effect.provide(dependencies)
        )
      })

    return Effect.gen(function*() {
      const current = yield* runScenario("current")
      assert.deepStrictEqual(current.execution, { _tag: "advanced", state: "started" })
      assert.strictEqual(current.record.head.state, "started")
      assert.strictEqual(current.record.head.lineage._tag, "accepted")
      assert.strictEqual(current.mutationCalls, 1)

      const rotated = yield* runScenario("rotated")
      assert.deepStrictEqual(rotated.execution, { _tag: "advanced", state: "failed" })
      assert.strictEqual(rotated.record.head.state, "failed")
      assert.strictEqual(rotated.record.head.lineage._tag, "terminal")
      if (rotated.record.head.lineage._tag === "terminal") {
        assert.strictEqual(rotated.record.head.lineage.receipt.status, "failed")
        assert.include(rotated.record.head.lineage.receipt.providerOperationId, "rejected:start:")
      }
      assert.strictEqual(rotated.mutationCalls, 0)

      const stale = yield* runScenario("stale")
      assert.deepStrictEqual(stale.execution, { _tag: "advanced", state: "denied" })
      assert.strictEqual(stale.record.head.state, "denied")
      assert.strictEqual(stale.mutationCalls, 0)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)
  })

  it.effect("folds a deterministic CodePipeline rejection through the production registry exactly once", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(
        Schema.decodeSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")
      ))
      const mutationCalls = yield* Ref.make(0)
      const logCalls = yield* Ref.make(0)
      const artifactCalls = yield* Ref.make(0)
      const identityArn = yield* Ref.make(
        "arn:aws:sts::123456789012:assumed-role/control-center/registry-session"
      )
      const identityCalls = yield* Ref.make(0)
      const pipeline = {
        name: "release",
        arn: "arn:aws:codepipeline:eu-west-1:123456789012:release",
        version: 7,
        pipelineType: "V2",
        executionMode: "SUPERSEDED",
        createdAt: new Date("2026-07-15T08:00:00.000Z"),
        updatedAt: new Date("2026-07-15T09:40:00.000Z"),
        variables: [],
        stages: [{
          name: "Source",
          actions: [{
            name: "Checkout",
            actionType: {
              category: "Source",
              owner: "AWS",
              provider: "CodeCommit",
              version: "1"
            },
            allowS3ObjectKeyOverride: false,
            runOrder: 1,
            region: "eu-west-1",
            roleArn: null,
            inputArtifactNames: [],
            outputArtifactNames: ["Source"]
          }]
        }]
      } satisfies CodePipelinePipeline
      const snapshot = {
        execution: {
          pipelineName: "release",
          pipelineVersion: 7,
          executionId: "execution-failed-1",
          status: "Failed",
          statusSummary: "Build failed",
          updatedAt: new Date("2026-07-15T09:50:00.000Z"),
          artifactRevisions: [{
            name: "Source",
            revisionId: "commit-abc",
            revisionSummary: "main",
            createdAt: new Date("2026-07-15T09:44:00.000Z")
          }],
          variables: [],
          triggerType: "StartPipelineExecution",
          triggerDetail: "release-operator",
          executionMode: "SUPERSEDED",
          executionType: "STANDARD",
          rollbackTargetExecutionId: null
        },
        summary: {
          executionId: "execution-failed-1",
          status: "Failed",
          statusSummary: "Build failed",
          startedAt: new Date("2026-07-15T09:45:00.000Z"),
          updatedAt: new Date("2026-07-15T09:50:00.000Z"),
          sourceRevisions: [{
            actionName: "Checkout",
            revisionId: "commit-abc",
            revisionSummary: "main"
          }],
          triggerType: "StartPipelineExecution",
          triggerDetail: "release-operator",
          executionMode: "SUPERSEDED",
          executionType: "STANDARD",
          rollbackTargetExecutionId: null
        },
        actionCollection: {
          actions: [{
            executionId: "execution-failed-1",
            actionExecutionId: "execution-failed-1-action-1",
            pipelineVersion: 7,
            stageName: "Build",
            actionName: "Compile",
            status: "Failed",
            startedAt: new Date("2026-07-15T09:45:00.000Z"),
            updatedAt: new Date("2026-07-15T09:50:00.000Z"),
            updatedBy: null,
            actionType: {
              category: "Build",
              owner: "AWS",
              provider: "CodeBuild",
              version: "1"
            },
            roleArn: null,
            region: "eu-west-1",
            inputArtifacts: [],
            outputArtifacts: [{
              name: "BuildOutput",
              bucket: "private-artifacts",
              key: "build.zip",
              access: "proxy-required"
            }],
            externalExecutionId: null,
            externalExecutionSummary: null,
            errorCode: null,
            errorMessage: null,
            logStreamArn: "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/codebuild/release:log-stream:build"
          }],
          truncated: false,
          pagesRead: 1
        }
      } satisfies CodePipelineExecutionSnapshot
      const codePipelineClient: CodePipelineReadClientService = {
        discoverAccount: () =>
          Effect.all([
            Ref.update(identityCalls, (count) => count + 1),
            Ref.get(identityArn)
          ]).pipe(
            Effect.map(([, arn]) => ({
              accountId: "123456789012",
              arn
            }))
          ),
        getPipeline: () => Effect.succeed(pipeline),
        listExecutionsPage: () => Effect.die("unused listExecutionsPage"),
        listPipelinesPage: () => Effect.die("unused listPipelinesPage"),
        findActionExecution: () => Effect.die("unused findActionExecution"),
        getExecutionSnapshot: () => Effect.succeed(snapshot),
        getPipelineState: () => Effect.die("unused getPipelineState"),
        getLogPage: () =>
          Ref.update(logCalls, (count) => count + 1).pipe(
            Effect.as({ events: [], nextToken: null })
          ),
        getArtifactRange: () =>
          Ref.update(artifactCalls, (count) => count + 1).pipe(
            Effect.as({ bytesBase64: "AQID", totalBytes: 3 })
          ),
        startPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.andThen(
              Effect.fail(
                new PluginConflictFailure({
                  operation: "codepipeline-start-execution",
                  diagnosticCode: "codepipeline-provider-state-conflict"
                })
              )
            )
          ),
        stopPipelineExecution: () => Effect.die("unused stopPipelineExecution"),
        putApprovalResult: () => Effect.die("unused putApprovalResult")
      }
      const config = yield* makePersistenceTestConfig("control-center-first-party-codepipeline-governed-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
      const governedActions = GovernedActionRepository.layer.pipe(Layer.provide(foundation))
      const deliveryGraph = DeliveryGraphRepository.layer.pipe(Layer.provide(foundation))
      const runtimeAuthority = pluginRuntimeAuthoritySourceLayer.pipe(Layer.provide(foundation))
      const dependencies = Layer.mergeAll(
        persistence,
        database,
        foundation,
        governedActions,
        deliveryGraph,
        runtimeAuthority,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient([]))
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        yield* seedGovernedActionAuthorityRoots("codepipeline")
        const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "integer", key: "actionPageSize", value: 20 },
          { _tag: "integer", key: "maximumActionPages", value: 2 },
          { _tag: "integer", key: "maximumActionsPerExecution", value: 40 },
          { _tag: "integer", key: "maximumExecutionPages", value: 2 },
          { _tag: "integer", key: "maximumLogBytes", value: 262_144 },
          { _tag: "integer", key: "operationTimeoutMillis", value: 10_000 },
          { _tag: "text", key: "pipelineName", value: "release" },
          { _tag: "text", key: "profile", value: "production" },
          { _tag: "text", key: "region", value: "eu-west-1" }
        ])
        yield* persistenceService.pluginConfigurations.update(
          GOVERNED_WORKSPACE,
          GOVERNED_CONNECTION,
          configuration,
          0,
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          GOVERNED_WORKSPACE,
          GOVERNED_CONNECTION,
          "codepipeline",
          codePipelinePluginDefinition.rawDescriptor,
          0,
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
        )

        const registry = yield* PluginRuntimeRegistry
        const authority = yield* PluginRuntimeAuthority.pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: GOVERNED_WORKSPACE,
            pluginConnectionId: GOVERNED_CONNECTION
          }))),
          Effect.scoped
        )
        assert.strictEqual(yield* Ref.get(identityCalls), 1)
        yield* Ref.set(
          identityArn,
          "arn:aws:sts::123456789012:assumed-role/control-center/executor-session"
        )
        yield* seedGovernedAction({
          pluginConnectionAuthorityDigest: authority,
          seedAuthorityRoots: false,
          variant: "codepipeline"
        })
        yield* seedGovernedActionCurrentInputs("codepipeline")

        const registryLayer = Layer.succeed(PluginRuntimeRegistry, registry)
        const runtimeMap = PluginRuntimeMap.layer.pipe(Layer.provide(registryLayer))
        const executors = AuthorizedPluginExecutorMap.layer.pipe(Layer.provide(runtimeMap))
        const store = governedActionExecutionStoreLayer(GOVERNED_WORKSPACE).pipe(
          Layer.provideMerge(pluginRuntimeAuthoritySourceLayer),
          Layer.provideMerge(GovernedActionPolicyEvaluator.layer),
          Layer.provideMerge(QuarantineRepository.layer)
        )
        const execution = yield* Effect.gen(function*() {
          const engine = yield* GovernedActionExecutionEngine
          return yield* engine.run({
            workspaceId: GOVERNED_WORKSPACE,
            actionId: GOVERNED_ACTION
          })
        }).pipe(
          Effect.provide(GovernedActionExecutionEngine.layer.pipe(
            Layer.provide(store),
            Layer.provide(executors)
          ))
        )
        const governedActionRepository = yield* GovernedActionRepository
        const record = yield* governedActionRepository.read({
          workspaceId: GOVERNED_WORKSPACE,
          actionId: GOVERNED_ACTION
        })

        assert.deepStrictEqual(execution, { _tag: "advanced", state: "failed" })
        assert.strictEqual(record.head.state, "failed")
        assert.strictEqual(record.head.lineage._tag, "terminal")
        if (record.head.lineage._tag === "terminal") {
          assert.strictEqual(record.head.lineage.receipt.status, "failed")
          assert.include(record.head.lineage.receipt.providerOperationId, "rejected:retry:")
          assert.include(record.head.lineage.receipt.safeSummary, "without applying")
        }
        const stableAuthority = yield* PluginRuntimeAuthority.pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: GOVERNED_WORKSPACE,
            pluginConnectionId: GOVERNED_CONNECTION
          }))),
          Effect.scoped
        )
        const identityCallsBeforePinnedRuntime = yield* Ref.get(identityCalls)
        const blockedAfterIdentityChange = yield* Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          assert.strictEqual(
            yield* Ref.get(identityCalls),
            identityCallsBeforePinnedRuntime + 1
          )
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.retry",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-failed-1"
              },
              expectedRevision: "7:Failed:2026-07-15T09:50:00.000Z",
              payload: {},
              evidenceIds: []
            })
          )
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "registry-identity-change",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "registry-identity-change-authorization",
            authorizedAt: DateTime.makeUnsafe("2026-07-15T10:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-15T11:00:00.000Z")
          })
          const pipelineCapability = connection.pipeline
          if (pipelineCapability === undefined || Option.isNone(pipelineCapability)) {
            return yield* Effect.die("pipeline evidence capability missing")
          }
          const evidenceAction = {
            entity: {
              entityType: "aws.codepipeline.action",
              vendorImmutableId: "execution-failed-1#execution-failed-1-action-1"
            },
            executionId: "execution-failed-1",
            actionExecutionId: "execution-failed-1-action-1",
            expectedRevision: "Failed:2026-07-15T09:50:00.000Z"
          }
          const logRequest = Schema.decodeUnknownSync(PluginPipelineLogPageRequestV1)({
            action: evidenceAction,
            cursor: null,
            limit: 10
          })
          const artifactRequest = Schema.decodeUnknownSync(PluginPipelineArtifactRangeRequestV1)({
            action: evidenceAction,
            direction: "output",
            artifactName: "BuildOutput",
            offset: 0,
            length: 3
          })
          yield* Ref.set(
            identityArn,
            "arn:aws:sts::123456789012:assumed-role/control-center/evidence-session"
          )
          const sameRoleLogs = yield* pipelineCapability.value.readLogPage(logRequest)
          const sameRoleArtifact = yield* pipelineCapability.value.readArtifactRange(artifactRequest)
          yield* Ref.set(identityArn, "arn:aws:iam::123456789012:role/rotated-control-center")
          const blockedLogs = yield* pipelineCapability.value.readLogPage(logRequest).pipe(Effect.result)
          const blockedArtifact = yield* pipelineCapability.value.readArtifactRange(artifactRequest).pipe(Effect.result)
          const preflight = yield* executor.preflight(authorized).pipe(Effect.result)
          return {
            blockedArtifact,
            blockedLogs,
            preflight,
            sameRoleArtifact,
            sameRoleLogs
          }
        }).pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: GOVERNED_WORKSPACE,
            pluginConnectionId: GOVERNED_CONNECTION
          }))),
          Effect.scoped
        )
        const rotatedAuthority = yield* PluginRuntimeAuthority.pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: GOVERNED_WORKSPACE,
            pluginConnectionId: GOVERNED_CONNECTION
          }))),
          Effect.scoped
        )
        assert.strictEqual(stableAuthority, authority)
        assert.deepStrictEqual(blockedAfterIdentityChange.sameRoleLogs.events, [])
        assert.strictEqual(blockedAfterIdentityChange.sameRoleArtifact.bytesBase64, "AQID")
        assert.strictEqual(blockedAfterIdentityChange.blockedLogs._tag, "Failure")
        if (blockedAfterIdentityChange.blockedLogs._tag === "Failure") {
          assert.strictEqual(blockedAfterIdentityChange.blockedLogs.failure._tag, "PluginConflictFailure")
        }
        assert.strictEqual(blockedAfterIdentityChange.blockedArtifact._tag, "Failure")
        if (blockedAfterIdentityChange.blockedArtifact._tag === "Failure") {
          assert.strictEqual(blockedAfterIdentityChange.blockedArtifact.failure._tag, "PluginConflictFailure")
        }
        assert.strictEqual(blockedAfterIdentityChange.preflight._tag, "Failure")
        if (blockedAfterIdentityChange.preflight._tag === "Failure") {
          assert.strictEqual(blockedAfterIdentityChange.preflight.failure._tag, "PluginConflictFailure")
        }
        assert.notStrictEqual(rotatedAuthority, authority)
        assert.strictEqual(yield* Ref.get(logCalls), 1)
        assert.strictEqual(yield* Ref.get(artifactCalls), 1)
        assert.strictEqual(yield* Ref.get(mutationCalls), 1)
      }).pipe(
        Effect.provide(makeFirstPartyPluginRuntimeRegistry(unusedCodeCommitClients, codePipelineClient)),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("loads a persisted read-only CodePipeline runtime with its historical configuration", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
      const identityCalls = yield* Ref.make(0)
      const historicalClient: CodePipelineReadClientService = {
        discoverAccount: () =>
          Ref.update(identityCalls, (count) => count + 1).pipe(
            Effect.as({
              accountId: "123456789012",
              arn: "arn:aws:iam::123456789012:role/historical-control-center"
            })
          ),
        getPipeline: () => Effect.die("unused getPipeline"),
        listExecutionsPage: () => Effect.die("unused listExecutionsPage"),
        listPipelinesPage: () => Effect.die("unused listPipelinesPage"),
        findActionExecution: () => Effect.die("unused findActionExecution"),
        getExecutionSnapshot: () => Effect.die("unused getExecutionSnapshot"),
        getPipelineState: () => Effect.die("unused getPipelineState"),
        getLogPage: () => Effect.die("unused getLogPage"),
        getArtifactRange: () => Effect.die("unused getArtifactRange"),
        startPipelineExecution: () => Effect.die("unused startPipelineExecution"),
        stopPipelineExecution: () => Effect.die("unused stopPipelineExecution"),
        putApprovalResult: () => Effect.die("unused putApprovalResult")
      }
      const config = yield* makePersistenceTestConfig("control-center-first-party-codepipeline-historical-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
      const runtimeAuthority = pluginRuntimeAuthoritySourceLayer.pipe(Layer.provide(foundation))
      const dependencies = Layer.mergeAll(
        persistence,
        database,
        foundation,
        runtimeAuthority,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient([]))
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        yield* persistenceService.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Historical pipeline"),
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: CONNECTION_ID,
          providerId: "codepipeline",
          displayName: PluginConnectionDisplayName.make("Historical CodePipeline"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        const historicalConfiguration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "integer", key: "actionPageSize", value: 50 },
          { _tag: "integer", key: "maximumActionPages", value: 3 },
          { _tag: "integer", key: "maximumActionsPerExecution", value: 100 },
          { _tag: "integer", key: "maximumExecutionPages", value: 5 },
          { _tag: "integer", key: "operationTimeoutMillis", value: 30_000 },
          { _tag: "text", key: "pipelineName", value: "release" },
          { _tag: "text", key: "profile", value: "production" },
          { _tag: "text", key: "region", value: "eu-west-1" }
        ])
        yield* persistenceService.pluginConfigurations.update(
          WORKSPACE_ID,
          CONNECTION_ID,
          historicalConfiguration,
          0,
          CREATED_AT
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          CONNECTION_ID,
          "codepipeline",
          historicalReadOnlyCodePipelineDescriptor,
          0,
          CREATED_AT
        )

        const registry = yield* PluginRuntimeRegistry
        const connection = yield* PluginConnection.pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: CONNECTION_ID
          }))),
          Effect.scoped
        )

        assert.isTrue(hasPluginCapability(connection.descriptor, "entity.read", 1))
        assert.isFalse(hasPluginCapability(connection.descriptor, "action.execute", 1))
        assert.isFalse(hasPluginCapability(connection.descriptor, "pipeline.logs", 1))
        assert.strictEqual(yield* Ref.get(identityCalls), 1)
      }).pipe(
        Effect.provide(makeFirstPartyPluginRuntimeRegistry(unusedCodeCommitClients, historicalClient)),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it("keeps the historical Confluence descriptor independent of future current fields", () => {
    const futureCurrent = {
      ...confluencePagePluginDescriptor,
      configurationFields: [
        ...confluencePagePluginDescriptor.configurationFields,
        {
          _tag: "text",
          key: "futureField",
          label: "Future field",
          description: "A field added after the historical descriptor was persisted.",
          required: false
        }
      ]
    }

    assert.isTrue(futureCurrent.configurationFields.some(({ key }) => key === "futureField"))
    assert.isFalse(historicalConfluenceOAuthDescriptor.configurationFields.some(({ key }) => key === "futureField"))
    assert.deepStrictEqual(historicalConfluenceOAuthDescriptor.capabilities, [{
      capabilityId: "entity.read",
      supportedVersions: [1],
      requirement: "required"
    }])
    assert.deepStrictEqual(
      historicalConfluenceReadPluginDescriptor.capabilities.map(({ capabilityId }) => capabilityId),
      ["entity.read", "sync.incremental"]
    )
    assert.deepStrictEqual(
      confluencePagePluginDescriptor.capabilities.map(({ capabilityId }) => capabilityId),
      ["entity.read", "sync.incremental", "action.propose", "action.execute", "action.reconcile"]
    )
  })

  it("keeps the historical CodeCommit descriptor independent of future current fields", () => {
    const futureCurrent = {
      ...codeCommitPluginDescriptor,
      configurationFields: [
        ...codeCommitPluginDescriptor.configurationFields,
        {
          _tag: "text",
          key: "futureField",
          label: "Future field",
          description: "A field added after the historical descriptor was persisted.",
          required: false
        }
      ]
    }

    assert.isTrue(futureCurrent.configurationFields.some(({ key }) => key === "futureField"))
    assert.isFalse(historicalCodeCommitDescriptor.configurationFields.some(({ key }) => key === "futureField"))
    assert.deepStrictEqual(
      historicalCodeCommitDescriptor.capabilities.map(({ capabilityId }) => capabilityId),
      ["entity.read", "sync.incremental", "diff.inventory"]
    )
    assert.deepStrictEqual(
      historicalActionCodeCommitDescriptor.capabilities.map(({ capabilityId }) => capabilityId),
      [
        "entity.read",
        "sync.incremental",
        "action.propose",
        "action.execute",
        "action.reconcile",
        "diff.inventory"
      ]
    )
    assert.deepStrictEqual(
      historicalCompleteDiffCodeCommitDescriptor.capabilities.map(({ capabilityId }) => capabilityId),
      [
        "entity.read",
        "sync.incremental",
        "action.propose",
        "action.execute",
        "action.reconcile",
        "diff.inventory",
        "diff.content"
      ]
    )
  })

  it("keeps the historical CodePipeline descriptor independent of current governed fields", () => {
    const futureCurrent = {
      ...codePipelinePluginDescriptor,
      configurationFields: [
        ...codePipelinePluginDescriptor.configurationFields,
        {
          _tag: "text",
          key: "futureField",
          label: "Future field",
          description: "A field added after the historical descriptor was persisted.",
          required: false
        }
      ]
    }

    assert.isTrue(futureCurrent.configurationFields.some(({ key }) => key === "futureField"))
    assert.isFalse(
      historicalReadOnlyCodePipelineDescriptor.configurationFields.some(({ key }) =>
        key === "futureField" || key === "maximumLogBytes"
      )
    )
    assert.deepStrictEqual(
      historicalReadOnlyCodePipelineDescriptor.capabilities.map(({ capabilityId }) => capabilityId),
      ["entity.read", "sync.incremental"]
    )
    assert.deepStrictEqual(
      historicalReadOnlyCodePipelineDescriptor.adapterVersion,
      { major: 0, minor: 1, patch: 0 }
    )
    assert.deepStrictEqual(
      codePipelinePluginDescriptor.adapterVersion,
      { major: 0, minor: 2, patch: 0 }
    )
    assert.notDeepEqual(
      historicalReadOnlyCodePipelineDescriptor.adapterVersion,
      codePipelinePluginDescriptor.adapterVersion
    )
    assert.deepStrictEqual(
      codePipelinePluginDescriptor.capabilities.map(({ capabilityId }) => capabilityId),
      [
        "entity.read",
        "sync.incremental",
        "action.propose",
        "action.execute",
        "action.reconcile",
        "pipeline.logs",
        "pipeline.artifact"
      ]
    )
  })

  it.effect("loads compatible historical descriptors while rejecting pre-scope Jira descriptors", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
      const config = yield* makePersistenceTestConfig("control-center-first-party-atlassian-legacy-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const dependencies = Layer.mergeAll(
        persistence,
        database,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient(requests))
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        const secretStore = yield* SecretStore
        yield* persistenceService.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Delivery"),
          createdAt: CREATED_AT
        })
        const cases: ReadonlyArray<{
          readonly generation:
            | "pre-oauth"
            | "oauth-without-identity"
            | "oauth-with-site-only"
            | "scoped"
            | "scoped-v0.2"
          readonly missing: "none" | "apiToken" | "email"
          readonly providerId: "jira" | "confluence"
        }> = [
          { providerId: "jira", generation: "pre-oauth", missing: "none" },
          { providerId: "jira", generation: "oauth-without-identity", missing: "none" },
          { providerId: "jira", generation: "oauth-with-site-only", missing: "none" },
          { providerId: "jira", generation: "scoped", missing: "none" },
          { providerId: "jira", generation: "scoped-v0.2", missing: "none" },
          { providerId: "confluence", generation: "pre-oauth", missing: "none" },
          { providerId: "jira", generation: "pre-oauth", missing: "email" },
          { providerId: "confluence", generation: "pre-oauth", missing: "apiToken" }
        ]

        for (const [index, testCase] of cases.entries()) {
          const pluginConnectionId = PluginConnectionId.make(
            `01890f6f-6d6a-7cc0-98d2-${(300 + index).toString().padStart(12, "0")}`
          )
          const apiTokenRef = yield* secretStore.create(new TextEncoder().encode("atlassian-token"))
          yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
            pluginConnectionId,
            providerId: testCase.providerId,
            displayName: PluginConnectionDisplayName.make(`Legacy ${testCase.providerId} ${index}`),
            isEnabled: true,
            createdAt: CREATED_AT
          })
          const credentials = [
            ...(testCase.missing === "apiToken"
              ? []
              : [{ _tag: "secret-reference", key: "apiToken", ref: apiTokenRef }]),
            ...(testCase.missing === "email"
              ? []
              : [{ _tag: "text", key: "email", value: "owner@example.com" }])
          ]
          const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(
            testCase.providerId === "jira"
              ? [
                ...credentials,
                ...(testCase.generation === "pre-oauth"
                  ? []
                  : [{ _tag: "text", key: "authMode", value: "api-token" }]),
                ...(
                  testCase.generation === "oauth-with-site-only" ||
                    testCase.generation === "scoped" ||
                    testCase.generation === "scoped-v0.2"
                    ? [{ _tag: "text", key: "siteId", value: "cloud-1" }]
                    : []
                ),
                ...(testCase.generation === "scoped" || testCase.generation === "scoped-v0.2"
                  ? [{ _tag: "text", key: "projectId", value: "project-1" }]
                  : []),
                { _tag: "integer", key: "maximumPages", value: 3 },
                { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
                { _tag: "integer", key: "pageSize", value: 10 },
                { _tag: "url", key: "webBaseUrl", value: "https://knpkv.atlassian.net/" }
              ].sort((left, right) => left.key.localeCompare(right.key))
              : [
                ...credentials,
                { _tag: "text", key: "probePageId", value: "page-1" },
                { _tag: "url", key: "siteBaseUrl", value: "https://knpkv.atlassian.net/" },
                { _tag: "text", key: "siteId", value: "cloud-1" },
                { _tag: "text", key: "spaceId", value: "space-1" }
              ]
          )
          yield* persistenceService.pluginConfigurations.update(
            WORKSPACE_ID,
            pluginConnectionId,
            configuration,
            0,
            CREATED_AT
          )
          yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
            WORKSPACE_ID,
            pluginConnectionId,
            testCase.providerId,
            testCase.providerId === "confluence"
              ? preOAuthDescriptor("confluence")
              : testCase.generation === "pre-oauth"
              ? preOAuthDescriptor("jira")
              : testCase.generation === "oauth-without-identity"
              ? jiraOAuthDescriptorWithoutIdentity
              : testCase.generation === "scoped"
              ? historicalJiraDescriptor
              : testCase.generation === "scoped-v0.2"
              ? historicalJiraV02Descriptor
              : jiraOAuthDescriptorWithSiteOnly,
            0,
            CREATED_AT
          )

          const connections = yield* PluginConnectionMap
          const outcome = yield* Effect.result(
            connections.contextEffect({ workspaceId: WORKSPACE_ID, pluginConnectionId })
          )
          if (
            testCase.providerId === "jira" &&
            testCase.generation !== "scoped" &&
            testCase.generation !== "scoped-v0.2"
          ) {
            assert.strictEqual(outcome._tag, "Failure")
            if (outcome._tag === "Failure" && outcome.failure._tag === "PluginConfigurationFailure") {
              assert.strictEqual(outcome.failure.diagnosticCode, "plugin-configuration-migration-required")
            }
          } else if (testCase.missing === "none") {
            assert.strictEqual(outcome._tag, "Success")
            if (outcome._tag === "Success") {
              const connection = Context.get(outcome.success, PluginConnection)
              if (
                testCase.providerId === "jira" &&
                (testCase.generation === "scoped" || testCase.generation === "scoped-v0.2")
              ) {
                assert.isFalse(hasPluginCapability(connection.descriptor, "action.execute", 1))
              }
            }
          } else {
            assert.strictEqual(outcome._tag, "Failure")
            if (outcome._tag === "Failure") {
              assert.strictEqual(outcome.failure._tag, "PluginConfigurationFailure")
              if (outcome.failure._tag === "PluginConfigurationFailure") {
                assert.strictEqual(outcome.failure.diagnosticCode, "plugin-configuration-authMode-invalid")
              }
            }
          }
        }
        assert.lengthOf(requests, 0)
      }).pipe(
        Effect.provide(firstPartyPluginConnectionMapLayer),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("loads one canonical OAuth credential for both providers and rejects expired tokens", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-runtime-oauth-" })
      const configRoot = path.join(home, ".config")
      const now = DateTime.toEpochMillis(CREATED_AT)
      yield* TestClock.setTime(now)
      const storePath = path.join(configRoot, "atlassian", "control-center")
      yield* fileSystem.makeDirectory(storePath, { recursive: true })
      const longUserName = `Avery ${"B".repeat(195)}`
      const supplementaryUserName = `${"A".repeat(199)}😀`
      const exactBoundaryUserName = `${"A".repeat(199)}B`
      const profiles = [
        oauthProfile("valid-profile", now + 60_000),
        oauthProfile("expired-profile", now - 1),
        oauthProfile("legacy-spaced-name-profile", now + 60_000, " Avery Bell"),
        oauthProfile("long-name-profile", now + 60_000, longUserName),
        oauthProfile("supplementary-name-profile", now + 60_000, supplementaryUserName),
        oauthProfile("exact-boundary-profile", now + 60_000, exactBoundaryUserName)
      ]
      yield* fileSystem.writeFileString(
        path.join(storePath, "profiles.json"),
        JSON.stringify({ activeProfileId: "valid-profile", profiles })
      )

      const config = yield* makePersistenceTestConfig("control-center-first-party-atlassian-oauth-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const dependencies = Layer.mergeAll(
        persistence,
        database,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient(requests))
      )
      const configProvider = ConfigProvider.fromUnknown({ HOME: home, XDG_CONFIG_HOME: configRoot })

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        yield* persistenceService.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Delivery"),
          createdAt: CREATED_AT
        })
        const cases: ReadonlyArray<{
          readonly expectedDiagnosticCode: string | null
          readonly historicalDescriptor?: boolean
          readonly expectedDisplayName?: string
          readonly profileId:
            | "valid-profile"
            | "expired-profile"
            | "legacy-spaced-name-profile"
            | "long-name-profile"
            | "supplementary-name-profile"
            | "exact-boundary-profile"
          readonly providerId: "jira" | "confluence"
          readonly siteId: string
        }> = [
          { expectedDiagnosticCode: null, providerId: "jira", profileId: "valid-profile", siteId: "cloud-1" },
          { expectedDiagnosticCode: null, providerId: "confluence", profileId: "valid-profile", siteId: "cloud-1" },
          {
            expectedDiagnosticCode: null,
            expectedDisplayName: "Avery Bell",
            providerId: "confluence",
            profileId: "legacy-spaced-name-profile",
            siteId: "cloud-1"
          },
          {
            expectedDiagnosticCode: null,
            expectedDisplayName: longUserName.slice(0, 200),
            providerId: "confluence",
            profileId: "long-name-profile",
            siteId: "cloud-1"
          },
          {
            expectedDiagnosticCode: null,
            expectedDisplayName: "A".repeat(199),
            providerId: "confluence",
            profileId: "supplementary-name-profile",
            siteId: "cloud-1"
          },
          {
            expectedDiagnosticCode: null,
            expectedDisplayName: exactBoundaryUserName,
            providerId: "confluence",
            profileId: "exact-boundary-profile",
            siteId: "cloud-1"
          },
          {
            expectedDiagnosticCode: null,
            historicalDescriptor: true,
            providerId: "confluence",
            profileId: "valid-profile",
            siteId: "cloud-1"
          },
          {
            expectedDiagnosticCode: "plugin-oauth-profile-site-mismatch",
            providerId: "jira",
            profileId: "valid-profile",
            siteId: "cloud-other"
          },
          {
            expectedDiagnosticCode: "plugin-oauth-profile-expired",
            providerId: "jira",
            profileId: "expired-profile",
            siteId: "cloud-1"
          },
          {
            expectedDiagnosticCode: "plugin-oauth-profile-expired",
            providerId: "confluence",
            profileId: "expired-profile",
            siteId: "cloud-1"
          }
        ]

        for (const [index, testCase] of cases.entries()) {
          const pluginConnectionId = PluginConnectionId.make(
            `01890f6f-6d6a-7cc0-98d2-${(400 + index).toString().padStart(12, "0")}`
          )
          yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
            pluginConnectionId,
            providerId: testCase.providerId,
            displayName: PluginConnectionDisplayName.make(`OAuth ${testCase.providerId} ${index}`),
            isEnabled: true,
            createdAt: CREATED_AT
          })
          const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(
            testCase.providerId === "jira"
              ? [
                { _tag: "text", key: "authMode", value: "oauth" },
                { _tag: "integer", key: "maximumPages", value: 3 },
                { _tag: "text", key: "oauthProfileId", value: testCase.profileId },
                { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
                { _tag: "integer", key: "pageSize", value: 10 },
                { _tag: "text", key: "projectId", value: "project-1" },
                { _tag: "text", key: "siteId", value: testCase.siteId },
                { _tag: "url", key: "webBaseUrl", value: "https://knpkv.atlassian.net/" }
              ]
              : [
                { _tag: "text", key: "authMode", value: "oauth" },
                { _tag: "text", key: "oauthProfileId", value: testCase.profileId },
                { _tag: "text", key: "probePageId", value: "page-1" },
                { _tag: "url", key: "siteBaseUrl", value: "https://knpkv.atlassian.net/" },
                { _tag: "text", key: "siteId", value: testCase.siteId },
                { _tag: "text", key: "spaceId", value: "space-1" }
              ]
          )
          yield* persistenceService.pluginConfigurations.update(
            WORKSPACE_ID,
            pluginConnectionId,
            configuration,
            0,
            CREATED_AT
          )
          yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
            WORKSPACE_ID,
            pluginConnectionId,
            testCase.providerId,
            testCase.providerId === "jira"
              ? jiraReadPluginDescriptor
              : testCase.historicalDescriptor === true
              ? historicalConfluenceOAuthDescriptor
              : confluencePagePluginDescriptor,
            0,
            CREATED_AT
          )

          const connections = yield* PluginConnectionMap
          const outcome = yield* Effect.result(
            connections.contextEffect({ workspaceId: WORKSPACE_ID, pluginConnectionId })
          )
          if (testCase.expectedDiagnosticCode === null) {
            assert.strictEqual(outcome._tag, "Success")
            if (outcome._tag === "Success") {
              const connection = Context.get(outcome.success, PluginConnection)
              if (testCase.providerId === "confluence") {
                const discovery = yield* connection.discover
                assert.deepStrictEqual(discovery.account, {
                  providerImmutableId: "account-1",
                  displayName: testCase.expectedDisplayName ?? "Avery Bell"
                })
              }
              if (testCase.historicalDescriptor === true) {
                assert.isFalse(hasPluginCapability(connection.descriptor, "sync.incremental", 1))
                const driver = firstPartyManualPluginSyncDrivers.get("confluence")
                assert.isTrue(Option.isSome(driver))
                if (Option.isNone(driver)) return yield* Effect.die("Confluence sync driver not found")
                const request = Schema.decodeUnknownSync(PluginSyncRequestV1)({
                  streamKey: driver.value.streamKey,
                  checkpoint: null
                })
                const historicalSync = yield* driver.value.sync(connection, request).pipe(
                  Stream.runCollect,
                  Effect.result
                )
                assert.strictEqual(historicalSync._tag, "Failure")
                if (historicalSync._tag === "Failure") {
                  assert.strictEqual(historicalSync.failure._tag, "PluginUnsupportedCapabilityFailure")
                }

                const stored = yield* persistenceService.pluginRuntime.getRuntime(
                  WORKSPACE_ID,
                  pluginConnectionId
                )
                yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
                  WORKSPACE_ID,
                  pluginConnectionId,
                  "confluence",
                  confluencePagePluginDescriptor,
                  stored.revision,
                  CREATED_AT
                )
                yield* connections.invalidate({ workspaceId: WORKSPACE_ID, pluginConnectionId })
                const currentContext = yield* connections.contextEffect({
                  workspaceId: WORKSPACE_ID,
                  pluginConnectionId
                })
                const currentConnection = Context.get(currentContext, PluginConnection)
                assert.isTrue(hasPluginCapability(currentConnection.descriptor, "sync.incremental", 1))
                const currentPages = yield* driver.value.sync(currentConnection, request).pipe(Stream.runCollect)
                assert.lengthOf(currentPages, 1)
              }
            }
          } else {
            assert.strictEqual(outcome._tag, "Failure")
            if (outcome._tag === "Failure") {
              assert.strictEqual(outcome.failure._tag, "PluginConfigurationFailure")
              if (outcome.failure._tag === "PluginConfigurationFailure") {
                assert.strictEqual(outcome.failure.diagnosticCode, testCase.expectedDiagnosticCode)
              }
            }
          }
        }
        assert.lengthOf(requests, 1)
      }).pipe(
        Effect.provide(firstPartyPluginConnectionMapLayer),
        Effect.provide(dependencies),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("loads legacy text and current secret-backed Atlassian emails", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
      const config = yield* makePersistenceTestConfig("control-center-first-party-atlassian-email-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const dependencies = Layer.mergeAll(
        persistence,
        database,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient(requests))
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        const secretStore = yield* SecretStore
        yield* persistenceService.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Delivery"),
          createdAt: CREATED_AT
        })
        const cases: ReadonlyArray<{
          readonly providerId: "jira" | "confluence"
          readonly email: "legacy-text" | "secret-reference" | "malformed-secret-reference"
        }> = [
          { providerId: "jira", email: "legacy-text" },
          { providerId: "confluence", email: "legacy-text" },
          { providerId: "jira", email: "secret-reference" },
          { providerId: "confluence", email: "secret-reference" },
          { providerId: "jira", email: "malformed-secret-reference" },
          { providerId: "confluence", email: "malformed-secret-reference" }
        ]

        for (const [index, testCase] of cases.entries()) {
          const apiTokenRef = yield* secretStore.create(new TextEncoder().encode("atlassian-token"))
          const emailRef = yield* secretStore.create(
            new TextEncoder().encode(
              testCase.email === "malformed-secret-reference" ? "malformed-email" : "owner@example.com"
            )
          )
          const pluginConnectionId = PluginConnectionId.make(
            `01890f6f-6d6a-7cc0-98d2-${(200 + index).toString().padStart(12, "0")}`
          )
          yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
            pluginConnectionId,
            providerId: testCase.providerId,
            displayName: PluginConnectionDisplayName.make(`Atlassian ${index}`),
            isEnabled: true,
            createdAt: CREATED_AT
          })
          const email = testCase.email === "legacy-text"
            ? { _tag: "text", key: "email", value: "owner@example.com" }
            : {
              _tag: "secret-reference",
              key: "email",
              ref: emailRef
            }
          const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(
            testCase.providerId === "jira"
              ? [
                { _tag: "secret-reference", key: "apiToken", ref: apiTokenRef },
                { _tag: "text", key: "authMode", value: "api-token" },
                email,
                { _tag: "integer", key: "maximumPages", value: 3 },
                { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
                { _tag: "integer", key: "pageSize", value: 10 },
                { _tag: "text", key: "projectId", value: "project-1" },
                { _tag: "text", key: "siteId", value: "site-1" },
                { _tag: "url", key: "webBaseUrl", value: "https://knpkv.atlassian.net/" }
              ]
              : [
                { _tag: "secret-reference", key: "apiToken", ref: apiTokenRef },
                { _tag: "text", key: "authMode", value: "api-token" },
                email,
                { _tag: "text", key: "probePageId", value: "page-1" },
                { _tag: "url", key: "siteBaseUrl", value: "https://knpkv.atlassian.net/" },
                { _tag: "text", key: "siteId", value: "site-1" },
                { _tag: "text", key: "spaceId", value: "space-1" }
              ]
          )
          yield* persistenceService.pluginConfigurations.update(
            WORKSPACE_ID,
            pluginConnectionId,
            configuration,
            0,
            CREATED_AT
          )
          yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
            WORKSPACE_ID,
            pluginConnectionId,
            testCase.providerId,
            testCase.providerId === "jira" ? jiraReadPluginDescriptor : confluencePagePluginDescriptor,
            0,
            CREATED_AT
          )

          const connections = yield* PluginConnectionMap
          const outcome = yield* Effect.result(
            connections.contextEffect({ workspaceId: WORKSPACE_ID, pluginConnectionId })
          )
          if (testCase.email === "malformed-secret-reference") {
            assert.strictEqual(outcome._tag, "Failure")
            if (outcome._tag === "Failure") {
              assert.strictEqual(outcome.failure._tag, "PluginConfigurationFailure")
              if (outcome.failure._tag === "PluginConfigurationFailure") {
                assert.strictEqual(outcome.failure.diagnosticCode, "plugin-configuration-schema-invalid")
              }
            }
          } else {
            assert.strictEqual(outcome._tag, "Success")
            if (outcome._tag === "Success") Context.get(outcome.success, PluginConnection)
          }
        }
        assert.lengthOf(requests, 0)
      }).pipe(
        Effect.provide(firstPartyPluginConnectionMapLayer),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects non-tenant Atlassian origins before credentials or HTTP are used", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
      const config = yield* makePersistenceTestConfig("control-center-first-party-atlassian-origin-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const dependencies = Layer.mergeAll(
        persistence,
        database,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient(requests))
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        yield* persistenceService.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Delivery"),
          createdAt: CREATED_AT
        })
        const cases: ReadonlyArray<{
          readonly providerId: "jira" | "confluence"
          readonly webBaseUrl: string
        }> = [
          { providerId: "jira", webBaseUrl: "http://acme.atlassian.net" },
          { providerId: "jira", webBaseUrl: "https://localhost" },
          { providerId: "jira", webBaseUrl: "https://collector.example" },
          { providerId: "confluence", webBaseUrl: "http://acme.atlassian.net" },
          { providerId: "confluence", webBaseUrl: "https://localhost" },
          { providerId: "confluence", webBaseUrl: "https://collector.example" }
        ]

        for (const [index, invalid] of cases.entries()) {
          const missingSecretRef = SecretRef.make(`secret_${index.toString(16).repeat(64)}`)
          const missingEmailRef = SecretRef.make(`secret_${(index + 8).toString(16).repeat(64)}`)
          const pluginConnectionId = PluginConnectionId.make(
            `01890f6f-6d6a-7cc0-98d2-${(100 + index).toString().padStart(12, "0")}`
          )
          yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
            pluginConnectionId,
            providerId: invalid.providerId,
            displayName: PluginConnectionDisplayName.make(`Invalid ${invalid.providerId} ${index}`),
            isEnabled: true,
            createdAt: CREATED_AT
          })
          const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(
            invalid.providerId === "jira"
              ? [
                { _tag: "secret-reference", key: "apiToken", ref: missingSecretRef },
                { _tag: "text", key: "authMode", value: "api-token" },
                { _tag: "secret-reference", key: "email", ref: missingEmailRef },
                { _tag: "integer", key: "maximumPages", value: 3 },
                { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
                { _tag: "integer", key: "pageSize", value: 10 },
                { _tag: "text", key: "projectId", value: "project-1" },
                { _tag: "text", key: "siteId", value: "site-1" },
                { _tag: "url", key: "webBaseUrl", value: invalid.webBaseUrl }
              ]
              : [
                { _tag: "secret-reference", key: "apiToken", ref: missingSecretRef },
                { _tag: "text", key: "authMode", value: "api-token" },
                { _tag: "secret-reference", key: "email", ref: missingEmailRef },
                { _tag: "text", key: "probePageId", value: "page-1" },
                { _tag: "url", key: "siteBaseUrl", value: invalid.webBaseUrl },
                { _tag: "text", key: "siteId", value: "site-1" },
                { _tag: "text", key: "spaceId", value: "space-1" }
              ]
          )
          yield* persistenceService.pluginConfigurations.update(
            WORKSPACE_ID,
            pluginConnectionId,
            configuration,
            0,
            CREATED_AT
          )
          yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
            WORKSPACE_ID,
            pluginConnectionId,
            invalid.providerId,
            invalid.providerId === "jira" ? jiraReadPluginDescriptor : confluencePagePluginDescriptor,
            0,
            CREATED_AT
          )

          const connections = yield* PluginConnectionMap
          const outcome = yield* Effect.result(connections.contextEffect({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId
          }))
          assert.strictEqual(outcome._tag, "Failure")
          if (outcome._tag === "Failure") {
            assert.strictEqual(outcome.failure._tag, "PluginConfigurationFailure")
            if (outcome.failure._tag === "PluginConfigurationFailure") {
              assert.strictEqual(outcome.failure.diagnosticCode, "plugin-configuration-schema-invalid")
            }
          }
        }
        assert.lengthOf(requests, 0)
      }).pipe(
        Effect.provide(firstPartyPluginConnectionMapLayer),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("shares first-party proposal, diff, and executor invalidation through administration", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
      const config = yield* makePersistenceTestConfig("control-center-first-party-shared-diff-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
      const runtimeAuthority = pluginRuntimeAuthoritySourceLayer
      const discoveredProfiles = yield* Ref.make<Array<string>>([])
      const changedFileProfiles = yield* Ref.make<Array<string>>([])
      const providerMutations = yield* Ref.make(0)
      const pauseProposalRead = yield* Ref.make(false)
      const proposalReadStarted = yield* Deferred.make<void>()
      const resumeProposalRead = yield* Deferred.make<void>()
      const pullRequest = Schema.decodeUnknownSync(ReadClient.CodeCommitPullRequestRevision)({
        pullRequestId: "17",
        revisionId: "revision-17",
        repositoryName: "payments-api",
        title: "Shared diff runtime",
        description: "Reuse one runtime until administration invalidates it.",
        authorArn: "arn:aws:iam::123456789012:user/alice",
        status: "OPEN",
        sourceReference: "refs/heads/feature/shared-runtime",
        destinationReference: "refs/heads/main",
        sourceCommit: "live-head",
        destinationCommit: "live-base",
        mergeBase: "live-base",
        creationDate: new Date("2026-07-18T08:00:00.000Z"),
        lastActivityDate: new Date("2026-07-18T09:00:00.000Z")
      })
      const files = [
        Schema.decodeUnknownSync(ReadClient.CodeCommitChangedFile)({
          status: "modified",
          before: { blobId: "blob-before", path: "src/runtime.ts", mode: "100644" },
          after: { blobId: "blob-after", path: "src/runtime.ts", mode: "100644" }
        })
      ]
      const readClient = Layer.succeed(ReadClient.CodeCommitReadClient, {
        discoverAccount: ({ profile }) =>
          Ref.update(discoveredProfiles, (profiles) => [...profiles, profile]).pipe(
            Effect.as(
              new ReadClient.CodeCommitAccountIdentity({
                accountId: "123456789012",
                arn: `arn:aws:iam::123456789012:role/${profile}`
              })
            )
          ),
        listRepositoriesPage: () =>
          Effect.succeed(
            new ReadClient.CodeCommitRepositoryPage({
              repositoryNames: [pullRequest.repositoryName],
              nextToken: null
            })
          ),
        getBlob: () => Effect.die("unused getBlob"),
        listPullRequestsPage: () =>
          Effect.succeed(
            new ReadClient.CodeCommitPullRequestPage({
              pullRequests: [pullRequest],
              nextToken: null
            })
          ),
        streamPullRequests: () => Stream.make(pullRequest),
        getPullRequest: () =>
          Ref.get(pauseProposalRead).pipe(
            Effect.flatMap((pause) =>
              pause
                ? Deferred.succeed(proposalReadStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(resumeProposalRead)),
                  Effect.as(pullRequest)
                )
                : Effect.succeed(pullRequest)
            )
          ),
        getChangedFilesPage: ({ account }) =>
          Ref.update(changedFileProfiles, (profiles) => [...profiles, account.profile]).pipe(
            Effect.as(
              new ReadClient.CodeCommitChangedFilesPage({
                files,
                nextToken: null,
                providerPageLimit: 100
              })
            )
          ),
        streamChangedFiles: () => Stream.fromIterable(files)
      })
      const reviewClient = Layer.succeed(ReviewClient.CodeCommitReviewClient, {
        preflight: () => Effect.succeed(pullRequest),
        execute: () =>
          Ref.update(providerMutations, (count) => count + 1).pipe(
            Effect.as(
              new ReviewClient.CodeCommitReviewReceipt({
                operationId: "comment:shared-runtime",
                summary: "Posted a pull-request comment"
              })
            )
          ),
        reconcile: () => Effect.die("unused reconcile")
      })
      const clients = Layer.merge(readClient, reviewClient)
      const registry = makeFirstPartyPluginRuntimeRegistry(clients)
      const governedActions = GovernedActionRepository.layer.pipe(Layer.provide(foundation))
      const deliveryGraph = DeliveryGraphRepository.layer.pipe(Layer.provide(foundation))
      const dependencies = Layer.mergeAll(
        persistence,
        foundation,
        governedActions,
        deliveryGraph,
        runtimeAuthority,
        DomainEventWakeups.layer,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient([]))
      ).pipe(Layer.provideMerge(database))

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        yield* persistenceService.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Delivery"),
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: CONNECTION_ID,
          providerId: "codecommit",
          displayName: PluginConnectionDisplayName.make("Payments CodeCommit"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "text", key: "profile", value: "production" },
          { _tag: "text", key: "region", value: "eu-west-1" },
          { _tag: "text", key: "repositoryName", value: "payments-api" }
        ])
        yield* persistenceService.pluginConfigurations.update(
          WORKSPACE_ID,
          CONNECTION_ID,
          configuration,
          0,
          CREATED_AT
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          CONNECTION_ID,
          "codecommit",
          codeCommitPluginDefinition.rawDescriptor,
          0,
          CREATED_AT
        )
        const registryService = yield* PluginRuntimeRegistry
        const composition = makeControlCenterApplicationComposition({
          bindConfig: yield* decodeBindConfig({ port: 4173 }),
          persistenceConfig: Schema.decodeUnknownSync(PersistenceConfig)(config),
          secretRoot: SecretRoot.make(`${root}/secrets`),
          staticAssets: { root },
          firstPartyPluginRuntime: true,
          firstPartyPluginRuntimes: registryService,
          governedActionExecution: { workspaceId: GOVERNED_WORKSPACE }
        })
        if (
          composition.firstPartyRuntime === null ||
          composition.firstPartyGovernedActionStartup === null ||
          composition.firstPartyGovernedActionExecutors === null
        ) {
          return yield* Effect.die("first-party governed runtime composition is unavailable")
        }
        const composed = yield* Layer.build(
          Layer.mergeAll(
            composition.applicationServices,
            composition.firstPartyRuntime.connections,
            composition.firstPartyGovernedActionStartup,
            composition.firstPartyGovernedActionExecutors,
            composition.reviewSuggestionPublications
          ).pipe(Layer.provide(composition.lifecycle))
        )
        const entityId = EntityId.make("01890f6f-6d6a-7cc0-98d2-000000000087")
        const observedAt = DateTime.formatIso(CREATED_AT)
        const sourceRevision = Schema.decodeSync(SourceRevision)({
          providerId: "codecommit",
          pluginConnectionId: CONNECTION_ID,
          vendorImmutableId: "17",
          revision: "revision-17",
          sourceUrl: null,
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          synchronizedAt: observedAt,
          normalizationSchemaVersion: 2
        })
        yield* persistenceService.entities.create(WORKSPACE_ID, {
          entityId,
          entityType: "pull-request",
          sourceRevision,
          createdAt: CREATED_AT
        })
        yield* persistenceService.deliveryGraph.write(WORKSPACE_ID, {
          entityProjections: [{
            projection: {
              workspaceId: WORKSPACE_ID,
              entityId,
              projectionRevision: 1,
              sourceEntityRevision: 1,
              supersedesProjectionRevision: null,
              projectionSchemaVersion: 2,
              entityState: "present",
              entityType: "pull-request",
              displayKey: "17",
              title: "Shared diff runtime",
              details: {
                _tag: "pull-request",
                repository: "payments-api",
                sourceBranch: "feature/shared-runtime",
                targetBranch: "main",
                headRevision: "head-commit-17",
                baseRevision: "base-commit-17",
                reviewState: "requested",
                lifecycle: "open"
              }
            },
            recordedAt: observedAt
          }],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: []
        })

        const reads = Context.get(composed, CompleteDiffReads)
        const administration = Context.get(composed, PluginAdministration)
        const request = {
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: CONNECTION_ID,
          vendorImmutableId: VendorImmutableId.make("17"),
          revision: Revision.make("revision-17")
        }
        const first = yield* reads.inventory(request)
        const second = yield* reads.inventory(request)
        assert.deepStrictEqual(second, first)
        assert.deepStrictEqual(yield* Ref.get(discoveredProfiles), ["production"])
        assert.deepStrictEqual(yield* Ref.get(changedFileProfiles), ["production", "production"])

        const patch = Schema.decodeUnknownSync(PatchPluginConfigurationRequest)({
          expectedRevision: 1,
          values: [
            { _tag: "text", key: "profile", value: "rotated" },
            { _tag: "text", key: "region", value: "eu-west-1" },
            { _tag: "text", key: "repositoryName", value: "payments-api" }
          ]
        })
        const updated = yield* administration.patchConfiguration({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: CONNECTION_ID,
          patch
        })
        assert.strictEqual(updated.revision, 2)

        const third = yield* reads.inventory(request)
        assert.deepStrictEqual(third, first)
        assert.deepStrictEqual({
          discoveredProfiles: yield* Ref.get(discoveredProfiles),
          changedFileProfiles: yield* Ref.get(changedFileProfiles)
        }, {
          discoveredProfiles: ["production", "rotated"],
          changedFileProfiles: ["production", "production", "rotated"]
        })

        const publicationGateway = Context.get(composed, ReviewSuggestionPublicationGateway)
        const publicationTarget = {
          workspaceId: WORKSPACE_ID,
          entityId,
          pluginConnectionId: CONNECTION_ID,
          sourceRevision: "revision-17",
          subject: {
            providerId: "codecommit",
            repository: "payments-api",
            pullRequestId: "17",
            baseRevision: "live-base",
            headRevision: "live-head"
          }
        } satisfies ReviewSuggestionPublicationTarget
        const publicationIdentity = yield* publicationGateway.identity(publicationTarget)
        const suggestion = Schema.decodeSync(PrReviewSuggestion)({
          suggestionId: PrReviewSuggestionId.make(`sha256:${"4".repeat(64)}`),
          state: "draft",
          title: "Revalidate runtime authority before publication",
          severity: "P2",
          problem: "The shared runtime can rotate before publication commits.",
          impact: "A stale action would become permanently unexecutable.",
          evidence: {
            path: "src/runtime.ts",
            startLine: 1,
            endLine: 1,
            excerpt: "export const runtime = shared"
          },
          recommendation: "Revalidate authority in the same transaction as the durable commit.",
          anchor: {
            _tag: "line",
            path: "src/runtime.ts",
            line: 1,
            relativeFileVersion: "AFTER"
          },
          relatedLocations: [],
          confidence: {
            level: "high",
            reason: "The deterministic barrier crosses the administration invalidation boundary."
          }
        })
        const proposingAgent = Schema.decodeSync(ReviewAgentProfile)({
          profileId: ReviewAgentProfileId.make("codex:test-sbx"),
          label: "Codex test review",
          budgetMillis: 60_000,
          networkAccess: "blocked",
          sandbox: "sbx"
        })
        yield* Ref.set(pauseProposalRead, true)
        const publication = yield* Effect.forkScoped(
          publicationGateway.publish({
            target: publicationTarget,
            jobId: JobId.make("01890f6f-6d6a-7cc0-98d2-000000000088"),
            revisionId: PrReviewSuggestionRevisionId.make(
              `sha256:${"4".repeat(64)}`
            ),
            suggestion,
            finalContent: ReviewSuggestionPublicationContent.make(
              "Revalidate authority before committing this review comment."
            ),
            authorityBinding: publicationIdentity.authorityBinding,
            proposingAgent,
            session: {
              sessionId: SessionId.make("01890f6f-6d6a-7cc0-98d2-000000000089"),
              workspaceId: WORKSPACE_ID,
              actor: {
                _tag: "human",
                personId: PersonId.make("01890f6f-6d6a-7cc0-98d2-00000000008a")
              },
              permission: "workspace-owner",
              createdAt: Schema.decodeSync(UtcTimestamp)("2026-07-18T09:00:00.000Z"),
              lastSeenAt: Schema.decodeSync(UtcTimestamp)("2026-07-18T10:00:00.000Z"),
              idleExpiresAt: Schema.decodeSync(UtcTimestamp)("2026-07-18T11:00:00.000Z"),
              absoluteExpiresAt: Schema.decodeSync(UtcTimestamp)("2026-08-18T10:00:00.000Z"),
              revokedAt: null
            }
          }).pipe(Effect.result)
        )
        yield* Deferred.await(proposalReadStarted)
        const racePatch = Schema.decodeUnknownSync(PatchPluginConfigurationRequest)({
          expectedRevision: 2,
          values: [
            { _tag: "text", key: "profile", value: "race-rotated" },
            { _tag: "text", key: "region", value: "eu-west-1" },
            { _tag: "text", key: "repositoryName", value: "payments-api" }
          ]
        })
        const raceUpdated = yield* administration.patchConfiguration({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: CONNECTION_ID,
          patch: racePatch
        })
        assert.strictEqual(raceUpdated.revision, 3)
        yield* Ref.set(pauseProposalRead, false)
        yield* Deferred.succeed(resumeProposalRead, undefined)
        const publicationResult = yield* Fiber.join(publication)
        assert.isTrue(publicationResult._tag === "Failure")
        const { sql } = yield* Database
        const staleActions = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM governed_actions WHERE workspace_id = ${WORKSPACE_ID}`
        assert.strictEqual(staleActions[0]?.count, 0)
        assert.strictEqual(yield* Ref.get(providerMutations), 0)

        yield* TestClock.setTime(DateTime.toEpochMillis(
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")
        ))
        yield* seedGovernedActionAuthorityRoots("codecommit")
        const governedConfiguration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "text", key: "profile", value: "production" },
          { _tag: "text", key: "region", value: "eu-west-1" },
          { _tag: "text", key: "repositoryName", value: "payments-api" }
        ])
        yield* persistenceService.pluginConfigurations.update(
          GOVERNED_WORKSPACE,
          GOVERNED_CONNECTION,
          governedConfiguration,
          0,
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          GOVERNED_WORKSPACE,
          GOVERNED_CONNECTION,
          "codecommit",
          codeCommitPluginDefinition.rawDescriptor,
          0,
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
        )

        const connectionMap = Context.get(composed, PluginConnectionMap)
        const executorMap = Context.get(composed, AuthorizedPluginExecutorMap)
        const governedExecution = Context.get(composed, GovernedActionExecutionStartup)
        const governedScope = {
          workspaceId: GOVERNED_WORKSPACE,
          pluginConnectionId: GOVERNED_CONNECTION
        }
        if (connectionMap.proposalContextEffect === undefined) {
          return yield* Effect.die("production proposal projection is unavailable")
        }
        const authorityA = Schema.decodeSync(PluginRuntimeAuthorityToken)(
          (yield* connectionMap.proposalContextEffect(governedScope)).runtimeAuthorityToken
        )
        yield* executorMap.contextEffectForAuthority(governedScope, authorityA)
        assert.strictEqual(yield* Ref.get(providerMutations), 0)

        const governedPatch = Schema.decodeUnknownSync(PatchPluginConfigurationRequest)({
          expectedRevision: 1,
          values: [
            { _tag: "text", key: "profile", value: "rotated" },
            { _tag: "text", key: "region", value: "eu-west-1" },
            { _tag: "text", key: "repositoryName", value: "payments-api" }
          ]
        })
        const governedUpdated = yield* administration.patchConfiguration({
          workspaceId: GOVERNED_WORKSPACE,
          pluginConnectionId: GOVERNED_CONNECTION,
          patch: governedPatch
        })
        assert.strictEqual(governedUpdated.revision, 2)
        const authorityB = Schema.decodeSync(PluginRuntimeAuthorityToken)(
          (yield* connectionMap.proposalContextEffect(governedScope)).runtimeAuthorityToken
        )
        assert.notStrictEqual(authorityB, authorityA)

        yield* seedGovernedAction({
          pluginConnectionAuthorityDigest: authorityB,
          seedAuthorityRoots: false,
          variant: "codecommit"
        })
        yield* seedGovernedActionCurrentInputs("codecommit")
        assert.strictEqual(governedExecution._tag, "ready")
        if (governedExecution._tag !== "ready") {
          return yield* Effect.die("governed execution composition is unavailable")
        }
        const execution = yield* governedExecution.advance({
          workspaceId: GOVERNED_WORKSPACE,
          actionId: GOVERNED_ACTION
        })
        const governedActionRepository = yield* GovernedActionRepository
        const governedRecord = yield* governedActionRepository.read({
          workspaceId: GOVERNED_WORKSPACE,
          actionId: GOVERNED_ACTION
        })

        assert.deepStrictEqual(execution, { _tag: "advanced", state: "succeeded" })
        assert.strictEqual(governedRecord.head.state, "succeeded")
        assert.strictEqual(yield* Ref.get(providerMutations), 1)
      }).pipe(
        Effect.provide(registry),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("persists successful, rejected, and stale Clockify corrections through the production registry", () =>
    Effect.gen(function*() {
      const executionTime = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(executionTime))
      const scenarios: ReadonlyArray<
        "succeeded" | "provider-rejected" | "stale-denied" | "manual-recovery"
      > = ["succeeded", "provider-rejected", "stale-denied", "manual-recovery"]
      yield* Effect.forEach(
        scenarios,
        (scenario) =>
          Effect.gen(function*() {
            yield* TestClock.setTime(DateTime.toEpochMillis(executionTime))
            const entryReads = yield* Ref.make(0)
            const mutations = yield* Ref.make(0)
            const originalTimeEntry = {
              id: "clockify-entry-42",
              workspaceId: "clockify-workspace",
              userId: "user-1",
              description: "Review payment safeguards",
              billable: true,
              projectId: null,
              taskId: null,
              tagIds: [],
              isLocked: false,
              type: "REGULAR",
              timeInterval: {
                start: "2026-07-15T08:00:00.000Z",
                end: "2026-07-15T09:00:00.000Z",
                duration: "PT1H"
              }
            }
            const correctedTimeEntry = {
              ...originalTimeEntry,
              description: "[OPS-42] Review payment safeguards"
            }
            const providerState = yield* Ref.make(
              scenario === "stale-denied"
                ? { ...originalTimeEntry, description: "[OTHER-1] Review payment safeguards" }
                : originalTimeEntry
            )
            const httpClient = HttpClient.make((request) =>
              Effect.gen(function*() {
                const entryUrl = request.url.endsWith(
                  "/v1/workspaces/clockify-workspace/time-entries/clockify-entry-42"
                )
                if (entryUrl && request.method === "GET") {
                  yield* Ref.update(entryReads, (count) => count + 1)
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      JSON.stringify(yield* Ref.get(providerState)),
                      {
                        status: 200,
                        headers: { "content-type": "application/json" }
                      }
                    )
                  )
                }
                if (entryUrl && request.method === "PUT") {
                  yield* Ref.update(mutations, (count) => count + 1)
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      JSON.stringify(
                        scenario === "succeeded"
                          ? correctedTimeEntry
                          : { message: "provider rejected correction" }
                      ),
                      {
                        status: scenario === "succeeded" ? 200 : 409,
                        headers: { "content-type": "application/json" }
                      }
                    )
                  )
                }
                const body = request.url.endsWith("/v1/user")
                  ? { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", status: "ACTIVE" }
                  : [{ id: "clockify-workspace", name: "Delivery" }]
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify(body), {
                    status: 200,
                    headers: { "content-type": "application/json" }
                  })
                )
              })
            )
            const config = yield* makePersistenceTestConfig(
              `control-center-clockify-correction-${scenario}-`
            )
            const root = config.blobRoot.slice(0, -"/blobs".length)
            const database = databaseLayer(config)
            const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
            const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
            const governedActions = GovernedActionRepository.layer.pipe(Layer.provide(foundation))
            const deliveryGraph = DeliveryGraphRepository.layer.pipe(Layer.provide(foundation))
            const runtimeAuthority = pluginRuntimeAuthoritySourceLayer.pipe(Layer.provide(foundation))
            const dependencies = Layer.mergeAll(
              persistence,
              database,
              foundation,
              governedActions,
              deliveryGraph,
              runtimeAuthority,
              SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
              Layer.succeed(HttpClient.HttpClient, httpClient)
            )

            yield* Effect.gen(function*() {
              const persistenceService = yield* Persistence
              const secretStore = yield* SecretStore
              yield* seedGovernedActionAuthorityRoots("clockify-correction")
              const apiKeyRef = yield* secretStore.create(new TextEncoder().encode("clockify-secret"))
              const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
                { _tag: "secret-reference", key: "apiKey", ref: apiKeyRef },
                { _tag: "integer", key: "maximumConcurrency", value: 2 },
                { _tag: "integer", key: "maximumPages", value: 3 },
                { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
                { _tag: "integer", key: "pageSize", value: 10 },
                { _tag: "text", key: "userIds", value: "user-1" },
                { _tag: "url", key: "webBaseUrl", value: "https://app.clockify.me" },
                { _tag: "text", key: "workspaceId", value: "clockify-workspace" }
              ])
              yield* persistenceService.pluginConfigurations.update(
                GOVERNED_WORKSPACE,
                GOVERNED_CONNECTION,
                configuration,
                0,
                Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
              )
              yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
                GOVERNED_WORKSPACE,
                GOVERNED_CONNECTION,
                "clockify",
                clockifyReadPluginDescriptor,
                0,
                Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
              )

              const registry = yield* PluginRuntimeRegistry
              const authority = yield* Effect.gen(function*() {
                return yield* PluginRuntimeAuthority
              }).pipe(
                Effect.provide(registry.layer(pluginRuntimeKey({
                  workspaceId: GOVERNED_WORKSPACE,
                  pluginConnectionId: GOVERNED_CONNECTION
                }))),
                Effect.scoped
              )
              yield* seedGovernedAction({
                pluginConnectionAuthorityDigest: authority,
                seedAuthorityRoots: false,
                variant: "clockify-correction"
              })
              yield* seedGovernedActionCurrentInputs("clockify-correction")

              const registryLayer = Layer.succeed(PluginRuntimeRegistry, registry)
              const runtimeMap = PluginRuntimeMap.layer.pipe(Layer.provide(registryLayer))
              const executors = AuthorizedPluginExecutorMap.layer.pipe(Layer.provide(runtimeMap))
              const store = governedActionExecutionStoreLayer(GOVERNED_WORKSPACE).pipe(
                Layer.provideMerge(pluginRuntimeAuthoritySourceLayer),
                Layer.provideMerge(GovernedActionPolicyEvaluator.layer),
                Layer.provideMerge(QuarantineRepository.layer)
              )
              const engineLayer = GovernedActionExecutionEngine.layer.pipe(
                Layer.provide(store),
                Layer.provide(executors)
              )
              const execution = scenario === "manual-recovery"
                ? yield* Effect.gen(function*() {
                  const executionStore = yield* GovernedActionExecutionStore
                  const preparation = yield* executionStore.inspect({
                    workspaceId: GOVERNED_WORKSPACE,
                    actionId: GOVERNED_ACTION
                  })
                  if (preparation._tag !== "dispatch") {
                    return yield* Effect.die("expected Clockify dispatch preparation")
                  }
                  const preflight = Schema.decodeSync(PluginActionPreflightV1)({
                    _tag: "ready",
                    checkedRevision: "fde93bd687136fe87203da46c3a6ac4ecb9a0271cacbf1b472c128a0879a450b",
                    checkedAt: "2026-07-15T10:02:00.000Z"
                  })
                  if (preflight._tag !== "ready") {
                    return yield* Effect.die("expected ready Clockify preflight")
                  }
                  const begun = yield* executionStore.begin({
                    preparationToken: preparation.preparationToken,
                    preflight,
                    runtimeAuthorityToken: authority,
                    scope: preparation.scope
                  })
                  if (begun._tag !== "permitted") {
                    return yield* Effect.die("expected Clockify dispatch permit")
                  }
                  yield* TestClock.setTime(DateTime.toEpochMillis(begun.dispatchDeadline))
                  yield* executionStore.recordUnknown({
                    permitToken: begun.permitToken,
                    outcome: Schema.decodeSync(GovernedActionUnknownOutcome)({
                      _tag: "manual",
                      observedAt: DateTime.formatIso(begun.dispatchDeadline),
                      safeSummary: "Clockify dispatch crossed the provider intent boundary",
                      reason: "interrupted-after-intent"
                    })
                  })
                  yield* Ref.set(providerState, correctedTimeEntry)
                  yield* TestClock.setTime(DateTime.toEpochMillis(begun.leaseExpiresAt) + 61_000)
                  const engine = yield* GovernedActionExecutionEngine
                  return yield* engine.run({
                    workspaceId: GOVERNED_WORKSPACE,
                    actionId: GOVERNED_ACTION
                  })
                }).pipe(
                  Effect.provide(engineLayer),
                  Effect.provide(store)
                )
                : yield* Effect.gen(function*() {
                  const engine = yield* GovernedActionExecutionEngine
                  return yield* engine.run({
                    workspaceId: GOVERNED_WORKSPACE,
                    actionId: GOVERNED_ACTION
                  })
                }).pipe(Effect.provide(engineLayer))
              const repository = yield* GovernedActionRepository
              const record = yield* repository.read({
                workspaceId: GOVERNED_WORKSPACE,
                actionId: GOVERNED_ACTION
              })
              const expectedState = scenario === "succeeded" || scenario === "manual-recovery"
                ? "succeeded"
                : scenario === "provider-rejected"
                ? "failed"
                : "denied"

              assert.deepStrictEqual(execution, { _tag: "advanced", state: expectedState })
              assert.strictEqual(record.head.state, expectedState)
              assert.strictEqual(
                record.head.lineage._tag,
                scenario === "stale-denied" ? "none" : "terminal"
              )
              assert.strictEqual(
                yield* Ref.get(entryReads),
                scenario === "stale-denied" || scenario === "manual-recovery" ? 1 : 2
              )
              assert.strictEqual(
                yield* Ref.get(mutations),
                scenario === "stale-denied" || scenario === "manual-recovery" ? 0 : 1
              )
            }).pipe(
              Effect.provide(makeFirstPartyPluginRuntimeRegistry(unusedCodeCommitClients)),
              Effect.provide(dependencies)
            )
          }),
        { discard: true }
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("executes authorized Clockify approval through the production registry without provider mutation", () =>
    Effect.gen(function*() {
      const executionTime = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")
      const authorizationTime = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:01:00.000Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(executionTime))
      const entryReads = yield* Ref.make(0)
      const mutations = yield* Ref.make(0)
      const timeEntry = {
        id: "clockify-entry-42",
        workspaceId: "clockify-workspace",
        userId: "user-1",
        description: "Review payment safeguards",
        billable: true,
        projectId: null,
        taskId: null,
        tagIds: [],
        isLocked: false,
        type: "REGULAR",
        timeInterval: {
          start: "2026-07-15T08:00:00.000Z",
          end: "2026-07-15T09:00:00.000Z",
          duration: "PT1H"
        }
      }
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function*() {
          if (request.method !== "GET") yield* Ref.update(mutations, (count) => count + 1)
          const body = request.url.endsWith(
              "/v1/workspaces/clockify-workspace/time-entries/clockify-entry-42"
            )
            ? yield* Ref.updateAndGet(entryReads, (count) => count + 1).pipe(
              Effect.as(timeEntry)
            )
            : request.url.endsWith("/v1/user")
            ? { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", status: "ACTIVE" }
            : [{ id: "clockify-workspace", name: "Delivery" }]
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
          )
        })
      )
      const config = yield* makePersistenceTestConfig("control-center-clockify-governed-runtime-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
      const governedActions = GovernedActionRepository.layer.pipe(Layer.provide(foundation))
      const deliveryGraph = DeliveryGraphRepository.layer.pipe(Layer.provide(foundation))
      const runtimeAuthority = pluginRuntimeAuthoritySourceLayer.pipe(Layer.provide(foundation))
      const dependencies = Layer.mergeAll(
        persistence,
        database,
        foundation,
        governedActions,
        deliveryGraph,
        runtimeAuthority,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, httpClient)
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        const secretStore = yield* SecretStore
        yield* seedGovernedActionAuthorityRoots("clockify-approval")
        const apiKeyRef = yield* secretStore.create(new TextEncoder().encode("clockify-secret"))
        const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "secret-reference", key: "apiKey", ref: apiKeyRef },
          { _tag: "integer", key: "maximumConcurrency", value: 2 },
          { _tag: "integer", key: "maximumPages", value: 3 },
          { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
          { _tag: "integer", key: "pageSize", value: 10 },
          { _tag: "text", key: "userIds", value: "user-1" },
          { _tag: "url", key: "webBaseUrl", value: "https://app.clockify.me" },
          { _tag: "text", key: "workspaceId", value: "clockify-workspace" }
        ])
        yield* persistenceService.pluginConfigurations.update(
          GOVERNED_WORKSPACE,
          GOVERNED_CONNECTION,
          configuration,
          0,
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          GOVERNED_WORKSPACE,
          GOVERNED_CONNECTION,
          "clockify",
          clockifyReadPluginDescriptor,
          0,
          Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
        )

        const registry = yield* PluginRuntimeRegistry
        const authority = yield* Effect.gen(function*() {
          return yield* PluginRuntimeAuthority
        }).pipe(
          Effect.provide(registry.layer(pluginRuntimeKey({
            workspaceId: GOVERNED_WORKSPACE,
            pluginConnectionId: GOVERNED_CONNECTION
          }))),
          Effect.scoped
        )
        yield* seedGovernedAction({
          pluginConnectionAuthorityDigest: authority,
          seedAuthorityRoots: false,
          variant: "clockify-approval"
        })
        yield* seedGovernedActionCurrentInputs("clockify-approval")

        const registryLayer = Layer.succeed(PluginRuntimeRegistry, registry)
        const runtimeMap = PluginRuntimeMap.layer.pipe(Layer.provide(registryLayer))
        const executors = AuthorizedPluginExecutorMap.layer.pipe(Layer.provide(runtimeMap))
        const store = governedActionExecutionStoreLayer(GOVERNED_WORKSPACE).pipe(
          Layer.provideMerge(pluginRuntimeAuthoritySourceLayer),
          Layer.provideMerge(GovernedActionPolicyEvaluator.layer),
          Layer.provideMerge(QuarantineRepository.layer)
        )
        const engineLayer = GovernedActionExecutionEngine.layer.pipe(
          Layer.provide(store),
          Layer.provide(executors)
        )
        const execution = yield* Effect.gen(function*() {
          const engine = yield* GovernedActionExecutionEngine
          return yield* engine.run({
            workspaceId: GOVERNED_WORKSPACE,
            actionId: GOVERNED_ACTION
          })
        }).pipe(Effect.provide(engineLayer))
        const repository = yield* GovernedActionRepository
        const record = yield* repository.read({
          workspaceId: GOVERNED_WORKSPACE,
          actionId: GOVERNED_ACTION
        })
        const terminalApprovals = yield* repository.readLatestTerminalByTarget({
          workspaceId: GOVERNED_WORKSPACE,
          providerId: "clockify",
          targetEntityId: EntityId.make(GOVERNED_ENTITY_ID),
          actionKind: "record-approval",
          limit: 20
        })
        const sourceRevision = Schema.decodeSync(SourceRevision)({
          providerId: "clockify",
          pluginConnectionId: GOVERNED_CONNECTION,
          vendorImmutableId: "clockify-entry-42",
          revision: "fde93bd687136fe87203da46c3a6ac4ecb9a0271cacbf1b472c128a0879a450b",
          sourceUrl: "https://app.clockify.me/tracker",
          firstObservedAt: "2026-07-15T09:45:00.000Z",
          lastObservedAt: "2026-07-15T09:50:00.000Z",
          synchronizedAt: "2026-07-15T09:55:00.000Z",
          normalizationSchemaVersion: 1
        })
        const approval = projectClockifyApproval(
          EntityId.make(GOVERNED_ENTITY_ID),
          sourceRevision,
          terminalApprovals
        )

        assert.deepStrictEqual(execution, { _tag: "advanced", state: "succeeded" })
        assert.strictEqual(record.head.state, "succeeded")
        assert.strictEqual(record.head.lineage._tag, "terminal")
        assert.deepStrictEqual(
          terminalApprovals.map(({ envelope }) => envelope.actionId),
          [GOVERNED_ACTION]
        )
        assert.deepStrictEqual(approval, {
          actionId: GOVERNED_ACTION,
          decision: "approved",
          rationale: "Reviewed against the delivery record",
          decidedAt: authorizationTime
        })
        if (record.head.lineage._tag !== "terminal") {
          return yield* Effect.die("expected terminal Clockify approval")
        }
        const laterApprovalAt = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:01:01.000Z")
        const laterActionId = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-440000000097")
        const tieActionId = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-440000000098")
        const laterRecord = {
          ...record,
          envelope: { ...record.envelope, actionId: laterActionId },
          head: {
            ...record.head,
            lineage: {
              ...record.head.lineage,
              receipt: { ...record.head.lineage.receipt, observedAt: laterApprovalAt }
            }
          }
        }
        const tieRecord = {
          ...laterRecord,
          envelope: { ...laterRecord.envelope, actionId: tieActionId }
        }
        assert.strictEqual(
          projectClockifyApproval(
            EntityId.make(GOVERNED_ENTITY_ID),
            sourceRevision,
            [record, laterRecord]
          )?.actionId,
          laterActionId
        )
        assert.strictEqual(
          projectClockifyApproval(
            EntityId.make(GOVERNED_ENTITY_ID),
            sourceRevision,
            [tieRecord, laterRecord]
          )?.actionId,
          tieActionId
        )
        assert.isNull(projectClockifyApproval(
          EntityId.make(GOVERNED_ENTITY_ID),
          { ...sourceRevision, revision: Revision.make("next-clockify-revision") },
          terminalApprovals
        ))
        assert.isNull(projectClockifyApproval(
          EntityId.make(GOVERNED_ENTITY_ID),
          { ...sourceRevision, pluginConnectionId: UNCONFIGURED_CONNECTION_ID },
          terminalApprovals
        ))
        assert.strictEqual(yield* Ref.get(entryReads), 1)
        assert.strictEqual(yield* Ref.get(mutations), 0)
      }).pipe(
        Effect.provide(makeFirstPartyPluginRuntimeRegistry(unusedCodeCommitClients)),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("loads persisted Clockify authority, reuses its cache, and discovers the exact identity", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
      const config = yield* makePersistenceTestConfig("control-center-first-party-runtime-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const secretRoot = SecretRoot.make(`${root}/secrets`)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const secrets = SecretStore.layer({ secretRoot })
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const dependencies = Layer.mergeAll(
        persistence,
        database,
        secrets,
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient(requests))
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        const secretStore = yield* SecretStore
        yield* persistenceService.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Delivery"),
          createdAt: CREATED_AT
        })
        yield* persistenceService.workspaces.create(OTHER_WORKSPACE_ID, {
          displayName: WorkspaceName.make("Other"),
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: CONNECTION_ID,
          providerId: "clockify",
          displayName: PluginConnectionDisplayName.make("Delivery Clockify"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: UNCONFIGURED_CONNECTION_ID,
          providerId: "clockify",
          displayName: PluginConnectionDisplayName.make("Unconfigured Clockify"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: HISTORICAL_CLOCKIFY_CONNECTION_ID,
          providerId: "clockify",
          displayName: PluginConnectionDisplayName.make("Historical Clockify"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        const apiKeyRef = yield* secretStore.create(new TextEncoder().encode("clockify-secret"))
        const historicalApiKeyRef = yield* secretStore.create(
          new TextEncoder().encode("historical-clockify-secret")
        )
        const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "secret-reference", key: "apiKey", ref: apiKeyRef },
          { _tag: "integer", key: "maximumConcurrency", value: 2 },
          { _tag: "integer", key: "maximumPages", value: 3 },
          { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
          { _tag: "integer", key: "pageSize", value: 10 },
          { _tag: "text", key: "userIds", value: "user-1" },
          { _tag: "url", key: "webBaseUrl", value: "https://app.clockify.me" },
          { _tag: "text", key: "workspaceId", value: "clockify-workspace" }
        ])
        const historicalConfiguration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "secret-reference", key: "apiKey", ref: historicalApiKeyRef },
          { _tag: "integer", key: "maximumConcurrency", value: 2 },
          { _tag: "integer", key: "maximumPages", value: 3 },
          { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
          { _tag: "integer", key: "pageSize", value: 10 },
          { _tag: "text", key: "userIds", value: "user-1" },
          { _tag: "url", key: "webBaseUrl", value: "https://app.clockify.me" },
          { _tag: "text", key: "workspaceId", value: "clockify-workspace" }
        ])
        yield* persistenceService.pluginConfigurations.update(
          WORKSPACE_ID,
          CONNECTION_ID,
          configuration,
          0,
          CREATED_AT
        )
        yield* persistenceService.pluginConfigurations.update(
          WORKSPACE_ID,
          HISTORICAL_CLOCKIFY_CONNECTION_ID,
          historicalConfiguration,
          0,
          CREATED_AT
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          CONNECTION_ID,
          "clockify",
          clockifyReadPluginDescriptor,
          0,
          CREATED_AT
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          HISTORICAL_CLOCKIFY_CONNECTION_ID,
          "clockify",
          clockifyReadOnlyPluginDescriptor,
          0,
          CREATED_AT
        )

        const connections = yield* PluginConnectionMap
        const scope = { workspaceId: WORKSPACE_ID, pluginConnectionId: CONNECTION_ID }
        const firstContext = yield* connections.contextEffect(scope)
        const secondContext = yield* connections.contextEffect(scope)
        const first = Context.get(firstContext, PluginConnection)
        const second = Context.get(secondContext, PluginConnection)
        assert.strictEqual(first, second)

        const discovery = yield* first.discover
        assert.deepStrictEqual(discovery.account, {
          providerImmutableId: "user-1",
          displayName: "Ada Lovelace"
        })
        assert.deepStrictEqual(discovery.workspace, {
          providerImmutableId: "clockify-workspace",
          displayName: "Delivery"
        })
        assert.isNull(discovery.resource)
        assert.strictEqual(requests.length, 2)
        assert.isTrue(requests.every(({ headers }) => headers["x-api-key"] === "clockify-secret"))

        const historicalContext = yield* connections.contextEffect({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: HISTORICAL_CLOCKIFY_CONNECTION_ID
        })
        const historical = Context.get(historicalContext, PluginConnection)
        assert.isTrue(hasPluginCapability(historical.descriptor, "entity.read", 1))
        assert.isFalse(hasPluginCapability(historical.descriptor, "action.propose", 1))
        assert.isFalse(hasPluginCapability(historical.descriptor, "action.execute", 1))
        const historicalProposal = yield* historical.proposeAction(
          Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
            actionKind: "record-approval",
            target: {
              entityType: "time-entry",
              vendorImmutableId: "clockify-entry-42"
            },
            expectedRevision: "historical-revision",
            payload: {
              decision: "approved",
              rationale: "Historical runtime must remain read-only"
            },
            evidenceIds: []
          })
        ).pipe(Effect.result)
        assert.strictEqual(historicalProposal._tag, "Failure")
        if (historicalProposal._tag === "Failure") {
          assert.strictEqual(historicalProposal.failure._tag, "PluginUnsupportedCapabilityFailure")
        }
        assert.strictEqual(requests.length, 2)

        const isolated = yield* Effect.result(connections.contextEffect({
          workspaceId: OTHER_WORKSPACE_ID,
          pluginConnectionId: CONNECTION_ID
        }))
        assert.strictEqual(isolated._tag, "Failure")
        assert.strictEqual(requests.length, 2)

        const missingConfiguration = yield* Effect.result(connections.contextEffect({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: UNCONFIGURED_CONNECTION_ID
        }))
        assert.strictEqual(missingConfiguration._tag, "Failure")
        if (missingConfiguration._tag === "Failure") {
          assert.strictEqual(missingConfiguration.failure._tag, "PluginConfigurationFailure")
          if (missingConfiguration.failure._tag === "PluginConfigurationFailure") {
            assert.strictEqual(missingConfiguration.failure.diagnosticCode, "plugin-configuration-missing")
          }
        }
        assert.strictEqual(requests.length, 2)

        yield* connections.invalidate(scope)
        const thirdContext = yield* connections.contextEffect(scope)
        assert.notStrictEqual(Context.get(thirdContext, PluginConnection), first)
        yield* persistenceService.pluginConnections.updateMetadata(WORKSPACE_ID, CONNECTION_ID, {
          displayName: PluginConnectionDisplayName.make("Delivery Clockify"),
          isEnabled: false,
          expectedRevision: RecordRevision.make(1),
          updatedAt: CREATED_AT
        })
        yield* connections.invalidate(scope)
        const disabled = yield* Effect.result(connections.contextEffect(scope))
        assert.strictEqual(disabled._tag, "Failure")
        if (disabled._tag === "Failure") {
          assert.strictEqual(disabled.failure._tag, "PluginConfigurationFailure")
          if (disabled.failure._tag === "PluginConfigurationFailure") {
            assert.strictEqual(disabled.failure.diagnosticCode, "plugin-connection-disabled")
          }
          assert.notInclude(String(disabled.failure), "clockify-secret")
        }
        assert.strictEqual(requests.length, 2)
      }).pipe(
        Effect.provide(firstPartyPluginConnectionMapLayer),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
