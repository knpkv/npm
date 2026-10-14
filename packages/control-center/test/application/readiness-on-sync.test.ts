import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import * as Clock from "effect/Clock"
import * as Console from "effect/Console"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as HttpClient from "effect/http/HttpClient"
import * as PlatformError from "effect/PlatformError"
import * as SqlSchema from "effect/sql/SqlSchema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"

import {
  CreateRelationshipRepairProposalRequest,
  ReviewRelationshipRepairProposalRequest
} from "../../src/api/deliveryGraph.js"
import { SessionSummary } from "../../src/api/session.js"
import {
  EventCursor,
  PersonId,
  PluginConnectionId,
  SessionId,
  WorkspaceId,
  WorkspaceSettingsMutationId
} from "../../src/domain/identifiers.js"
import { ReadinessGateWaiver } from "../../src/domain/readiness/model.js"
import { PipelineReleaseTarget } from "../../src/domain/releaseTargets.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { renderDurableReleaseAgentPrompt } from "../../src/server/agent/ReleaseAgentPrompt.js"
import { makeManualPluginSynchronization } from "../../src/server/application/manualPluginSynchronization.js"
import { makePortfolioSnapshots } from "../../src/server/application/portfolioSnapshots.js"
import { ReadinessEvaluation } from "../../src/server/application/readinessEvaluation.js"
import { makeRelationshipRepairProposals } from "../../src/server/application/relationshipRepairProposals.js"
import {
  readReleaseTargetCatalog,
  releaseEnvironmentId
} from "../../src/server/application/releaseTargetConfiguration.js"
import { makeWorkspaceSettingsAdministration } from "../../src/server/application/workspaceSettingsAdministration.js"
import { authorizeWorkspaceSettingsGovernanceRequest } from "../../src/server/governance/GovernedHumanMutationPolicyEvaluator.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { AgentJobPrompt } from "../../src/server/persistence/repositories/agentJobModels.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { StoredPluginConfiguration } from "../../src/server/persistence/repositories/pluginConfigurationModels.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { ReadinessLeaseOwner } from "../../src/server/persistence/repositories/readinessRepository.js"
import { codeCommitPluginDescriptor } from "../../src/server/plugins/codecommit/CodeCommitPluginDefinition.js"
import { codePipelinePluginDescriptor } from "../../src/server/plugins/codepipeline/CodePipelinePluginDefinition.js"
import { CodePipelineReadClient } from "../../src/server/plugins/codepipeline/CodePipelineReadClient.js"
import { confluencePagePluginDescriptor } from "../../src/server/plugins/confluence/ConfluencePagePluginDefinition.js"
import { makeFirstPartyPluginRuntimeRegistry } from "../../src/server/plugins/internal/FirstPartyPluginRuntimeRegistry.js"
import { pluginRuntimeAuthoritySourceLayer } from "../../src/server/plugins/internal/PluginRuntimeAuthorityRepository.js"
import { jiraReadPluginDescriptor } from "../../src/server/plugins/jira/JiraReadPlugin.js"
import { PluginConnectionMap } from "../../src/server/plugins/PluginConnectionMap.js"
import { ControlCenterBootstrap } from "../../src/server/runtime/Bootstrap.js"
import { DomainEventWakeups } from "../../src/server/runtime/DomainEventWakeups.js"
import { firstPartyPluginRuntimeLayers } from "../../src/server/runtime/FirstPartyPluginRuntime.js"
import { readinessStartupLayer } from "../../src/server/runtime/ReadinessStartup.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"
import { SecretRoot, SecretStore } from "../../src/server/secrets/SecretStore.js"
import {
  readinessCodeCommitClients,
  readinessHttpTransport,
  readinessPipelineClientLayer,
  readinessPipelineName,
  type ReadinessProviderScenario,
  readinessProviderTime,
  readinessReleaseVersion
} from "../fixtures/readinessProviders.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const workspaceId = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000931")
const ownerId = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000932")
const sessionId = SessionId.make("01890f6f-6d6a-7cc0-98d2-000000000933")
const approverId = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000942")
const approverSessionId = SessionId.make("01890f6f-6d6a-7cc0-98d2-000000000943")
const mutationId = WorkspaceSettingsMutationId.make("01890f6f-6d6a-7cc0-98d2-000000000934")
const jiraId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000935")
const codeCommitId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000936")
const pipelineId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000937")
const confluenceId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000938")
const synchronizedAt = Schema.decodeUnknownSync(UtcTimestamp)(readinessProviderTime)

const ownerSession = Schema.decodeUnknownSync(SessionSummary)({
  sessionId,
  workspaceId,
  actor: { _tag: "human", personId: ownerId },
  permission: "workspace-owner",
  createdAt: readinessProviderTime,
  lastSeenAt: readinessProviderTime,
  idleExpiresAt: "2026-10-12T10:00:00.000Z",
  absoluteExpiresAt: "2026-11-11T10:00:00.000Z",
  revokedAt: null
})

const scenarios: ReadonlyArray<{
  readonly verdict: "blocked" | "ready" | "deploying" | "building" | "shipped" | "held"
  readonly reason: string
  readonly provider: ReadinessProviderScenario
}> = [
  {
    verdict: "blocked",
    reason: "failed build",
    provider: {
      build: "Failed",
      verify: "not-started",
      gate: "not-started",
      deployment: "not-started",
      exactRunbookMetadata: true
    }
  },
  {
    verdict: "ready",
    reason: "passed prerequisites and waiting gate",
    provider: {
      build: "Succeeded",
      verify: "Succeeded",
      gate: "InProgress",
      deployment: "not-started",
      exactRunbookMetadata: true
    }
  },
  {
    verdict: "deploying",
    reason: "approved gate and running deployment",
    provider: {
      build: "Succeeded",
      verify: "Succeeded",
      gate: "Succeeded",
      deployment: "InProgress",
      exactRunbookMetadata: true
    }
  },
  {
    verdict: "building",
    reason: "running build",
    provider: {
      build: "InProgress",
      verify: "not-started",
      gate: "not-started",
      deployment: "not-started",
      exactRunbookMetadata: true
    }
  },
  {
    verdict: "shipped",
    reason: "all deployment actions succeeded",
    provider: {
      build: "Succeeded",
      verify: "Succeeded",
      gate: "Succeeded",
      deployment: "Succeeded",
      exactRunbookMetadata: true
    }
  },
  {
    verdict: "held",
    reason: "title-only runbook relationship awaits confirmation",
    provider: {
      build: "Succeeded",
      verify: "Succeeded",
      gate: "InProgress",
      deployment: "not-started",
      exactRunbookMetadata: false
    }
  }
]

/** Seed administrative authority only; delivery facts must enter through provider synchronization. */
const seedOwner = Effect.gen(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO persons (
    workspace_id, person_id, display_name, avatar_json, is_active, revision, created_at, updated_at
  ) VALUES (
    ${workspaceId}, ${ownerId}, 'Release Owner', '{"_tag":"initials","text":"RO"}', 1, 1,
    ${readinessProviderTime}, ${readinessProviderTime}
  )`
  yield* sql`INSERT INTO sessions (
    workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id, agent_id, permission,
    created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
  ) VALUES (
    ${workspaceId}, ${sessionId}, ${"a".repeat(64)}, ${"b".repeat(64)}, 'human', ${ownerId}, NULL, 'workspace-owner',
    ${readinessProviderTime}, ${readinessProviderTime}, '2026-10-12T10:00:00.000Z', '2026-11-11T10:00:00.000Z', NULL
  )`
})

/** A distinct synthetic reviewer preserves the real repair workflow's separation of duties. */
const seedApprover = Effect.gen(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO persons (workspace_id, person_id, display_name, avatar_json, is_active, revision, created_at, updated_at)
    SELECT workspace_id, ${approverId}, 'Release Approver', '{"_tag":"initials","text":"RA"}', is_active, revision, created_at, updated_at
    FROM persons WHERE workspace_id = ${workspaceId} AND person_id = ${ownerId}`
  yield* sql`INSERT INTO sessions (workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id, agent_id, permission,
    created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at)
    SELECT workspace_id, ${approverSessionId}, ${"c".repeat(64)}, ${
    "d".repeat(64)
  }, 'human', ${approverId}, NULL, permission,
    created_at, last_seen_at, idle_expires_at, absolute_expires_at, NULL
    FROM sessions WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}`
})

const withFirstPartyProviders = Effect.fn("ReadinessOnSyncTest.withFirstPartyProviders")(function*(
  scenario: ReadinessProviderScenario,
  expectedVerdict: typeof scenarios[number]["verdict"],
  options: {
    readonly repeatUnchanged?: boolean
    readonly requiresManualGate?: boolean
    readonly restoreManualGate?: boolean
    readonly staleAfterSync?: boolean
    readonly confirmTitleMatch?: boolean
    readonly backfillExisting?: boolean
    readonly failAndRecover?: boolean
    readonly truncateJiraAfterSync?: boolean
  } = {}
) {
  const timingStartedAt = scenario.releaseCount === undefined
    ? null
    : yield* TestClock.withLive(Clock.currentTimeMillis)
  // Real elapsed time is diagnostic only; provider and readiness clocks stay fixed.
  const markInventoryPhase = Effect.fn("ReadinessOnSyncTest.markInventoryPhase")(function*(phase: string) {
    if (timingStartedAt === null) return
    const elapsedMillis = (yield* TestClock.withLive(Clock.currentTimeMillis)) - timingStartedAt
    yield* Console.log(`[readiness inventory ${scenario.releaseCount}] ${phase}: ${elapsedMillis}ms since start`).pipe(
      Effect.provideService(Console.Console, Console.Console.defaultValue())
    )
  })
  yield* markInventoryPhase("started")
  yield* Effect.addFinalizer(() => markInventoryPhase("scope closed"))
  yield* TestClock.setTime(DateTime.toEpochMillis(synchronizedAt))
  const config = yield* makePersistenceTestConfig("control-center-readiness-on-sync-")
  const requestedPaths: Array<string> = []
  const pipelineContext = yield* Layer.build(readinessPipelineClientLayer(scenario))
  const registry = makeFirstPartyPluginRuntimeRegistry(
    readinessCodeCommitClients,
    Context.get(pipelineContext, CodePipelineReadClient)
  ).pipe(Layer.provide(pluginRuntimeAuthoritySourceLayer))
  const runtime = firstPartyPluginRuntimeLayers(registry)
  const database = databaseLayer(config)
  const dependencies = Layer.mergeAll(
    persistenceLayerFromDatabase(config).pipe(Layer.provideMerge(database)),
    QuarantineRepository.layer.pipe(Layer.provide(database)),
    SecretStore.layer({ secretRoot: SecretRoot.make(`${config.blobRoot.slice(0, -"/blobs".length)}/secrets`) }),
    Layer.succeed(HttpClient.HttpClient, readinessHttpTransport(scenario, requestedPaths)),
    DomainEventWakeups.layer
  )
  yield* Effect.gen(function*() {
    const persistence = yield* Persistence
    const connections = yield* PluginConnectionMap
    const secrets = yield* SecretStore
    yield* markInventoryPhase("persistence and runtime built")
    yield* persistence.workspaces.create(workspaceId, {
      displayName: WorkspaceName.make("Fixture service"),
      createdAt: synchronizedAt
    })
    yield* seedOwner
    const wakeups = yield* DomainEventWakeups
    const readinessChanges = yield* wakeups.subscribe(workspaceId)
    const digestUnavailable = yield* Ref.make(false)
    const actualCrypto = yield* Crypto.Crypto
    const workerCrypto: Crypto.Crypto = {
      ...actualCrypto,
      digest: (algorithm, bytes) =>
        Ref.get(digestUnavailable).pipe(
          Effect.flatMap((unavailable) =>
            unavailable && new TextDecoder().decode(bytes).includes("\u0000readiness-v1\u0000")
              ? Effect.fail(
                PlatformError.badArgument({
                  module: "Crypto",
                  method: "digest",
                  description: "Fixture readiness digest unavailable"
                })
              )
              : actualCrypto.digest(algorithm, bytes)
          )
        )
    }
    const worker = Context.get(
      yield* Layer.build(ReadinessEvaluation.layer.pipe(Layer.provide(Layer.succeed(Crypto.Crypto, workerCrypto)))),
      ReadinessEvaluation
    )
    const startup = readinessStartupLayer.pipe(
      Layer.provide(Layer.succeed(ReadinessEvaluation, worker)),
      Layer.provide(Layer.succeed(ControlCenterBootstrap, { _tag: "already-initialized", workspaceId })),
      Layer.provide(ServerLifecycle.layer)
    )
    if (options.backfillExisting !== true) yield* Layer.build(startup)
    const jiraTokenRef = yield* secrets.create(new TextEncoder().encode("fixture-jira-token"))
    const confluenceTokenRef = yield* secrets.create(new TextEncoder().encode("fixture-confluence-token"))
    const atlassian = [
      { _tag: "text", key: "authMode", value: "api-token" },
      { _tag: "text", key: "email", value: "release-owner@example.com" },
      { _tag: "text", key: "siteId", value: "fixture-site" }
    ]
    const aws = [{ _tag: "text", key: "profile", value: "fixture-profile" }, {
      _tag: "text",
      key: "region",
      value: "eu-west-1"
    }]
    for (
      const connection of [
        {
          id: jiraId,
          providerId: "jira",
          descriptor: jiraReadPluginDescriptor,
          fields: [
            ...atlassian,
            { _tag: "secret-reference", key: "apiToken", ref: jiraTokenRef },
            { _tag: "url", key: "webBaseUrl", value: "https://fixture.atlassian.net/" },
            { _tag: "text", key: "projectId", value: "10000" },
            { _tag: "integer", key: "maximumPages", value: 3 },
            { _tag: "integer", key: "operationTimeoutMillis", value: 5000 },
            { _tag: "integer", key: "pageSize", value: 10 }
          ]
        },
        {
          id: codeCommitId,
          providerId: "codecommit",
          descriptor: codeCommitPluginDescriptor,
          fields: [...aws, { _tag: "text", key: "repositoryName", value: "fixture-repository" }]
        },
        {
          id: pipelineId,
          providerId: "codepipeline",
          descriptor: codePipelinePluginDescriptor,
          fields: [
            ...aws,
            { _tag: "text", key: "pipelineName", value: readinessPipelineName },
            { _tag: "integer", key: "actionPageSize", value: 20 },
            { _tag: "integer", key: "maximumActionPages", value: 1 },
            { _tag: "integer", key: "maximumActionsPerExecution", value: 20 },
            { _tag: "integer", key: "maximumExecutionPages", value: 2 },
            { _tag: "integer", key: "maximumLogBytes", value: 32768 },
            { _tag: "integer", key: "operationTimeoutMillis", value: 5000 }
          ]
        },
        {
          id: confluenceId,
          providerId: "confluence",
          descriptor: confluencePagePluginDescriptor,
          fields: [
            ...atlassian,
            { _tag: "secret-reference", key: "apiToken", ref: confluenceTokenRef },
            { _tag: "url", key: "siteBaseUrl", value: "https://fixture.atlassian.net/" },
            { _tag: "text", key: "spaceId", value: "space-1" },
            { _tag: "text", key: "probePageId", value: "42" }
          ]
        }
      ] satisfies ReadonlyArray<
        {
          readonly id: PluginConnectionId
          readonly providerId: "jira" | "codecommit" | "codepipeline" | "confluence"
          readonly descriptor: unknown
          readonly fields: ReadonlyArray<unknown>
        }
      >
    ) {
      yield* persistence.pluginConnections.create(workspaceId, {
        pluginConnectionId: connection.id,
        providerId: connection.providerId,
        displayName: PluginConnectionDisplayName.make(`Fixture ${connection.providerId}`),
        isEnabled: true,
        createdAt: synchronizedAt
      })
      const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(
        [...connection.fields].sort((left, right) => left.key.localeCompare(right.key))
      )
      yield* persistence.pluginConfigurations.update(workspaceId, connection.id, configuration, 0, synchronizedAt)
      yield* persistence.pluginRuntime.acceptPluginDescriptor(
        workspaceId,
        connection.id,
        connection.providerId,
        connection.descriptor,
        0,
        synchronizedAt
      )
    }
    yield* markInventoryPhase("connections configured")
    const synchronization = yield* makeManualPluginSynchronization(connections)
    const pipelineSync = yield* synchronization.synchronize({ workspaceId, pluginConnectionId: pipelineId })
    assert.equal(pipelineSync.result, "synchronized", "real CodePipeline fixture synchronization must succeed")
    yield* markInventoryPhase("pipeline synchronized")
    const settings = yield* persistence.workspaceSettings.get(workspaceId)
    const catalogue = yield* readReleaseTargetCatalog(persistence, workspaceId, settings.settings)
    const pipeline = catalogue.pipelines.find(({ pluginConnectionId }) => pluginConnectionId === pipelineId)
    if (pipeline === undefined || pipeline.topologyDigest === null) {
      return assert.fail("The real pipeline plugin must persist its ordered topology")
    }
    const target = PipelineReleaseTarget.make({
      pluginConnectionId: pipelineId,
      pipelineName: readinessPipelineName,
      topologyDigest: pipeline.topologyDigest,
      environments: scenario.secondEnvironmentDeployment === undefined
        ? [{
          key: "production",
          name: "Production",
          firstStage: "Build",
          lastStage: scenario.missingDeploymentAction === true ? "Finalize" : "Deploy",
          requiresManualGate: options.requiresManualGate ?? true
        }]
        : [{ key: "staging", name: "Staging", firstStage: "Build", lastStage: "Deploy", requiresManualGate: true }, {
          key: "production",
          name: "Production",
          firstStage: "ProductionApproval",
          lastStage: "ProductionDeploy",
          requiresManualGate: true
        }]
    })
    const request = {
      workspaceId,
      mutationId,
      expectedRevision: settings.revision,
      settings: {
        ...settings.settings,
        synchronization: {
          ...settings.settings.synchronization,
          staleAfterMinutes: options.staleAfterSync === true ? 5 : settings.settings.synchronization.staleAfterMinutes
        },
        pipeline: { ...settings.settings.pipeline, releaseTargets: [target] }
      },
      acknowledgedGovernedSections: ["pipeline"] satisfies ReadonlyArray<"pipeline">,
      actorPersonId: ownerId,
      sessionId
    }
    const governanceAuthority = yield* authorizeWorkspaceSettingsGovernanceRequest(
      ownerSession,
      request,
      synchronizedAt
    )
    const { workspaceId: requestWorkspaceId, ...settingsInput } = request
    yield* persistence.workspaceSettings.update(requestWorkspaceId, {
      ...settingsInput,
      governanceAuthority,
      updatedAt: synchronizedAt
    })
    yield* markInventoryPhase("targets configured")
    for (const pluginConnectionId of [jiraId, codeCommitId, confluenceId]) {
      const result = yield* synchronization.synchronize({ workspaceId, pluginConnectionId })
      assert.equal(
        result.result,
        "synchronized",
        `real ${result.providerId} fixture synchronization must succeed: ${
          result.failure?.safeMessage ?? "no provider failure"
        }; requested ${requestedPaths.join(", ")}`
      )
      yield* markInventoryPhase(`${result.providerId} synchronized`)
    }
    assert.includeMembers(requestedPaths, [
      "/rest/api/3/myself",
      "/rest/api/3/search/jql",
      "/wiki/api/v2/spaces/space-1/pages"
    ])
    if (scenario.releaseCount !== undefined) {
      const releases = yield* persistence.releases.list(workspaceId, 200)
      assert.lengthOf(releases, scenario.releaseCount)
      for (const { release } of releases) {
        assert.lengthOf(release.targetEnvironmentIds, 1, `${release.version} must retain its configured target`)
      }
      const releaseIds = releases.map(({ release }) => release.id)
      const { sql } = yield* Database
      // Admission's listPending excludes leased work. This test barrier includes
      // claimed rows too, so the last in-flight assessment cannot look drained.
      const readQueueOccupancy = SqlSchema.findOne({
        Request: WorkspaceId,
        Result: Schema.Struct({ pending: Schema.Literals([0, 1]) }),
        execute: (id) =>
          sql`SELECT (
          EXISTS(SELECT 1 FROM readiness_environment_queue WHERE workspace_id = ${id}) OR
          EXISTS(SELECT 1 FROM readiness_release_queue WHERE workspace_id = ${id})
        ) AS pending`
      })
      // Decode the complete inventory once after drain, not on every wake hint.
      const awaitReady = readinessChanges.pipe(
        Stream.filterEffect(() => readQueueOccupancy(workspaceId).pipe(Effect.map(({ pending }) => pending === 0)))
      )
      yield* Stream.runHead(awaitReady)
      yield* markInventoryPhase("initial queue drained")
      const eventsBefore = yield* persistence.events.readLatestReadinessOutcomes(workspaceId, releaseIds)
      assert.lengthOf(eventsBefore, scenario.releaseCount)
      assert.isEmpty(
        eventsBefore.filter(({ payload }) => payload.reason === "readiness-failed"),
        "healthy release inventory must not cause readiness-publication-failed"
      )
      const before = yield* persistence.readiness.readCurrentReleases({ workspaceId, releaseIds })
      const releasesById = new Map(releases.map(({ release }) => [release.id, release]))
      assert.lengthOf(before, scenario.releaseCount)
      for (const head of before) {
        assert.equal(head.authority, "authoritative")
        assert.equal(head.assessment.verdict, "ready")
        assert.isTrue(head.assessment.sourceFreshness.some((source) => source.pluginConnectionId === confluenceId))
        const release = releasesById.get(head.assessment.candidate.scope.releaseId)
        if (release === undefined) return assert.fail("expected assessed inventory release")
        assert.lengthOf(head.assessment.environments, 1)
        for (const environment of head.assessment.environments) {
          assert.equal(environment.environmentId, release.targetEnvironmentIds[0])
          assert.equal(environment.verdict, "ready")
          // The assessment retains these exact link observations; inspecting them
          // avoids hydrating the same delivery closure again for every release.
          for (
            const { factId, kind } of [
              { kind: "implements", factId: "code.implements" },
              { kind: "delivered-by", factId: "pipeline.relationship" },
              { kind: "documented-by", factId: "runbook.relationship" }
            ]
          ) {
            const fact = environment.facts.find(({ definition }) => definition.factId === factId)
            if (fact === undefined) return assert.fail(`${release.version} must retain its ${kind} observation`)
            assert.equal(fact.result, "verified")
            assert.equal(fact.observation?.state._tag, "relationship")
            assert.equal(fact.observation?.state.status, "verified")
            assert.isNotEmpty(fact.evidenceIds)
          }
        }
      }
      yield* markInventoryPhase("all initial outcomes checked")
      // Jira materialization is the gt50 regression trigger. The neighboring
      // single-release case retains unchanged-sync coverage for all four providers.
      const repeated = yield* synchronization.synchronize({ workspaceId, pluginConnectionId: jiraId })
      assert.equal(repeated.result, "synchronized")
      yield* markInventoryPhase("unchanged Jira synchronized")
      yield* Stream.runHead(awaitReady)
      yield* markInventoryPhase("repeat queue drained")
      assert.deepEqual(
        yield* persistence.readiness.readCurrentReleases({ workspaceId, releaseIds }),
        before,
        "unchanged provider evidence must preserve every assessment revision"
      )
      assert.deepEqual(
        yield* persistence.events.readLatestReadinessOutcomes(workspaceId, releaseIds),
        eventsBefore,
        "unchanged provider evidence must not publish extra readiness outcomes"
      )
      yield* markInventoryPhase("unchanged assessments and events checked")
      return
    }
    const portfolio = yield* makePortfolioSnapshots
    const releaseId = (yield* persistence.releases.list(workspaceId, 10)).find(({ release }) =>
      release.version === readinessReleaseVersion
    )?.release.id
    if (releaseId === undefined) return assert.fail("expected synchronized release")
    if (options.backfillExisting === true) {
      const now = yield* DateTime.now
      const pending = yield* persistence.readiness.listPending({ workspaceId, releaseId, dueAt: now, limit: 100 })
      for (const entry of pending) {
        const claimed = yield* persistence.readiness.claimInvalidation({
          ...entry,
          expectedInvalidationRevision: entry.invalidationRevision,
          leaseOwner: ReadinessLeaseOwner.make("01890f6f-6d6a-7cc0-98d2-000000000944"),
          leaseExpiresAt: DateTime.add(now, { minutes: 5 })
        })
        if (claimed?.lease === null || claimed === null) return assert.fail("expected removable legacy queue work")
        yield* persistence.readiness.acknowledgeInvalidation({
          ...entry,
          invalidationRevision: claimed.invalidationRevision,
          leaseOwner: claimed.lease.owner,
          leaseToken: claimed.lease.token
        })
      }
      assert.isEmpty(yield* persistence.readiness.listPending({ workspaceId, releaseId, dueAt: now, limit: 100 }))
      assert.isNull((yield* persistence.readiness.readCurrent({ _tag: "release", workspaceId, releaseId })).record)
      yield* Layer.build(startup)
    }
    // Observe the natural supervised publication path. Wake hints are subscribed before sync starts.
    yield* Stream.runHead(readinessChanges.pipe(Stream.filterEffect(() =>
      Effect.gen(function*() {
        const page = yield* persistence.events.pageAfter(workspaceId, EventCursor.make(0), 100)
        if (page._tag === "page" && page.events.some((event) => event.payload.reason === "readiness-failed")) {
          return true
        }
        const current = yield* persistence.readiness.readCurrent({ _tag: "release", workspaceId, releaseId })
        return current.record?.authority === "authoritative" &&
          current.record.assessment.sourceFreshness.some(({ pluginConnectionId }) =>
            pluginConnectionId === confluenceId
          )
      })
    )))
    const snapshot = yield* portfolio.snapshot(workspaceId)
    const release = snapshot.releases.find(({ version }) => version === readinessReleaseVersion)
    if (release === undefined) return assert.fail("Jira fixVersions must materialize the fixture release")
    assert.lengthOf(
      release.targetEnvironmentIds,
      scenario.secondEnvironmentDeployment === undefined ? 1 : 2,
      "exact head-commit association must select the configured target"
    )
    const current = yield* persistence.readiness.readCurrent({
      _tag: "release",
      workspaceId,
      releaseId: release.releaseId
    })
    assert.isNotNull(current.record, "the portfolio verdict must be backed by a committed release assessment")
    const facts = current._tag === "release" ?
      current.record?.assessment.environments.flatMap(({ facts }) =>
        facts.map(({ definition, observation, result }) => ({
          fact: definition.factId,
          state: observation?.state,
          result,
          freshness: observation?.evidence.map(({ freshness, source }) => ({ freshness, source }))
        }))
      ) :
      []
    assert.equal(
      release.readiness?.verdict,
      expectedVerdict,
      `successful provider synchronization must produce an assessment: ${JSON.stringify(facts)}`
    )
    if (scenario.boundedJiraCatchUp === true) {
      const runtime = yield* persistence.pluginRuntime.getRuntime(workspaceId, jiraId)
      assert.equal(runtime.health._tag, "healthy", "bounded catch-up must not report a provider outage")
      assert.notEqual(release.freshness._tag, "unavailable")
      assert.equal(release.readiness?.primaryFinding?.code, "input-incomplete")
      const resumed = yield* synchronization.synchronize({ workspaceId, pluginConnectionId: jiraId })
      assert.equal(resumed.result, "synchronized")
      yield* Stream.runHead(
        readinessChanges.pipe(
          Stream.filterEffect(() =>
            persistence.readiness.readCurrent({ _tag: "release", workspaceId, releaseId }).pipe(
              Effect.map((head) =>
                head.record?.authority === "authoritative" && head.record.assessment.verdict === "ready"
              )
            )
          )
        )
      )
      const finished = yield* persistence.readiness.readCurrent({ _tag: "release", workspaceId, releaseId })
      assert.equal(finished.record?.assessment.verdict, "ready")
      assert.equal(finished.record?.assessment.previousAssessmentId, current.record?.assessment.assessmentId)
      assert.equal((yield* persistence.pluginRuntime.getRuntime(workspaceId, jiraId)).health._tag, "healthy")
    }
    if (scenario.secondEnvironmentDeployment !== undefined) {
      if (current._tag !== "release" || current.record === null) {
        return assert.fail("expected scoped release assessment")
      }
      const stagingId = yield* releaseEnvironmentId(workspaceId, "staging")
      const productionId = yield* releaseEnvironmentId(workspaceId, "production")
      assert.equal(
        current.record.assessment.environments.find(({ environmentId }) => environmentId === stagingId)?.verdict,
        "shipped"
      )
      assert.equal(
        current.record.assessment.environments.find(({ environmentId }) => environmentId === productionId)?.verdict,
        "deploying",
        "a successful earlier deployment cannot ship the later target"
      )
    }
    if (options.truncateJiraAfterSync === true) {
      yield* TestClock.adjust("1 second")
      const sync = yield* synchronization.synchronize({ workspaceId, pluginConnectionId: jiraId })
      assert.equal(sync.result, "synchronized")
      yield* Stream.runHead(
        readinessChanges.pipe(
          Stream.filterEffect(() =>
            persistence.readiness.readCurrent({ _tag: "release", workspaceId, releaseId }).pipe(
              Effect.map((head) =>
                head.record?.authority === "authoritative" &&
                head.record.assessment.assessmentId !== current.record?.assessment.assessmentId
              )
            )
          )
        )
      )
      const truncated = yield* persistence.readiness.readCurrent({ _tag: "release", workspaceId, releaseId })
      if (truncated._tag !== "release") return assert.fail("expected release assessment")
      assert.equal(
        truncated.record?.assessment.verdict,
        "held",
        "a retained verified membership cannot make a truncated Jira snapshot green"
      )
      assert.equal(
        truncated.record?.assessment.environments[0]?.facts.find(({ definition }) =>
          definition.factId === "jira.membership"
        )?.result,
        "gap"
      )
    }
    if (options.failAndRecover === true) {
      const target = { _tag: "release", workspaceId, releaseId } satisfies {
        readonly _tag: "release"
        readonly workspaceId: WorkspaceId
        readonly releaseId: typeof releaseId
      }
      const historyBefore = yield* persistence.readiness.readHistory({
        ...target,
        beforeHeadRevision: null,
        limit: 100
      })
      yield* Ref.set(digestUnavailable, true)
      const sync = yield* synchronization.synchronize({ workspaceId, pluginConnectionId: confluenceId })
      assert.equal(sync.result, "synchronized", "readiness failure must preserve successful provider synchronization")
      yield* Stream.runHead(readinessChanges.pipe(Stream.filterEffect(() =>
        portfolio.snapshot(workspaceId).pipe(
          Effect.map((page) =>
            page.releases.some((entry) => entry.releaseId === releaseId && entry.readinessFailure !== undefined)
          )
        )
      )))
      const failed = (yield* portfolio.snapshot(workspaceId)).releases.find((entry) => entry.releaseId === releaseId)
      assert.equal(failed?.readinessFailure?.diagnosticCode, "readiness-evidence-invalid")
      assert.equal(failed?.readiness?.authority, "pending")
      const failureCount = Effect.gen(function*() {
        const page = yield* persistence.events.pageAfter(workspaceId, EventCursor.make(0), 100)
        return page._tag === "page"
          ? page.events.filter(({ payload }) => payload.reason === "readiness-failed").length
          : 0
      })
      assert.equal(yield* failureCount, 1)
      yield* TestClock.adjust("31 seconds")
      yield* worker.runOnce(workspaceId)
      assert.equal(yield* failureCount, 1, "retry of unchanged failing work must not churn failure events")
      yield* Ref.set(digestUnavailable, false)
      yield* TestClock.adjust("31 seconds")
      yield* Stream.runHead(readinessChanges.pipe(Stream.filterEffect(() =>
        portfolio.snapshot(workspaceId).pipe(
          Effect.map((page) =>
            page.releases.some((entry) =>
              entry.releaseId === releaseId && entry.readiness?.authority === "authoritative" &&
              entry.readinessFailure === undefined
            )
          )
        )
      )))
      assert.deepEqual(
        yield* persistence.readiness.readHistory({ ...target, beforeHeadRevision: null, limit: 100 }),
        historyBefore,
        "recovery from a temporary evaluation failure must preserve unchanged assessment revisions"
      )
    }
    if (options.confirmTitleMatch === true) {
      yield* seedApprover
      const slice = yield* persistence.deliveryGraph.read(workspaceId, {
        _tag: "releaseSlice",
        releaseId,
        environmentId: null,
        limit: 100
      })
      if (slice._tag !== "releaseSlice") return assert.fail("expected synchronized delivery slice")
      const relationship = slice.value.relationships.find(({ kind, lifecycle, sourceNodeKind }) =>
        kind === "documented-by" && sourceNodeKind === "release" && lifecycle._tag === "inferred"
      )
      if (relationship === undefined) return assert.fail("title-only runbook must remain an inferred relationship")
      const repairs = yield* makeRelationshipRepairProposals
      const proposal = yield* repairs.create({
        workspaceId,
        releaseId,
        relationshipId: relationship.relationshipId,
        actor: ownerSession.actor,
        sessionId,
        request: Schema.decodeUnknownSync(CreateRelationshipRepairProposalRequest)({
          proposalId: "01890f6f-6d6a-7cc0-98d2-000000000940",
          expectedRevision: relationship.revision,
          environmentId: null,
          disposition: "verify",
          rationale: "Release Owner confirmed the runbook for this exact release."
        })
      })
      yield* repairs.review({
        workspaceId,
        proposalId: proposal.proposalId,
        actor: { _tag: "human", personId: approverId },
        sessionId: approverSessionId,
        request: Schema.decodeUnknownSync(ReviewRelationshipRepairProposalRequest)({
          reviewId: "01890f6f-6d6a-7cc0-98d2-000000000941",
          decision: "approved",
          rationale: "Release Approver checked the release identity and task list."
        })
      })
      yield* repairs.apply({ workspaceId, proposalId: proposal.proposalId, actor: ownerSession.actor, sessionId })
      yield* worker.runOnce(workspaceId)
      const confirmed = yield* persistence.readiness.readCurrent({ _tag: "release", workspaceId, releaseId })
      assert.equal(
        confirmed.record?.assessment.verdict,
        "ready",
        "a governed confirmation must unlock the fuzzy runbook link"
      )
      assert.equal(confirmed.record?.assessment.previousAssessmentId, current.record?.assessment.assessmentId)
    }
    if (options.requiresManualGate === false) {
      if (current._tag !== "release" || current.record === null) {
        return assert.fail("expected committed waiver assessment")
      }
      const gate = current.record.assessment.environments[0]?.facts.find(({ definition }) =>
        definition.factId === "pipeline.gate"
      )
      assert.equal(gate?.result, "waived", "settings exemption must never become an approved or verified gate")
      if (gate?.observation?.state._tag !== "relationship" || gate.observation.state.waiver === undefined) {
        return assert.fail("waiver must retain its immutable settings audit")
      }
      const audits = yield* persistence.workspaceSettings.audits(workspaceId)
      const audit = audits.find((entry) => entry.mutationId === mutationId)
      if (audit === undefined) return assert.fail("missing governed settings audit")
      assert.deepEqual(
        gate.observation.state.waiver,
        Schema.decodeUnknownSync(Schema.toType(ReadinessGateWaiver))({
          settingsRevision: audit.toRevision,
          settingsAuditId: audit.mutationId,
          settingsDigest: `sha256:${audit.afterDigest}`,
          topologyDigest: target.topologyDigest,
          auditedAt: audit.occurredAt
        })
      )
      const waiverLabel = `waived by target settings (${readinessProviderTime})`
      assert.deepEqual(release.readiness?.gateWaivers, [gate.observation.state.waiver])
      const persistedRelease = yield* persistence.releases.get(workspaceId, releaseId)
      assert.isTrue(
        Schema.is(AgentJobPrompt)(
          renderDurableReleaseAgentPrompt(persistedRelease.release, "x".repeat(2500), current.record)
        ),
        "waiver binding must fit the durable prompt with a maximum accepted question"
      )
      assert.include(
        renderDurableReleaseAgentPrompt(persistedRelease.release, "Explain readiness", current.record),
        waiverLabel,
        "Relay must describe the settings waiver without claiming approval"
      )
      const environmentId = current.record.assessment.environments[0]?.environmentId
      if (environmentId === undefined) return assert.fail("expected target environment")
      const environment = yield* persistence.readiness.readCurrent({
        _tag: "environment",
        workspaceId,
        releaseId,
        environmentId
      })
      if (environment._tag !== "environment") return assert.fail("expected environment assessment")
      assert.isFalse(environment.record?.assessment.verifiedFactIds.includes(gate.definition.factId))
      if (options.restoreManualGate === true) {
        const administration = yield* makeWorkspaceSettingsAdministration
        const settingsBefore = yield* administration.read(workspaceId)
        yield* administration.update({
          workspaceId,
          session: ownerSession,
          request: {
            mutationId: WorkspaceSettingsMutationId.make("01890f6f-6d6a-7cc0-98d2-000000000939"),
            expectedRevision: settingsBefore.revision,
            settings: {
              ...settingsBefore.settings,
              pipeline: {
                ...settingsBefore.settings.pipeline,
                releaseTargets: [{
                  ...target,
                  environments: target.environments.map((range) => ({ ...range, requiresManualGate: true }))
                }]
              }
            },
            acknowledgedGovernedSections: ["pipeline"]
          }
        })
        const pending = yield* persistence.readiness.readCurrent({ _tag: "release", workspaceId, releaseId })
        assert.equal(
          pending.record?.authority,
          "pending",
          "restoring a required gate must invalidate its former waiver"
        )
        yield* worker.runOnce(workspaceId)
        const restored = yield* persistence.readiness.readCurrent({ _tag: "release", workspaceId, releaseId })
        assert.equal(restored.record?.assessment.verdict, "held", "missing restored gate must hold the release")
      }
    }
    if (options.staleAfterSync === true) {
      const settingsNow = yield* persistence.workspaceSettings.get(workspaceId)
      yield* TestClock.adjust(`${settingsNow.settings.synchronization.staleAfterMinutes + 1} minutes`)
      yield* Stream.runHead(
        readinessChanges.pipe(
          Stream.filterEffect(() =>
            persistence.readiness.readCurrent({ _tag: "release", workspaceId, releaseId }).pipe(
              Effect.map((head) =>
                head.record?.authority === "authoritative" && head.record.assessment.verdict === "held"
              )
            )
          )
        )
      )
      const stale = yield* persistence.readiness.readCurrent({ _tag: "release", workspaceId, releaseId })
      assert.equal(stale.record?.assessment.verdict, "held", "expired provider evidence must never remain green")
      assert.equal(stale.record?.assessment.previousAssessmentId, current.record?.assessment.assessmentId)
    }
    if (options.repeatUnchanged === true) {
      const target = { _tag: "release", workspaceId, releaseId } satisfies {
        readonly _tag: "release"
        readonly workspaceId: WorkspaceId
        readonly releaseId: typeof releaseId
      }
      const before = yield* persistence.readiness.readHistory({ ...target, beforeHeadRevision: null, limit: 100 })
      const eventsBefore = yield* persistence.events.pageAfter(workspaceId, EventCursor.make(0), 100)
      yield* TestClock.adjust("10 seconds")
      for (const pluginConnectionId of [pipelineId, jiraId, codeCommitId, confluenceId]) {
        const result = yield* synchronization.synchronize({ workspaceId, pluginConnectionId })
        assert.equal(result.result, "synchronized")
      }
      yield* Stream.runHead(
        readinessChanges.pipe(
          Stream.filterEffect(() =>
            persistence.readiness.readCurrent(target).pipe(
              Effect.map((head) => head.record?.authority === "authoritative")
            )
          )
        )
      )
      const after = yield* persistence.readiness.readHistory({ ...target, beforeHeadRevision: null, limit: 100 })
      const eventsAfter = yield* persistence.events.pageAfter(workspaceId, EventCursor.make(0), 100)
      assert.deepEqual(after, before, "unchanged provider facts must keep the complete assessment history")
      const count = (page: typeof eventsBefore) =>
        page._tag === "page" ? page.events.filter(({ payload }) => payload.reason === "readiness-changed").length : 0
      assert.equal(
        count(eventsAfter),
        count(eventsBefore),
        "unchanged provider facts must not publish readiness events"
      )
    }
  }).pipe(Effect.provideContext(yield* Layer.build(runtime.connections.pipe(Layer.provideMerge(dependencies)))))
})

describe("readiness after real first-party synchronization", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("bounded catch-up remains healthy and held until the provider emits a terminal page", () =>
      withFirstPartyProviders({
        build: "Succeeded",
        verify: "Succeeded",
        gate: "InProgress",
        deployment: "not-started",
        exactRunbookMetadata: true,
        boundedJiraCatchUp: true
      }, "held").pipe(Effect.scoped))
    it.effect("two configured environment ranges share build prerequisites and isolate deployment", () =>
      withFirstPartyProviders({
        build: "Succeeded",
        verify: "Succeeded",
        gate: "Succeeded",
        deployment: "Succeeded",
        secondEnvironmentDeployment: "InProgress",
        exactRunbookMetadata: true
      }, "deploying").pipe(Effect.scoped))
    it.effect("a truncated Jira fixVersions snapshot invalidates retained verified membership", () =>
      withFirstPartyProviders(
        {
          build: "Succeeded",
          verify: "Succeeded",
          gate: "InProgress",
          deployment: "not-started",
          exactRunbookMetadata: true,
          truncateJiraAfterFirstSync: true
        },
        "ready",
        { truncateJiraAfterSync: true }
      ).pipe(Effect.scoped))
    it.effect("successful sync records a readiness failure and recovers without assessment or event churn", () =>
      withFirstPartyProviders(
        {
          build: "Succeeded",
          verify: "Succeeded",
          gate: "InProgress",
          deployment: "not-started",
          exactRunbookMetadata: true
        },
        "ready",
        { failAndRecover: true }
      ).pipe(Effect.scoped))
    it.effect("startup backfills existing provider facts without an assessment or queued invalidation", () =>
      withFirstPartyProviders(
        {
          build: "Succeeded",
          verify: "Succeeded",
          gate: "InProgress",
          deployment: "not-started",
          exactRunbookMetadata: true
        },
        "ready",
        { backfillExisting: true }
      ).pipe(Effect.scoped))
    it.effect("one passed deployment cannot hide a missing configured deployment action", () =>
      withFirstPartyProviders({
        build: "Succeeded",
        verify: "Succeeded",
        gate: "Succeeded",
        deployment: "Succeeded",
        exactRunbookMetadata: true,
        missingDeploymentAction: true
      }, "held").pipe(Effect.scoped))
    it.effect("title-only runbook stays held until a governed confirmation", () =>
      withFirstPartyProviders(
        {
          build: "Succeeded",
          verify: "Succeeded",
          gate: "InProgress",
          deployment: "not-started",
          exactRunbookMetadata: false
        },
        "held",
        { confirmTitleMatch: true }
      ).pipe(Effect.scoped))
    it.effect("a required missing manual gate holds otherwise passing provider evidence", () =>
      withFirstPartyProviders({
        build: "Succeeded",
        verify: "Succeeded",
        gate: "absent",
        deployment: "not-started",
        exactRunbookMetadata: true
      }, "held").pipe(Effect.scoped))
    it.effect("truncated pipeline action inventory holds otherwise passing provider evidence", () =>
      withFirstPartyProviders({
        build: "Succeeded",
        verify: "Succeeded",
        gate: "InProgress",
        deployment: "not-started",
        exactRunbookMetadata: true,
        truncatedActions: true
      }, "held").pipe(Effect.scoped))
    it.effect("an unresolved runbook body holds otherwise passing provider evidence", () =>
      withFirstPartyProviders({
        build: "Succeeded",
        verify: "Succeeded",
        gate: "InProgress",
        deployment: "not-started",
        exactRunbookMetadata: true,
        missingRunbookBody: true
      }, "held").pipe(Effect.scoped))
    it.effect("expired provider evidence becomes held under the supervised expiry worker", () =>
      withFirstPartyProviders(
        {
          build: "Succeeded",
          verify: "Succeeded",
          gate: "InProgress",
          deployment: "not-started",
          exactRunbookMetadata: true
        },
        "ready",
        { staleAfterSync: true }
      ).pipe(Effect.scoped))
    it.effect("resolved empty runbook satisfies the zero-task rule", () =>
      withFirstPartyProviders({
        build: "Succeeded",
        verify: "Succeeded",
        gate: "InProgress",
        deployment: "not-started",
        exactRunbookMetadata: true,
        runbookTasks: "empty"
      }, "ready").pipe(Effect.scoped))
    it.effect("gate waiver binds its audit and restoring the requirement invalidates it", () =>
      withFirstPartyProviders(
        {
          build: "Succeeded",
          verify: "Succeeded",
          gate: "absent",
          deployment: "not-started",
          exactRunbookMetadata: true
        },
        "ready",
        { requiresManualGate: false, restoreManualGate: true }
      ).pipe(Effect.scoped))
    it.effect("unchanged facts keep assessment revisions and readiness events", () =>
      withFirstPartyProviders(
        {
          build: "Succeeded",
          verify: "Succeeded",
          gate: "InProgress",
          deployment: "not-started",
          exactRunbookMetadata: true
        },
        "ready",
        { repeatUnchanged: true }
      ).pipe(Effect.scoped))
    // Local 9.25s exceeded 20s in CI at f470a2d, run 38562629431; this one boundary case gets 60s.
    it.effect(
      "all 51 releases keep healthy links and ready assessments through unchanged sync",
      () =>
        withFirstPartyProviders({
          build: "Succeeded",
          verify: "Succeeded",
          gate: "InProgress",
          deployment: "not-started",
          exactRunbookMetadata: true,
          releaseCount: 51
        }, "ready").pipe(Effect.scoped),
      60_000
    )
    for (const scenario of scenarios) {
      it.effect(`${scenario.verdict}: ${scenario.reason}`, () =>
        withFirstPartyProviders(scenario.provider, scenario.verdict).pipe(Effect.scoped))
    }
  })
})
