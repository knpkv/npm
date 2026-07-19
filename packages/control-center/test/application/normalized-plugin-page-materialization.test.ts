import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"

import { WorkspaceEntityInspection } from "../../src/api/deliveryGraph.js"
import {
  AgentId,
  EnvironmentId,
  PluginConnectionId,
  RoleAssignmentId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { NormalizedPluginEventV1, PluginCheckpointV1, PluginSyncPageV1 } from "../../src/domain/plugins/events.js"
import { Release } from "../../src/domain/release.js"
import { SourceRevision, VendorImmutableId } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeDeliveryGraphInspection } from "../../src/server/application/deliveryGraphInspection.js"
import {
  materializeNormalizedPluginPage,
  type NormalizedPluginPageMaterializationScope
} from "../../src/server/application/normalizedPluginPageMaterialization.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { PluginStreamKey } from "../../src/server/persistence/repositories/pluginRuntimeModels.js"
import { normalizeJiraIssueEvents } from "../../src/server/plugins/jira/JiraIssueNormalization.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000193")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000194")
const OTHER_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000195")
const ENVIRONMENT_ID = Schema.decodeSync(EnvironmentId)("01890f6f-6d6a-7cc0-98d2-000000000196")
const AGENT_ID = Schema.decodeSync(AgentId)("01890f6f-6d6a-7cc0-98d2-000000000197")
const ASSIGNMENT_ID = Schema.decodeSync(RoleAssignmentId)("01890f6f-6d6a-7cc0-98d2-000000000198")
const CACHE_STREAM = Schema.decodeSync(PluginStreamKey)("cache-only")
const MATERIALIZED_STREAM = Schema.decodeSync(PluginStreamKey)("delivery-items")
const T0 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:00:00.000Z")
const T1 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:01:00.000Z")
const T2 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:02:00.000Z")
const T3 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:03:00.000Z")

const descriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.jira",
  adapterVersion: { major: 1, minor: 0, patch: 0 },
  displayName: "Jira",
  configurationFields: [],
  capabilities: [{
    capabilityId: "sync.incremental",
    supportedVersions: [1],
    requirement: "required"
  }]
}

const cacheOnlyPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "cache-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "cache-only-issue-1",
    observedAt: "2026-07-19T09:00:30.000Z",
    revision: "cache-revision-1",
    entityType: "jira.issue",
    vendorImmutableId: "cache-issue-1",
    sourceUrl: null,
    title: "Cached but not materialized",
    attributes: { key: "CACHE-1", status: { name: "Open" } }
  }]
})

const materializedPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "materialized-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertPerson",
    eventId: "person-ada-1",
    observedAt: "2026-07-19T09:01:10.000Z",
    revision: "person-revision-1",
    vendorPersonId: "ada",
    displayName: "Ada Lovelace",
    avatarUrl: null,
    active: true
  }, {
    _tag: "UpsertEntity",
    eventId: "issue-pay-42-1",
    observedAt: "2026-07-19T09:01:20.000Z",
    revision: "issue-revision-1",
    entityType: "jira.issue",
    vendorImmutableId: "issue-42",
    sourceUrl: "https://jira.example/browse/PAY-42",
    title: "PAY-42 · Ship guarded refunds",
    attributes: { key: "PAY-42", status: { name: "Ready" }, priority: { name: "High" } }
  }, {
    _tag: "UpsertEntity",
    eventId: "pull-request-17-1",
    observedAt: "2026-07-19T09:01:30.000Z",
    revision: "pull-request-revision-1",
    entityType: "pull-request",
    vendorImmutableId: "17",
    sourceUrl: "https://console.aws.example/pull-requests/17",
    title: "Guard refund writes",
    attributes: {
      repository: "payments-api",
      sourceBranch: "feat/guard-refunds",
      targetBranch: "main",
      headRevision: "abc123",
      reviewState: "requested"
    }
  }, {
    _tag: "AppendEvidence",
    eventId: "evidence-review-1",
    observedAt: "2026-07-19T09:01:40.000Z",
    revision: "evidence-revision-1",
    evidenceId: "review-ready",
    subject: { entityType: "pull-request", vendorImmutableId: "17" },
    evidenceType: "status-observed",
    summary: "Review requested",
    capturedAt: "2026-07-19T09:01:40.000Z",
    data: {
      predicate: "status-observed",
      value: { _tag: "state", value: "review-requested" }
    }
  }, {
    _tag: "ProposeRelationship",
    eventId: "relationship-pr-implements-issue-1",
    observedAt: "2026-07-19T09:01:50.000Z",
    revision: "relationship-revision-1",
    relationshipId: "pr-17-implements-issue-42",
    from: { entityType: "pull-request", vendorImmutableId: "17" },
    to: { entityType: "jira.issue", vendorImmutableId: "issue-42" },
    relationshipType: "implements",
    confidence: 0.9,
    evidenceIds: ["review-ready"]
  }]
})

const richIssueAttributes = {
  key: "PAY-42",
  status: "In Review",
  priority: "High",
  estimatePoints: 5,
  summary: "Protect payment retries",
  description: "Persist retry state.\n\n## Acceptance Criteria\n\n- Restart-safe\n- Timeout-safe",
  acceptanceCriteria: "- Restart-safe\n- Timeout-safe",
  environment: "Production and staging",
  issueType: { sourceId: "10001", name: "Story" },
  project: { sourceId: "10", key: "PAY", name: "Payments" },
  resolution: null,
  labels: ["payments", "release-candidate"],
  components: [{ sourceId: "7", name: "Checkout" }],
  fixVersions: [{ sourceId: "2026.29", name: "2026.29", released: false, releaseDate: null }],
  createdAt: "2026-07-15T08:00:00.000Z",
  updatedAt: "2026-07-17T09:30:00.000Z",
  dueDate: "2026-07-21",
  resolvedAt: null,
  parent: {
    sourceId: "10000",
    key: "PAY-1",
    summary: "Payments hardening",
    status: { sourceId: "3", name: "In Progress" }
  },
  subtasks: [
    {
      sourceId: "10043",
      key: "PAY-43",
      summary: "Cover timeout path",
      status: { sourceId: "1", name: "Open" }
    }
  ],
  assigneeSourcePersonId: "ari",
  reporterSourcePersonId: "sam",
  creatorSourcePersonId: "sam",
  collaborators: [
    {
      sourcePersonId: "ari",
      displayName: "Ari Chen",
      avatarUrl: "https://avatar.example/ari.png",
      active: true,
      roles: ["assignee", "commenter"]
    },
    {
      sourcePersonId: "sam",
      displayName: "Sam Rivera",
      avatarUrl: null,
      active: true,
      roles: ["change-author", "creator", "reporter"]
    }
  ],
  comments: [
    {
      sourceId: "c1",
      authorSourcePersonId: "ari",
      updateAuthorSourcePersonId: null,
      body: "Ready for review.",
      createdAt: "2026-07-16T10:00:00.000Z",
      updatedAt: "2026-07-16T10:00:00.000Z"
    }
  ],
  commentTotal: 2,
  commentsTruncated: true,
  history: [
    {
      sourceId: "h1",
      authorSourcePersonId: "sam",
      createdAt: "2026-07-16T09:00:00.000Z",
      changes: [{ field: "status", from: "In Progress", to: "In Review" }]
    }
  ],
  historyTotal: 1,
  historyTruncated: false,
  truncatedFields: ["comments"]
}

const richIssuePage = (revision: 1 | 2) =>
  Schema.decodeSync(PluginSyncPageV1)({
    checkpointAfterPage: `rich-issue-${revision}`,
    hasMore: false,
    events: [
      {
        _tag: "UpsertEntity",
        eventId: `rich-issue-pay-42-${revision}`,
        observedAt: revision === 1 ? "2026-07-19T09:01:20.000Z" : "2026-07-19T09:02:20.000Z",
        revision: `issue-revision-${revision}`,
        entityType: "jira.issue",
        vendorImmutableId: "rich-issue-42",
        sourceUrl: "https://jira.example/browse/PAY-42",
        title: revision === 1 ? "PAY-42 · Protect payment retries" : "PAY-42 · Payment retries protected",
        attributes: revision === 1
          ? richIssueAttributes
          : {
            ...richIssueAttributes,
            status: "Done",
            summary: "Payment retries protected",
            description: "Retry state is durable in production.",
            acceptanceCriteria: "- Restart-safe\n- Timeout-safe\n- Verified in production",
            resolution: { sourceId: "10000", name: "Done" },
            updatedAt: "2026-07-19T09:02:00.000Z",
            resolvedAt: "2026-07-19T09:02:00.000Z",
            comments: [
              {
                sourceId: "c2",
                authorSourcePersonId: "sam",
                updateAuthorSourcePersonId: "sam",
                body: "Verified in production.",
                createdAt: "2026-07-19T09:01:00.000Z",
                updatedAt: "2026-07-19T09:01:30.000Z"
              }
            ],
            commentTotal: 2,
            commentsTruncated: false,
            truncatedFields: []
          }
      }
    ]
  })

const tombstonePage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "tombstone-complete",
  hasMore: false,
  events: [{
    _tag: "TombstoneEntity",
    eventId: "issue-pay-42-deleted",
    observedAt: "2026-07-19T09:02:30.000Z",
    revision: "issue-revision-2",
    entityType: "jira.issue",
    vendorImmutableId: "issue-42",
    reason: "Deleted upstream"
  }]
})

const repeatedEntityEventPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "event-replay-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "issue-pay-42-1",
    observedAt: "2026-07-19T09:01:20.000Z",
    revision: "issue-revision-1",
    entityType: "jira.issue",
    vendorImmutableId: "issue-42",
    sourceUrl: "https://jira.example/browse/PAY-42",
    title: "PAY-42 · Ship guarded refunds",
    attributes: { key: "PAY-42", status: { name: "Ready" }, priority: { name: "High" } }
  }]
})

const jiraReleasePage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "jira-release-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "jira-version-2026-29-candidate",
    observedAt: "2026-07-19T09:01:30.000Z",
    revision: "candidate:2026-07-29:2026.29",
    entityType: "release",
    vendorImmutableId: "jira-version:2026.29",
    sourceUrl: "https://jira.example/plugins/servlet/project-config/PAY/versions",
    title: "Payments · 2026.29",
    attributes: {
      source: "jira-fix-version",
      serviceName: "Payments",
      version: "2026.29",
      lifecycle: "candidate"
    }
  }]
})

const jiraReleaseUpdatePage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "jira-release-updated",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "jira-version-2026-29-released",
    observedAt: "2026-07-19T09:02:30.000Z",
    revision: "released:2026-07-29:2026.29",
    entityType: "release",
    vendorImmutableId: "jira-version:2026.29",
    sourceUrl: "https://jira.example/plugins/servlet/project-config/PAY/versions",
    title: "Payments API · 2026.29",
    attributes: {
      source: "jira-fix-version",
      serviceName: "Payments API",
      version: "2026.29",
      lifecycle: "released"
    }
  }]
})

const jiraReleaseRepeatedObservationPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "jira-release-observed-again",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "jira-version-2026-29-candidate-observed-again",
    observedAt: "2026-07-19T09:02:30.000Z",
    revision: "candidate:2026-07-29:2026.29",
    entityType: "release",
    vendorImmutableId: "jira-version:2026.29",
    sourceUrl: "https://jira.example/plugins/servlet/project-config/PAY/versions",
    title: "Payments · 2026.29",
    attributes: {
      source: "jira-fix-version",
      serviceName: "Payments",
      version: "2026.29",
      lifecycle: "candidate"
    }
  }]
})

const invalidRelationshipPage = Schema.decodeSync(PluginSyncPageV1)({
  checkpointAfterPage: "invalid-relationship-complete",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "rollback-issue-1",
    observedAt: "2026-07-19T09:01:20.000Z",
    revision: "rollback-revision-1",
    entityType: "jira.issue",
    vendorImmutableId: "rollback-issue",
    sourceUrl: null,
    title: "Must roll back",
    attributes: { key: "ROLLBACK-1", status: { name: "Open" } }
  }, {
    _tag: "ProposeRelationship",
    eventId: "rollback-invalid-relationship-1",
    observedAt: "2026-07-19T09:01:30.000Z",
    revision: "rollback-relationship-revision-1",
    relationshipId: "rollback-invalid-relationship",
    from: { entityType: "jira.issue", vendorImmutableId: "rollback-issue" },
    to: { entityType: "jira.issue", vendorImmutableId: "rollback-issue" },
    relationshipType: "not-a-canonical-relationship",
    confidence: 0.5,
    evidenceIds: []
  }]
})

const withMaterializer = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Crypto.Crypto | Database | Persistence>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-normalized-materialization-")
    const database = databaseLayer(config)
    const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provideMerge(database))
    return yield* use.pipe(Effect.provide(persistence))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const setup = Effect.gen(function*() {
  const persistence = yield* Persistence
  yield* persistence.workspaces.create(WORKSPACE_ID, {
    displayName: WorkspaceName.make("Payments"),
    createdAt: T0
  })
  yield* persistence.pluginConnections.create(WORKSPACE_ID, {
    pluginConnectionId: PLUGIN_ID,
    providerId: "jira",
    displayName: PluginConnectionDisplayName.make("Payments Jira"),
    isEnabled: true,
    createdAt: T0
  })
  yield* persistence.pluginRuntime.acceptPluginDescriptor(
    WORKSPACE_ID,
    PLUGIN_ID,
    "jira",
    descriptor,
    0,
    T0
  )
})

const items = Effect.fn("NormalizedPluginPageMaterializationTest.items")(function*() {
  const persistence = yield* Persistence
  const result = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
    _tag: "workspaceEntityProjections",
    owner: null,
    query: null,
    service: null,
    status: null,
    type: null,
    limit: 100
  })
  if (result._tag !== "workspaceEntityProjections") return yield* Effect.die("expected Items projection")
  return result.value
})

describe("normalized plugin page materialization", () => {
  it.effect("retains complete bounded Jira detail across two inspection revisions", () =>
    withMaterializer(
      Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* setup
        const scope: NormalizedPluginPageMaterializationScope = {
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          streamKey: MATERIALIZED_STREAM,
          expectedRevision: 0,
          committedAt: T2,
          successfulHealth: { _tag: "healthy", checkedAt: T2 }
        }

        yield* materializeNormalizedPluginPage(scope, richIssuePage(1))
        const firstIndex = yield* items()
        const entityId = firstIndex.items[0]?.projection.entityId
        if (entityId === undefined) return yield* Effect.die("expected rich Jira entity")

        yield* materializeNormalizedPluginPage(
          {
            ...scope,
            expectedRevision: 1,
            committedAt: T3,
            successfulHealth: { _tag: "healthy", checkedAt: T3 }
          },
          richIssuePage(2)
        )

        const first = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
          _tag: "entityProjection",
          entityId,
          revision: 1
        })
        if (first._tag !== "entityProjection") return yield* Effect.die("expected first projection revision")
        assert.strictEqual(first.value.projection.details._tag, "issue")
        if (first.value.projection.details._tag !== "issue") return yield* Effect.die("expected issue detail")
        assert.strictEqual(first.value.projection.details.description, richIssueAttributes.description)
        assert.strictEqual(first.value.projection.details.acceptanceCriteria, richIssueAttributes.acceptanceCriteria)
        assert.strictEqual(first.value.projection.details.comments?.[0]?.sourceId, "c1")
        assert.strictEqual(first.value.projection.details.history?.[0]?.changes[0]?.to, "In Review")
        assert.strictEqual(first.value.projection.details.fixVersions?.[0]?.name, "2026.29")
        assert.deepStrictEqual(first.value.projection.details.truncatedFields, ["comments"])

        const inspectionService = yield* makeDeliveryGraphInspection
        const inspection = yield* inspectionService.workspaceEntity({ workspaceId: WORKSPACE_ID, entityId })
        assert.strictEqual(inspection.entity.projection.projectionRevision, 2)
        assert.strictEqual(inspection.entity.projection.sourceEntityRevision, 2)
        assert.strictEqual(inspection.entity.projection.details._tag, "issue")
        if (inspection.entity.projection.details._tag !== "issue") return yield* Effect.die("expected issue detail")
        const details = inspection.entity.projection.details
        assert.strictEqual(details.status, "Done")
        assert.strictEqual(details.description, "Retry state is durable in production.")
        assert.strictEqual(details.acceptanceCriteria, "- Restart-safe\n- Timeout-safe\n- Verified in production")
        assert.strictEqual(details.comments?.[0]?.sourceId, "c2")
        assert.strictEqual(details.comments?.[0]?.updateAuthorSourcePersonId, "sam")
        assert.strictEqual(details.history?.[0]?.sourceId, "h1")
        assert.strictEqual(details.collaborators?.[0]?.sourcePersonId, "ari")
        assert.strictEqual(details.collaborators?.[0]?.avatarUrl, "https://avatar.example/ari.png")
        assert.strictEqual(details.fixVersions?.[0]?.sourceId, "2026.29")
        assert.isFalse(details.commentsTruncated)
        assert.deepStrictEqual(details.truncatedFields, [])
        assert.isTrue(inspection.isSourceCurrent)
      })
    ))

  it.effect("produces presentation-ready inspection from a provider-normalized Jira issue", () =>
    withMaterializer(
      Effect.gen(function*() {
        yield* setup
        const events = yield* normalizeJiraIssueEvents({
          issue: {
            id: "10042",
            key: "PAY-42",
            fields: {
              summary: "Protect payment retries",
              updated: "2026-07-19T09:01:00.000Z",
              description: {
                type: "doc",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "Persist retry state." }] },
                  {
                    type: "heading",
                    attrs: { level: 2 },
                    content: [{ type: "text", text: "Acceptance Criteria" }]
                  },
                  {
                    type: "bulletList",
                    content: [{
                      type: "listItem",
                      content: [{
                        type: "paragraph",
                        content: [{ type: "text", text: "Retry survives restart." }]
                      }]
                    }]
                  }
                ]
              },
              environment: "Payments production",
              status: { id: "3", name: "In Review" },
              assignee: {
                accountId: "ari",
                displayName: "Ari Chen",
                avatarUrls: { "48x48": "https://avatar.example/ari.png" },
                active: true
              }
            }
          },
          comments: {
            values: [{
              id: "c1",
              author: { accountId: "ari", displayName: "Ari Chen", active: true },
              body: "Ready for review.",
              created: "2026-07-18T10:00:00.000Z",
              updated: "2026-07-18T10:00:00.000Z"
            }],
            total: 1,
            truncated: false
          },
          changelogs: {
            values: [],
            total: 0,
            truncated: false
          },
          observedAt: T1,
          webBaseUrl: new URL("https://jira.example/")
        })
        const page = Schema.decodeSync(PluginSyncPageV1)({
          checkpointAfterPage: "provider-normalized-issue",
          hasMore: false,
          events: events.map((event) => Schema.encodeSync(NormalizedPluginEventV1)(event))
        })
        yield* materializeNormalizedPluginPage(
          {
            workspaceId: WORKSPACE_ID,
            pluginConnectionId: PLUGIN_ID,
            providerId: "jira",
            streamKey: MATERIALIZED_STREAM,
            expectedRevision: 0,
            committedAt: T2,
            successfulHealth: { _tag: "healthy", checkedAt: T2 }
          },
          page
        )

        const index = yield* items()
        const entityId = index.items[0]?.projection.entityId
        if (entityId === undefined) return yield* Effect.die("expected normalized Jira issue")
        const inspectionService = yield* makeDeliveryGraphInspection
        const inspection = yield* inspectionService.workspaceEntity({ workspaceId: WORKSPACE_ID, entityId })
        const presentationInput = Schema.encodeSync(WorkspaceEntityInspection)(inspection)
        assert.strictEqual(presentationInput.entity.projection.displayKey, "PAY-42")
        assert.strictEqual(presentationInput.entity.projection.title, "PAY-42 · Protect payment retries")
        assert.strictEqual(presentationInput.source.sourceUrl, "https://jira.example/browse/PAY-42")
        const details = presentationInput.entity.projection.details
        if (details._tag !== "issue") return yield* Effect.die("expected presentation-ready Jira issue details")
        assert.strictEqual(
          details.description,
          "Persist retry state.\n\n## Acceptance Criteria\n\n- Retry survives restart."
        )
        assert.strictEqual(details.acceptanceCriteria, "- Retry survives restart.")
        assert.strictEqual(details.environment, "Payments production")
        assert.strictEqual(details.collaborators?.[0]?.displayName, "Ari Chen")
        assert.strictEqual(details.comments?.[0]?.body, "Ready for review.")
      })
    ))

  it.effect("projects a normalized Jira fix version into the canonical release repository", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }

      const receipt = yield* materializeNormalizedPluginPage(scope, jiraReleasePage)
      assert.strictEqual(receipt.acceptedEventCount, 1)
      assert.strictEqual(receipt.entityProjectionCount, 0)
      assert.strictEqual(receipt.nodeCount, 1)
      assert.strictEqual((yield* items()).totalCount, 0)

      const releases = yield* persistence.releases.list(WORKSPACE_ID, 10)
      assert.lengthOf(releases, 1)
      const initial = releases[0]
      if (initial === undefined) return yield* Effect.die("expected materialized release")
      assert.strictEqual(initial.release.serviceName, "Payments")
      assert.strictEqual(initial.release.version, "2026.29")
      assert.strictEqual(initial.release.lifecycle, "candidate")
      assert.deepStrictEqual(initial.release.roleAssignments, [])
      assert.deepStrictEqual(initial.release.targetEnvironmentIds, [])
      assert.strictEqual(initial.release.sourceRevisions[0]?.vendorImmutableId, "jira-version:2026.29")

      const replay = yield* materializeNormalizedPluginPage(scope, jiraReleasePage)
      assert.isFalse(replay.pageCommitted)
      assert.lengthOf(yield* persistence.releases.list(WORKSPACE_ID, 10), 1)

      const nonJiraSource = Schema.decodeSync(SourceRevision)({
        pluginConnectionId: OTHER_PLUGIN_ID,
        providerId: "confluence",
        vendorImmutableId: "release-page-2026-29",
        revision: "page-revision-7",
        sourceUrl: "https://wiki.example/releases/2026.29",
        firstObservedAt: "2026-07-19T09:01:00.000Z",
        lastObservedAt: "2026-07-19T09:01:00.000Z",
        synchronizedAt: "2026-07-19T09:02:00.000Z",
        normalizationSchemaVersion: 1
      })
      const enriched = Schema.decodeSync(Schema.toType(Release))({
        ...initial.release,
        roleAssignments: [{
          assignmentId: ASSIGNMENT_ID,
          actor: { _tag: "agent", agentId: AGENT_ID },
          role: "release-owner",
          scope: { _tag: "release", workspaceId: WORKSPACE_ID, releaseId: initial.release.id },
          lifecycle: { _tag: "active", assignedAt: T2 }
        }],
        sourceRevisions: [...initial.release.sourceRevisions, nonJiraSource],
        targetEnvironmentIds: [ENVIRONMENT_ID],
        updatedAt: T2
      })
      yield* persistence.releases.append(WORKSPACE_ID, enriched, initial.revision)

      yield* materializeNormalizedPluginPage({
        ...scope,
        expectedRevision: 1,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }, jiraReleaseUpdatePage)
      const updated = yield* persistence.releases.get(WORKSPACE_ID, initial.release.id)
      assert.strictEqual(updated.release.serviceName, "Payments API")
      assert.strictEqual(updated.release.lifecycle, "released")
      assert.deepStrictEqual(updated.release.roleAssignments, enriched.roleAssignments)
      assert.deepStrictEqual(updated.release.targetEnvironmentIds, [ENVIRONMENT_ID])
      assert.deepStrictEqual(
        updated.release.sourceRevisions.filter(({ providerId }) => providerId !== "jira"),
        [nonJiraSource]
      )
      assert.strictEqual(
        updated.release.sourceRevisions.find(({ providerId }) => providerId === "jira")?.revision,
        "released:2026-07-29:2026.29"
      )
    })))

  it.effect("refreshes a repeated Jira release observation while exact page replay stays a no-op", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const initialScope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }

      yield* materializeNormalizedPluginPage(initialScope, jiraReleasePage)
      const initial = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]
      if (initial === undefined) return yield* Effect.die("expected materialized release")

      const repeatedScope: NormalizedPluginPageMaterializationScope = {
        ...initialScope,
        expectedRevision: 1,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }
      const repeated = yield* materializeNormalizedPluginPage(
        repeatedScope,
        jiraReleaseRepeatedObservationPage
      )
      assert.isTrue(repeated.pageCommitted)
      assert.strictEqual(repeated.acceptedEventCount, 1)

      const refreshed = yield* persistence.releases.get(WORKSPACE_ID, initial.release.id)
      assert.strictEqual(refreshed.revision, initial.revision + 1)
      const jiraSource = refreshed.release.sourceRevisions.find(({ providerId }) => providerId === "jira")
      if (jiraSource === undefined) return yield* Effect.die("expected Jira release source")
      assert.strictEqual(jiraSource.revision, "candidate:2026-07-29:2026.29")
      assert.strictEqual(DateTime.formatIso(jiraSource.firstObservedAt), "2026-07-19T09:01:30.000Z")
      assert.strictEqual(DateTime.formatIso(jiraSource.lastObservedAt), "2026-07-19T09:02:30.000Z")
      assert.strictEqual(DateTime.formatIso(jiraSource.synchronizedAt), "2026-07-19T09:03:00.000Z")
      assert.strictEqual(refreshed.release.freshness._tag, "current")
      if (refreshed.release.freshness._tag !== "current") {
        return yield* Effect.die("expected current release freshness")
      }
      assert.strictEqual(
        DateTime.formatIso(refreshed.release.freshness.sourceObservedAt),
        "2026-07-19T09:02:30.000Z"
      )
      assert.strictEqual(
        DateTime.formatIso(refreshed.release.freshness.synchronizedAt),
        "2026-07-19T09:03:00.000Z"
      )

      const replay = yield* materializeNormalizedPluginPage(
        repeatedScope,
        jiraReleaseRepeatedObservationPage
      )
      assert.isFalse(replay.pageCommitted)
      assert.strictEqual(replay.acceptedEventCount, 0)
      assert.strictEqual(
        (yield* persistence.releases.get(WORKSPACE_ID, initial.release.id)).revision,
        refreshed.revision
      )
    })))

  it.effect("materializes Jira fix versions into the release workset only for linked issues", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const common = {
        comments: { values: [], total: 0, truncated: false },
        changelogs: { values: [], total: 0, truncated: false },
        observedAt: T1,
        webBaseUrl: new URL("https://jira.example")
      }
      const linkedEvents = yield* normalizeJiraIssueEvents({
        ...common,
        issue: {
          id: "10042",
          key: "PAY-42",
          fields: {
            summary: "Ship guarded refunds",
            updated: "2026-07-19T09:01:00.000Z",
            project: { id: "10000", key: "PAY", name: "Payments" },
            fixVersions: [{ id: "2026.29", name: "2026.29", released: false }]
          }
        }
      })
      const unlinkedEvents = yield* normalizeJiraIssueEvents({
        ...common,
        issue: {
          id: "10043",
          key: "PAY-43",
          fields: {
            summary: "Keep investigating retries",
            updated: "2026-07-19T09:01:00.000Z",
            project: { id: "10000", key: "PAY", name: "Payments" }
          }
        }
      })
      const page = Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
        checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)("jira-fix-version-workset"),
        hasMore: false,
        events: [...linkedEvents, ...unlinkedEvents]
      })

      const receipt = yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }, page)
      assert.strictEqual(receipt.relationshipCount, 1)
      assert.strictEqual((yield* items()).totalCount, 2)

      const releases = yield* persistence.releases.list(WORKSPACE_ID, 10)
      const release = releases[0]
      if (release === undefined) return yield* Effect.die("expected fix-version release")
      const result = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: release.release.id,
        environmentId: null,
        limit: 100
      })
      if (result._tag !== "releaseSlice") return yield* Effect.die("expected release slice")
      assert.deepStrictEqual(
        result.value.entityProjections.map(({ projection }) => projection.displayKey),
        ["PAY-42"]
      )
      assert.lengthOf(result.value.relationships, 1)
      assert.strictEqual(result.value.relationships[0]?.kind, "contains")
      assert.deepStrictEqual(result.value.relationships[0]?.scope, {
        _tag: "release",
        releaseId: release.release.id
      })
    })))

  it.effect("reconciles one Jira issue without decoding unrelated stream cache entries", () =>
    withMaterializer(Effect.gen(function*() {
      const database = yield* Database
      const persistence = yield* Persistence
      yield* setup
      const unrelatedPage = Schema.decodeSync(PluginSyncPageV1)({
        checkpointAfterPage: "jira-unrelated-cache",
        hasMore: false,
        events: [{
          _tag: "UpsertEntity",
          eventId: "jira-unrelated-cache-event",
          observedAt: DateTime.formatIso(T1),
          revision: "unrelated-revision",
          entityType: "jira.issue",
          vendorImmutableId: "unrelated-issue",
          sourceUrl: null,
          title: "Unrelated cached issue",
          attributes: { key: "OTHER-1", fixVersions: [], truncatedFields: [] }
        }]
      })
      yield* persistence.pluginRuntime.commitNormalizedPage(
        WORKSPACE_ID,
        PLUGIN_ID,
        "jira",
        MATERIALIZED_STREAM,
        0,
        unrelatedPage,
        T1,
        { _tag: "healthy", checkedAt: T1 }
      )
      yield* database.sql`UPDATE plugin_cache_entries SET payload_json = '{}'
        WHERE workspace_id = ${WORKSPACE_ID}
          AND plugin_connection_id = ${PLUGIN_ID}
          AND stream_key = ${MATERIALIZED_STREAM}`

      const events = yield* normalizeJiraIssueEvents({
        comments: { values: [], total: 0, truncated: false },
        changelogs: { values: [], total: 0, truncated: false },
        observedAt: T2,
        webBaseUrl: new URL("https://jira.example"),
        issue: {
          id: "10042",
          key: "PAY-42",
          fields: {
            summary: "Reconcile only this issue",
            updated: DateTime.formatIso(T2),
            project: { id: "10000", key: "PAY", name: "Payments" },
            fixVersions: []
          }
        }
      })
      const receipt = yield* materializeNormalizedPluginPage(
        {
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          streamKey: MATERIALIZED_STREAM,
          expectedRevision: 1,
          committedAt: T2,
          successfulHealth: { _tag: "healthy", checkedAt: T2 }
        },
        Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
          checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)("jira-targeted-reconciliation"),
          hasMore: false,
          events
        })
      )

      assert.isTrue(receipt.pageCommitted)
      assert.deepStrictEqual((yield* items()).items.map(({ projection }) => projection.displayKey), ["PAY-42"])
    })))

  it.effect("retires a Jira release containment when an issue moves to another fix version", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const normalizeIssue = (input: {
        readonly id: string
        readonly key: string
        readonly summary: string
        readonly updated: string
        readonly versionId: string
      }) =>
        normalizeJiraIssueEvents({
          comments: { values: [], total: 0, truncated: false },
          changelogs: { values: [], total: 0, truncated: false },
          observedAt: input.updated === "2026-07-19T09:01:00.000Z" ? T1 : T2,
          webBaseUrl: new URL("https://jira.example"),
          issue: {
            id: input.id,
            key: input.key,
            fields: {
              summary: input.summary,
              updated: input.updated,
              project: { id: "10000", key: "PAY", name: "Payments" },
              fixVersions: [{ id: input.versionId, name: input.versionId, released: false }]
            }
          }
        })
      const issueA = yield* normalizeIssue({
        id: "10042",
        key: "PAY-42",
        summary: "Ship guarded refunds",
        updated: "2026-07-19T09:01:00.000Z",
        versionId: "2026.29"
      })
      const issueB = yield* normalizeIssue({
        id: "10043",
        key: "PAY-43",
        summary: "Ship retry telemetry",
        updated: "2026-07-19T09:01:00.000Z",
        versionId: "2026.29"
      })
      const initialPage = Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
        checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)("jira-fix-version-initial-membership"),
        hasMore: false,
        events: [...issueA, ...issueB]
      })
      const initialScope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }
      yield* materializeNormalizedPluginPage(initialScope, initialPage)

      const initialReleases = yield* persistence.releases.list(WORKSPACE_ID, 10)
      const oldRelease = initialReleases.find(({ release }) => release.version === "2026.29")
      if (oldRelease === undefined) return yield* Effect.die("expected original Jira release")
      const initialSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: oldRelease.release.id,
        environmentId: null,
        limit: 100
      })
      if (initialSlice._tag !== "releaseSlice") return yield* Effect.die("expected initial release slice")
      assert.deepStrictEqual(
        initialSlice.value.entityProjections.map(({ projection }) => projection.displayKey).sort(),
        ["PAY-42", "PAY-43"]
      )
      const issueBProjection = initialSlice.value.entityProjections.find(
        ({ projection }) => projection.displayKey === "PAY-43"
      )
      if (issueBProjection === undefined) return yield* Effect.die("expected PAY-43 projection")
      const issueBNode = initialSlice.value.nodes.find((node) =>
        node.resolution._tag === "resolved" &&
        node.resolution.target._tag === "entity" &&
        node.resolution.target.entityId === issueBProjection.projection.entityId
      )
      if (issueBNode === undefined) return yield* Effect.die("expected PAY-43 delivery node")
      const oldContainment = initialSlice.value.relationships.find(
        ({ targetNodeId }) => targetNodeId === issueBNode.nodeId
      )
      if (oldContainment === undefined) return yield* Effect.die("expected PAY-43 release containment")

      const movedIssueB = yield* normalizeIssue({
        id: "10043",
        key: "PAY-43",
        summary: "Ship retry telemetry",
        updated: "2026-07-19T09:02:00.000Z",
        versionId: "2026.30"
      })
      const movedPage = Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
        checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)("jira-fix-version-moved-membership"),
        hasMore: false,
        events: movedIssueB
      })
      yield* materializeNormalizedPluginPage({
        ...initialScope,
        expectedRevision: 1,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }, movedPage)

      const oldSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: oldRelease.release.id,
        environmentId: null,
        limit: 100
      })
      if (oldSlice._tag !== "releaseSlice") return yield* Effect.die("expected updated old release slice")
      assert.deepStrictEqual(
        oldSlice.value.entityProjections.map(({ projection }) => projection.displayKey),
        ["PAY-42"]
      )
      assert.lengthOf(oldSlice.value.relationships, 1)
      const history = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationshipHistory",
        relationshipId: oldContainment.relationshipId,
        limit: 10
      })
      if (history._tag !== "relationshipHistory") return yield* Effect.die("expected containment history")
      assert.lengthOf(history.value, 2)
      assert.strictEqual(history.value[0]?.lifecycle._tag, "superseded")

      const newRelease = (yield* persistence.releases.list(WORKSPACE_ID, 10))
        .find(({ release }) => release.version === "2026.30")
      if (newRelease === undefined) return yield* Effect.die("expected destination Jira release")
      const newSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: newRelease.release.id,
        environmentId: null,
        limit: 100
      })
      if (newSlice._tag !== "releaseSlice") return yield* Effect.die("expected destination release slice")
      assert.deepStrictEqual(
        newSlice.value.entityProjections.map(({ projection }) => projection.displayKey),
        ["PAY-43"]
      )
    })))

  it.effect("preserves capped Jira memberships until a complete fix-version snapshot removes them", () =>
    withMaterializer(Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* setup
      const version = (id: string) => ({ id, name: id, released: false })
      const normalize = (updated: string, fixVersions: ReadonlyArray<ReturnType<typeof version>>) =>
        normalizeJiraIssueEvents({
          comments: { values: [], total: 0, truncated: false },
          changelogs: { values: [], total: 0, truncated: false },
          observedAt: Schema.decodeSync(UtcTimestamp)(updated),
          webBaseUrl: new URL("https://jira.example"),
          issue: {
            id: "10099",
            key: "PAY-99",
            fields: {
              summary: "Keep every Jira release membership",
              updated,
              project: { id: "10000", key: "PAY", name: "Payments" },
              fixVersions
            }
          }
        })
      const page = (checkpoint: string, events: ReadonlyArray<NormalizedPluginEventV1>) =>
        Schema.decodeSync(Schema.toType(PluginSyncPageV1))({
          checkpointAfterPage: Schema.decodeSync(PluginCheckpointV1)(checkpoint),
          hasMore: false,
          events
        })
      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T1,
        successfulHealth: { _tag: "healthy", checkedAt: T1 }
      }

      yield* materializeNormalizedPluginPage(
        scope,
        page("jira-fix-version-cap-initial", yield* normalize(DateTime.formatIso(T1), [version("protected")]))
      )
      const protectedRelease = (yield* persistence.releases.list(WORKSPACE_ID, 10))[0]
      if (protectedRelease === undefined) return yield* Effect.die("expected protected Jira release")
      const initialSlice = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "releaseSlice",
        releaseId: protectedRelease.release.id,
        environmentId: null,
        limit: 10
      })
      if (initialSlice._tag !== "releaseSlice") return yield* Effect.die("expected protected release slice")
      const protectedRelationship = initialSlice.value.relationships[0]
      if (protectedRelationship === undefined) return yield* Effect.die("expected protected membership")

      const retainedVersions = [
        ...Array.from({ length: 99 }, (_, index) => version(`candidate-${String(index)}`)),
        version("protected")
      ]
      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 1, committedAt: T2, successfulHealth: { _tag: "healthy", checkedAt: T2 } },
        page("jira-fix-version-cap-bounded", yield* normalize(DateTime.formatIso(T2), retainedVersions))
      )
      const retainedHistory = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationshipHistory",
        relationshipId: protectedRelationship.relationshipId,
        limit: 10
      })
      if (retainedHistory._tag !== "relationshipHistory") return yield* Effect.die("expected retained history")
      assert.lengthOf(retainedHistory.value, 1)
      assert.strictEqual(retainedHistory.value[0]?.lifecycle._tag, "proposed")

      yield* materializeNormalizedPluginPage(
        { ...scope, expectedRevision: 2, committedAt: T3, successfulHealth: { _tag: "healthy", checkedAt: T3 } },
        page("jira-fix-version-cap-complete", yield* normalize(DateTime.formatIso(T3), retainedVersions.slice(0, 99)))
      )
      const removedHistory = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "relationshipHistory",
        relationshipId: protectedRelationship.relationshipId,
        limit: 10
      })
      if (removedHistory._tag !== "relationshipHistory") return yield* Effect.die("expected removed history")
      assert.lengthOf(removedHistory.value, 2)
      assert.strictEqual(removedHistory.value[0]?.lifecycle._tag, "superseded")
    })))

  it.effect("atomically applies all five operations and makes replay a canonical no-op", () =>
    withMaterializer(Effect.gen(function*() {
      const database = yield* Database
      const persistence = yield* Persistence
      yield* setup

      yield* persistence.pluginRuntime.commitNormalizedPage(
        WORKSPACE_ID,
        PLUGIN_ID,
        "jira",
        CACHE_STREAM,
        0,
        cacheOnlyPage,
        T1,
        { _tag: "healthy", checkedAt: T1 }
      )
      const cacheOnlyItems = yield* items()
      assert.strictEqual(cacheOnlyItems.totalCount, 0)

      const scope: NormalizedPluginPageMaterializationScope = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }
      const first = yield* materializeNormalizedPluginPage(scope, materializedPage)
      assert.deepStrictEqual(first, {
        pageCommitted: true,
        acceptedEventCount: 5,
        entityProjectionCount: 2,
        evidenceClaimCount: 1,
        evidenceItemCount: 1,
        nodeCount: 2,
        personCount: 1,
        relationshipCount: 1,
        skippedEntityCount: 0
      })
      const currentItems = yield* items()
      assert.strictEqual(currentItems.totalCount, 2)
      assert.deepStrictEqual(
        currentItems.items.map(({ projection }) => [projection.entityType, projection.displayKey]),
        [["pull-request", "17"], ["issue", "PAY-42"]]
      )
      assert.strictEqual(
        (yield* persistence.people.findPersonBySourceIdentity(WORKSPACE_ID, {
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          vendorPersonId: VendorImmutableId.make("ada")
        })).person.displayName,
        "Ada Lovelace"
      )

      const eventReplay = yield* materializeNormalizedPluginPage({
        ...scope,
        expectedRevision: 1
      }, repeatedEntityEventPage)
      assert.deepStrictEqual(eventReplay, {
        pageCommitted: true,
        acceptedEventCount: 0,
        entityProjectionCount: 0,
        evidenceClaimCount: 0,
        evidenceItemCount: 0,
        nodeCount: 0,
        personCount: 0,
        relationshipCount: 0,
        skippedEntityCount: 0
      })

      const deletedScope: NormalizedPluginPageMaterializationScope = {
        ...scope,
        expectedRevision: 2,
        committedAt: T3,
        successfulHealth: { _tag: "healthy", checkedAt: T3 }
      }
      const deleted = yield* materializeNormalizedPluginPage(deletedScope, tombstonePage)
      assert.strictEqual(deleted.entityProjectionCount, 1)
      const remainingItems = yield* items()
      assert.strictEqual(remainingItems.totalCount, 1)

      const beforeReplay = yield* database.sql<Record<string, unknown>>`SELECT
        (SELECT COUNT(*) FROM entities) AS entities,
        (SELECT COUNT(*) FROM entity_projection_revisions) AS projections,
        (SELECT COUNT(*) FROM persons) AS people,
        (SELECT COUNT(*) FROM evidence_items) AS evidence,
        (SELECT COUNT(*) FROM evidence_claims) AS claims,
        (SELECT COUNT(*) FROM relationship_revisions) AS relationships`
      assert.deepStrictEqual(beforeReplay, [{
        entities: 2,
        projections: 3,
        people: 1,
        evidence: 1,
        claims: 1,
        relationships: 1
      }])
      const replay = yield* materializeNormalizedPluginPage(deletedScope, tombstonePage)
      assert.deepStrictEqual(replay, {
        pageCommitted: false,
        acceptedEventCount: 0,
        entityProjectionCount: 0,
        evidenceClaimCount: 0,
        evidenceItemCount: 0,
        nodeCount: 0,
        personCount: 0,
        relationshipCount: 0,
        skippedEntityCount: 0
      })
      const afterReplay = yield* database.sql<Record<string, unknown>>`SELECT
        (SELECT COUNT(*) FROM entities) AS entities,
        (SELECT COUNT(*) FROM entity_projection_revisions) AS projections,
        (SELECT COUNT(*) FROM persons) AS people,
        (SELECT COUNT(*) FROM evidence_items) AS evidence,
        (SELECT COUNT(*) FROM evidence_claims) AS claims,
        (SELECT COUNT(*) FROM relationship_revisions) AS relationships`
      assert.deepStrictEqual(afterReplay, beforeReplay)
    })))

  it.effect("rolls back the checkpoint and canonical writes when materialization fails", () =>
    withMaterializer(Effect.gen(function*() {
      const database = yield* Database
      yield* setup

      const failure = yield* materializeNormalizedPluginPage({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: PLUGIN_ID,
        providerId: "jira",
        streamKey: MATERIALIZED_STREAM,
        expectedRevision: 0,
        committedAt: T2,
        successfulHealth: { _tag: "healthy", checkedAt: T2 }
      }, invalidRelationshipPage).pipe(Effect.flip)
      if (failure._tag !== "NormalizedPluginPageMaterializationError") {
        return yield* Effect.die("expected normalized materialization failure")
      }
      assert.strictEqual(failure.diagnosticCode, "normalized-relationship-kind-invalid")

      const counts = yield* database.sql<{
        readonly entities: number
        readonly pages: number
        readonly projections: number
        readonly streams: number
      }>`SELECT
        (SELECT COUNT(*) FROM plugin_sync_streams) AS streams,
        (SELECT COUNT(*) FROM plugin_sync_pages) AS pages,
        (SELECT COUNT(*) FROM entities) AS entities,
        (SELECT COUNT(*) FROM entity_projection_revisions) AS projections`
      assert.deepStrictEqual(counts, [{ streams: 0, pages: 0, entities: 0, projections: 0 }])
    })))
})
