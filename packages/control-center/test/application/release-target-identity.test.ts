import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { EnvironmentId, PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { PluginSyncPageV1 } from "../../src/domain/plugins/events.js"
import { PipelineReleaseTarget } from "../../src/domain/releaseTargets.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { materializeNormalizedPluginPage } from "../../src/server/application/normalizedPluginPageMaterialization.js"
import {
  readReleaseTargetCatalog,
  reconcileReleaseTargets,
  releaseEnvironmentId
} from "../../src/server/application/releaseTargetConfiguration.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { PluginStreamKey } from "../../src/server/persistence/repositories/pluginRuntimeModels.js"
import { codeCommitPluginDescriptor } from "../../src/server/plugins/codecommit/CodeCommitPluginDefinition.js"
import { codePipelinePluginDescriptor } from "../../src/server/plugins/codepipeline/CodePipelinePluginDefinition.js"
import { firstPartySyncStreamKey } from "../../src/server/plugins/firstPartySynchronization.js"
import { normalizeJiraIssueEvents } from "../../src/server/plugins/jira/JiraIssueNormalization.js"
import { jiraReadPluginDescriptor } from "../../src/server/plugins/jira/JiraReadPlugin.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const workspaceId = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000941")
const otherWorkspaceId = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000942")

describe("release target identity", () => {
  it.layer(NodeCrypto.layer)((it) => {
    it.effect("produces schema-valid stable environment IDs scoped to workspace and key", () =>
      Effect.gen(function*() {
        const production = yield* releaseEnvironmentId(workspaceId, "production")
        assert.isTrue(Schema.is(EnvironmentId)(production))
        assert.equal(yield* releaseEnvironmentId(workspaceId, "production"), production)
        assert.notEqual(yield* releaseEnvironmentId(workspaceId, "staging"), production)
        assert.notEqual(yield* releaseEnvironmentId(otherWorkspaceId, "production"), production)
      }))
  })
  it.layer(NodeServices.layer)((it) => {
    it.effect("reconciles a configured delivering pipeline into a persisted schema-valid target", () =>
      Effect.gen(function*() {
        const committedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-10-11T10:00:00.000Z")
        yield* TestClock.setTime(DateTime.toEpochMillis(committedAt))
        const config = yield* makePersistenceTestConfig("control-center-release-target-reconciliation-")
        const persistenceLayer = persistenceLayerFromDatabase(config).pipe(Layer.provide(databaseLayer(config)))
        yield* Effect.gen(function*() {
          const persistence = yield* Persistence
          const jiraId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000943")
          const codeCommitId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000944")
          const pipelineId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000945")
          const timestamp = DateTime.formatIso(committedAt)
          yield* persistence.workspaces.create(workspaceId, {
            displayName: WorkspaceName.make("Fixture service"),
            createdAt: committedAt
          })
          for (
            const connection of [
              { id: jiraId, providerId: "jira", descriptor: jiraReadPluginDescriptor },
              { id: codeCommitId, providerId: "codecommit", descriptor: codeCommitPluginDescriptor },
              { id: pipelineId, providerId: "codepipeline", descriptor: codePipelinePluginDescriptor }
            ] satisfies ReadonlyArray<
              {
                readonly id: PluginConnectionId
                readonly providerId: "jira" | "codecommit" | "codepipeline"
                readonly descriptor: unknown
              }
            >
          ) {
            yield* persistence.pluginConnections.create(workspaceId, {
              pluginConnectionId: connection.id,
              providerId: connection.providerId,
              displayName: PluginConnectionDisplayName.make(`Fixture ${connection.providerId}`),
              isEnabled: true,
              createdAt: committedAt
            })
            yield* persistence.pluginRuntime.acceptPluginDescriptor(
              workspaceId,
              connection.id,
              connection.providerId,
              connection.descriptor,
              0,
              committedAt
            )
          }
          const jiraEvents = yield* normalizeJiraIssueEvents({
            observedAt: committedAt,
            webBaseUrl: new URL("https://fixture.atlassian.net/"),
            comments: { values: [], total: 0, truncated: false },
            changelogs: { values: [], total: 0, truncated: false },
            issue: {
              id: "10042",
              key: "FIX-42",
              fields: {
                summary: "Fixture release work",
                updated: timestamp,
                project: { id: "10000", key: "FIX", name: "Fixture service" },
                fixVersions: [{ id: "20000", name: "2.18.0", released: false }]
              }
            }
          })
          const jiraPage = Schema.decodeUnknownSync(Schema.toType(PluginSyncPageV1))({
            checkpointAfterPage: "jira-complete",
            hasMore: false,
            events: jiraEvents
          })
          yield* materializeNormalizedPluginPage({
            workspaceId,
            pluginConnectionId: jiraId,
            providerId: "jira",
            streamKey: PluginStreamKey.make(firstPartySyncStreamKey("jira")),
            expectedRevision: 0,
            committedAt,
            successfulHealth: { _tag: "healthy", checkedAt: committedAt }
          }, jiraPage)
          const pullRequestPage = Schema.decodeUnknownSync(PluginSyncPageV1)({
            checkpointAfterPage: "pull-requests-complete",
            hasMore: false,
            events: [{
              _tag: "UpsertEntity",
              eventId: "fixture-pr-17",
              observedAt: timestamp,
              revision: "pr-1",
              entityType: "pull-request",
              vendorImmutableId: "17",
              sourceUrl: null,
              title: "FIX-42 release work",
              attributes: {
                repository: "fixture-repository",
                sourceBranch: "feat/FIX-42-delivery",
                targetBranch: "main",
                headRevision: "a".repeat(40),
                status: "MERGED"
              }
            }]
          })
          yield* materializeNormalizedPluginPage({
            workspaceId,
            pluginConnectionId: codeCommitId,
            providerId: "codecommit",
            streamKey: PluginStreamKey.make(firstPartySyncStreamKey("codecommit")),
            expectedRevision: 0,
            committedAt,
            successfulHealth: { _tag: "healthy", checkedAt: committedAt }
          }, pullRequestPage)
          const pipelinePage = Schema.decodeUnknownSync(PluginSyncPageV1)({
            checkpointAfterPage: "executions-complete",
            hasMore: false,
            events: [{
              _tag: "UpsertEntity",
              eventId: "fixture-pipeline-definition",
              observedAt: timestamp,
              revision: "pipeline-1",
              entityType: "aws.codepipeline.pipeline",
              vendorImmutableId: "fixture-pipeline",
              sourceUrl: null,
              title: "Fixture pipeline",
              attributes: {
                pipelineName: "fixture-pipeline",
                sampledAt: timestamp,
                stages: [{
                  name: "Deploy",
                  actions: [{
                    name: "Rollout",
                    actionType: { category: "Deploy", provider: "CodeDeploy" }
                  }]
                }]
              }
            }, {
              _tag: "UpsertEntity",
              eventId: "fixture-pipeline-execution",
              observedAt: timestamp,
              revision: "execution-1",
              entityType: "aws.codepipeline.execution",
              vendorImmutableId: "fixture-pipeline:execution-1",
              sourceUrl: null,
              title: "Fixture delivery",
              attributes: {
                pipelineName: "fixture-pipeline",
                executionId: "execution-1",
                status: "Succeeded",
                sourceRevisions: [{ revisionId: "a".repeat(40) }]
              }
            }]
          })
          yield* materializeNormalizedPluginPage({
            workspaceId,
            pluginConnectionId: pipelineId,
            providerId: "codepipeline",
            streamKey: PluginStreamKey.make(firstPartySyncStreamKey("codepipeline")),
            expectedRevision: 0,
            committedAt,
            successfulHealth: { _tag: "healthy", checkedAt: committedAt }
          }, pipelinePage)
          const settings = yield* persistence.workspaceSettings.get(workspaceId)
          const catalogue = yield* readReleaseTargetCatalog(persistence, workspaceId, settings.settings)
          const pipeline = catalogue.pipelines.find(({ pluginConnectionId }) => pluginConnectionId === pipelineId)
          if (pipeline?.topologyDigest === null || pipeline === undefined) {
            return assert.fail("Expected a current persisted pipeline definition")
          }
          const target = PipelineReleaseTarget.make({
            pluginConnectionId: pipelineId,
            pipelineName: "fixture-pipeline",
            topologyDigest: pipeline.topologyDigest,
            environments: [{
              key: "production",
              name: "Production",
              firstStage: "Deploy",
              lastStage: "Deploy",
              requiresManualGate: false
            }]
          })
          const configured = {
            ...settings.settings,
            pipeline: { ...settings.settings.pipeline, releaseTargets: [target] }
          }
          yield* reconcileReleaseTargets(persistence, workspaceId, configured, committedAt)
          const release = (yield* persistence.releases.list(workspaceId, 10))[0]
          if (release === undefined) return assert.fail("Expected Jira to materialize the fixture release")
          const slice = yield* persistence.deliveryGraph.read(workspaceId, {
            _tag: "releaseSlice",
            releaseId: release.release.id,
            environmentId: null,
            limit: 100
          })
          if (slice._tag !== "releaseSlice") return assert.fail("Expected a persisted release slice")
          assert.strictEqual(
            slice.value.relationships.find(({ kind }) => kind === "contains")?.lifecycle._tag,
            "verified"
          )
          assert.strictEqual(
            slice.value.relationships.find(({ kind }) => kind === "implements")?.lifecycle._tag,
            "verified"
          )
          assert.strictEqual(
            slice.value.relationships.find(({ kind }) => kind === "delivered-by")?.lifecycle._tag,
            "verified"
          )
          assert.lengthOf(release.release.targetEnvironmentIds, 1)
          const environmentId = yield* Schema.decodeUnknownEffect(EnvironmentId)(
            release.release.targetEnvironmentIds[0]
          )
          assert.equal(environmentId, yield* releaseEnvironmentId(workspaceId, "production"))
          yield* reconcileReleaseTargets(persistence, workspaceId, configured, committedAt)
          const repeated = yield* persistence.releases.get(workspaceId, release.release.id)
          assert.equal(
            repeated.revision,
            release.revision,
            "unchanged configuration must not append a release revision"
          )
        }).pipe(Effect.provideContext(yield* Layer.build(persistenceLayer)))
      }).pipe(Effect.scoped))
  })
})
