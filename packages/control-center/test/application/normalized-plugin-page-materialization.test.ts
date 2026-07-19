import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"

import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { PluginSyncPageV1 } from "../../src/domain/plugins/events.js"
import { VendorImmutableId } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  materializeNormalizedPluginPage,
  type NormalizedPluginPageMaterializationScope
} from "../../src/server/application/normalizedPluginPageMaterialization.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { PluginStreamKey } from "../../src/server/persistence/repositories/pluginRuntimeModels.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000193")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000194")
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
      assert.strictEqual((yield* items()).totalCount, 0)

      const releases = yield* persistence.releases.list(WORKSPACE_ID, 10)
      assert.lengthOf(releases, 1)
      assert.strictEqual(releases[0]?.release.serviceName, "Payments")
      assert.strictEqual(releases[0]?.release.version, "2026.29")
      assert.strictEqual(releases[0]?.release.lifecycle, "candidate")
      assert.strictEqual(releases[0]?.release.sourceRevisions[0]?.vendorImmutableId, "jira-version:2026.29")

      const replay = yield* materializeNormalizedPluginPage(scope, jiraReleasePage)
      assert.isFalse(replay.pageCommitted)
      assert.lengthOf(yield* persistence.releases.list(WORKSPACE_ID, 10), 1)
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
