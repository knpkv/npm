import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Ref, Result, Schema } from "effect"

import {
  EntityId,
  EvidenceId,
  GraphNodeId,
  PluginConnectionId,
  RelationshipId,
  ReleaseId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  PersistedRecordError,
  RecordNotFoundError,
  RevisionConflictError
} from "../../src/server/persistence/errors.js"
import {
  DeliveryGraphInputError,
  DeliveryGraphRepository
} from "../../src/server/persistence/repositories/deliveryGraphRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"

const WORKSPACE_A = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-100000000001")
const WORKSPACE_B = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-100000000002")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-100000000003")
const OTHER_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-10000000000e")
const ISSUE_ID = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-100000000004")
const PIPELINE_ID = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-100000000005")
const ISSUE_NODE_ID = Schema.decodeSync(GraphNodeId)("01890f6f-6d6a-7cc0-98d2-100000000006")
const RELEASE_NODE_ID = Schema.decodeSync(GraphNodeId)("01890f6f-6d6a-7cc0-98d2-100000000007")
const RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-100000000008")
const OTHER_RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-10000000000f")
const EVIDENCE_ID = Schema.decodeSync(EvidenceId)("01890f6f-6d6a-7cc0-98d2-100000000009")
const SECOND_EVIDENCE_ID = Schema.decodeSync(EvidenceId)("01890f6f-6d6a-7cc0-98d2-10000000000a")
const RELATIONSHIP_ID = Schema.decodeSync(RelationshipId)("01890f6f-6d6a-7cc0-98d2-10000000000c")
const CLAIM_ID = "01890f6f-6d6a-7cc0-98d2-10000000000b"
const SUCCESSOR_CLAIM_ID = "01890f6f-6d6a-7cc0-98d2-10000000000d"
const CREATED_AT = "2026-07-15T10:00:00.000Z"
const UPDATED_AT = "2026-07-15T10:05:00.000Z"
const SIX_ISSUE_IDS = Array.from(
  { length: 6 },
  (_, index) => `01890f6f-6d6a-7cc0-98d2-20000000000${index + 1}`
)
const SIX_ISSUE_NODE_IDS = Array.from(
  { length: 6 },
  (_, index) => `01890f6f-6d6a-7cc0-98d2-20000000001${index + 1}`
)
const PR_IDS = [
  "01890f6f-6d6a-7cc0-98d2-200000000021",
  "01890f6f-6d6a-7cc0-98d2-200000000022"
]
const PR_NODE_IDS = [
  "01890f6f-6d6a-7cc0-98d2-200000000031",
  "01890f6f-6d6a-7cc0-98d2-200000000032"
]
const MISSING_PR_NODE_ID = "01890f6f-6d6a-7cc0-98d2-200000000033"
const PIPELINE_FIXTURE_ID = "01890f6f-6d6a-7cc0-98d2-200000000041"
const PIPELINE_FIXTURE_NODE_ID = "01890f6f-6d6a-7cc0-98d2-200000000042"
const unavailableFreshness = {
  _tag: "unavailable",
  pluginHealth: { _tag: "disabled", checkedAt: CREATED_AT },
  provenance: { _tag: "none", pluginConnectionId: PLUGIN_ID },
  sourceObservedAt: null,
  staleAfterSeconds: 300,
  synchronizedAt: null
}
const otherPluginFreshness = {
  ...unavailableFreshness,
  provenance: { _tag: "none", pluginConnectionId: OTHER_PLUGIN_ID }
}
const pluginFreshnessFor = (input: {
  readonly entityRevision?: number
  readonly providerId?: "jira" | "confluence"
  readonly pluginConnectionId?: typeof PLUGIN_ID | typeof OTHER_PLUGIN_ID
  readonly revision?: string
  readonly vendorImmutableId: string
}) => ({
  _tag: "current",
  pluginHealth: { _tag: "healthy", checkedAt: CREATED_AT },
  provenance: {
    _tag: "provider",
    sourceRevision: {
      providerId: input.providerId ?? "jira",
      pluginConnectionId: input.pluginConnectionId ?? PLUGIN_ID,
      vendorImmutableId: input.vendorImmutableId,
      revision: input.revision ?? `source-${input.entityRevision ?? 1}`,
      sourceUrl: null,
      firstObservedAt: CREATED_AT,
      lastObservedAt: CREATED_AT,
      synchronizedAt: CREATED_AT,
      normalizationSchemaVersion: 1
    }
  },
  sourceObservedAt: CREATED_AT,
  staleAfterSeconds: 300,
  synchronizedAt: CREATED_AT
})

const testConfig = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-delivery-graph-" })
  return {
    blobRoot: `${root}/blobs`,
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${root}/control-center.db`,
    maxConnections: 1
  }
})

const withRepository = <Success, Failure>(
  use: Effect.Effect<Success, Failure, DeliveryGraphRepository | Database | QuarantineRepository>
) =>
  Effect.gen(function*() {
    const config = yield* testConfig
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const repository = DeliveryGraphRepository.layer.pipe(Layer.provideMerge(foundation))
    return yield* use.pipe(Effect.provide(repository))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const insertFoundation = Effect.gen(function*() {
  const database = yield* Database
  yield* database.sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (${WORKSPACE_A}, 'Payments', 1, ${CREATED_AT}, ${CREATED_AT})`
  yield* database.sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (${WORKSPACE_B}, 'Identity', 1, ${CREATED_AT}, ${CREATED_AT})`
  yield* database.sql`INSERT INTO plugin_connections (
    workspace_id, plugin_connection_id, provider_id, display_name,
    revision, is_enabled, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_A}, ${PLUGIN_ID}, 'jira', 'Payments Jira', 1, 1, ${CREATED_AT}, ${CREATED_AT}
  )`
  yield* database.sql`INSERT INTO plugin_connections (
    workspace_id, plugin_connection_id, provider_id, display_name,
    revision, is_enabled, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_A}, ${OTHER_PLUGIN_ID}, 'confluence', 'Payments Confluence',
    1, 1, ${CREATED_AT}, ${CREATED_AT}
  )`
  yield* database.sql`INSERT INTO releases (
    workspace_id, release_id, current_revision, created_at, updated_at
  ) VALUES
    (${WORKSPACE_A}, ${RELEASE_ID}, 1, ${CREATED_AT}, ${CREATED_AT}),
    (${WORKSPACE_A}, ${OTHER_RELEASE_ID}, 1, ${CREATED_AT}, ${CREATED_AT})`
  yield* database.sql`INSERT INTO entities (
    workspace_id, entity_id, plugin_connection_id, provider_id, vendor_immutable_id,
    entity_type, current_revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_A}, ${ISSUE_ID}, ${PLUGIN_ID}, 'jira', 'PAY-42',
    'issue', 1, ${CREATED_AT}, ${CREATED_AT}
  )`
  yield* database.sql`INSERT INTO entities (
    workspace_id, entity_id, plugin_connection_id, provider_id, vendor_immutable_id,
    entity_type, current_revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_A}, ${PIPELINE_ID}, ${PLUGIN_ID}, 'jira', 'pipeline-legacy',
    'pipeline', 1, ${CREATED_AT}, ${CREATED_AT}
  )`
  yield* Effect.forEach(
    [ISSUE_ID, PIPELINE_ID],
    (entityId) =>
      database.sql`INSERT INTO entity_revisions (
      workspace_id, entity_id, revision, source_revision, normalization_schema_version,
      source_url, first_observed_at, last_observed_at, synchronized_at, created_at
    ) VALUES (
      ${WORKSPACE_A}, ${entityId}, 1, 'source-1', 1, NULL,
      ${CREATED_AT}, ${CREATED_AT}, ${CREATED_AT}, ${CREATED_AT}
    )`,
    { discard: true }
  )
})

const initialIssueProjection = {
  projection: {
    workspaceId: WORKSPACE_A,
    entityId: ISSUE_ID,
    projectionRevision: 1,
    sourceEntityRevision: 1,
    supersedesProjectionRevision: null,
    projectionSchemaVersion: 1,
    entityState: "present",
    entityType: "issue",
    displayKey: "PAY-42",
    title: "Ship guarded refunds",
    details: {
      _tag: "issue",
      key: "PAY-42",
      status: "In review",
      priority: "High",
      estimatePoints: 5
    }
  },
  recordedAt: CREATED_AT
}

const initialBatch = {
  entityProjections: [
    initialIssueProjection,
    {
      projection: {
        workspaceId: WORKSPACE_A,
        entityId: PIPELINE_ID,
        projectionRevision: 1,
        sourceEntityRevision: 1,
        supersedesProjectionRevision: null,
        projectionSchemaVersion: 1,
        entityState: "present",
        entityType: "pipeline-execution",
        displayKey: "payments-main/173",
        title: "Payments main pipeline",
        details: {
          _tag: "pipeline-execution",
          pipelineName: "payments-main",
          executionId: "173",
          status: "succeeded",
          triggerRevision: "abc123"
        }
      },
      recordedAt: CREATED_AT
    }
  ],
  nodes: [
    {
      workspaceId: WORKSPACE_A,
      nodeId: ISSUE_NODE_ID,
      endpointKind: "issue",
      resolution: {
        _tag: "resolved",
        target: { _tag: "entity", entityId: ISSUE_ID, entityKind: "issue" }
      },
      createdAt: CREATED_AT
    },
    {
      workspaceId: WORKSPACE_A,
      nodeId: RELEASE_NODE_ID,
      endpointKind: "release",
      resolution: { _tag: "resolved", target: { _tag: "release", releaseId: RELEASE_ID } },
      createdAt: CREATED_AT
    }
  ],
  evidenceItems: [
    {
      workspaceId: WORKSPACE_A,
      evidenceId: EVIDENCE_ID,
      schemaVersion: 1,
      attribution: { _tag: "system", component: "release-synchronizer" },
      verifier: { _tag: "system", component: "delivery-graph" },
      observedAt: CREATED_AT,
      recordedAt: CREATED_AT,
      validUntil: null,
      freshness: unavailableFreshness,
      retention: { classification: "audit", retainUntil: null, legalHold: false }
    }
  ],
  evidenceClaims: [
    {
      workspaceId: WORKSPACE_A,
      evidenceClaimId: CLAIM_ID,
      evidenceId: EVIDENCE_ID,
      subjectNodeId: ISSUE_NODE_ID,
      predicate: "relationship-observed",
      value: { _tag: "reference", targetNodeId: RELEASE_NODE_ID },
      recordedAt: CREATED_AT,
      supersedesEvidenceClaimId: null
    }
  ],
  relationships: [
    {
      workspaceId: WORKSPACE_A,
      relationshipId: RELATIONSHIP_ID,
      relationshipSchemaVersion: 1,
      revision: 1,
      supersedesRevision: null,
      kind: "contains",
      sourceNodeId: RELEASE_NODE_ID,
      sourceNodeKind: "release",
      targetNodeId: ISSUE_NODE_ID,
      targetNodeKind: "issue",
      scope: { _tag: "release", releaseId: RELEASE_ID },
      lifecycle: { _tag: "verified", effectiveAt: CREATED_AT },
      confidence: { _tag: "confirmed" },
      provenance: {
        _tag: "rule",
        ruleId: "jira-fix-version",
        ruleVersion: 1,
        rationale: "Issue fix version matches release."
      },
      recordedBy: { _tag: "system", component: "release-synchronizer" },
      evidenceClaimIds: [CLAIM_ID],
      recordedAt: CREATED_AT
    }
  ]
}

const insertSixIssueFoundation = Effect.gen(function*() {
  const database = yield* Database
  const entities = [
    ...SIX_ISSUE_IDS.map((entityId, index) => ({
      entityId,
      entityType: "issue",
      vendorId: `PAY-${index + 101}`
    })),
    ...PR_IDS.map((entityId, index) => ({
      entityId,
      entityType: "pull-request",
      vendorId: `PR-${index + 41}`
    })),
    { entityId: PIPELINE_FIXTURE_ID, entityType: "pipeline", vendorId: "pipeline-201" }
  ]
  yield* Effect.forEach(
    entities,
    ({ entityId, entityType, vendorId }) =>
      Effect.gen(function*() {
        yield* database.sql`INSERT INTO entities (
          workspace_id, entity_id, plugin_connection_id, provider_id, vendor_immutable_id,
          entity_type, current_revision, created_at, updated_at
        ) VALUES (
          ${WORKSPACE_A}, ${entityId}, ${PLUGIN_ID}, 'jira', ${vendorId},
          ${entityType}, 1, ${CREATED_AT}, ${CREATED_AT}
        )`
        yield* database.sql`INSERT INTO entity_revisions (
          workspace_id, entity_id, revision, source_revision, normalization_schema_version,
          source_url, first_observed_at, last_observed_at, synchronized_at, created_at
        ) VALUES (
          ${WORKSPACE_A}, ${entityId}, 1, 'source-1', 1, NULL,
          ${CREATED_AT}, ${CREATED_AT}, ${CREATED_AT}, ${CREATED_AT}
        )`
      }),
    { discard: true }
  )
})

const sixIssueBatch = {
  entityProjections: [
    ...SIX_ISSUE_IDS.map((entityId, index) => ({
      projection: {
        workspaceId: WORKSPACE_A,
        entityId,
        projectionRevision: 1,
        sourceEntityRevision: 1,
        supersedesProjectionRevision: null,
        projectionSchemaVersion: 1,
        entityState: "present",
        entityType: "issue",
        displayKey: `PAY-${index + 101}`,
        title: `Release issue ${index + 1}`,
        details: {
          _tag: "issue",
          key: `PAY-${index + 101}`,
          status: index === 5 ? "Blocked" : "Ready",
          priority: null,
          estimatePoints: index + 1
        }
      },
      recordedAt: CREATED_AT
    })),
    ...PR_IDS.map((entityId, index) => ({
      projection: {
        workspaceId: WORKSPACE_A,
        entityId,
        projectionRevision: 1,
        sourceEntityRevision: 1,
        supersedesProjectionRevision: null,
        projectionSchemaVersion: 1,
        entityState: "present",
        entityType: "pull-request",
        displayKey: `PR-${index + 41}`,
        title: `Release pull request ${index + 1}`,
        details: {
          _tag: "pull-request",
          repository: "payments-api",
          sourceBranch: `feature/release-${index + 1}`,
          targetBranch: "main",
          headRevision: `revision-${index + 1}`,
          reviewState: "approved"
        }
      },
      recordedAt: CREATED_AT
    })),
    {
      projection: {
        workspaceId: WORKSPACE_A,
        entityId: PIPELINE_FIXTURE_ID,
        projectionRevision: 1,
        sourceEntityRevision: 1,
        supersedesProjectionRevision: null,
        projectionSchemaVersion: 1,
        entityState: "present",
        entityType: "pipeline-execution",
        displayKey: "payments-main/201",
        title: "Release pipeline execution",
        details: {
          _tag: "pipeline-execution",
          pipelineName: "payments-main",
          executionId: "201",
          status: "running",
          triggerRevision: "release-head"
        }
      },
      recordedAt: CREATED_AT
    }
  ],
  nodes: [
    ...SIX_ISSUE_IDS.map((entityId, index) => ({
      workspaceId: WORKSPACE_A,
      nodeId: SIX_ISSUE_NODE_IDS[index],
      endpointKind: "issue",
      resolution: {
        _tag: "resolved",
        target: { _tag: "entity", entityId, entityKind: "issue" }
      },
      createdAt: CREATED_AT
    })),
    ...PR_IDS.map((entityId, index) => ({
      workspaceId: WORKSPACE_A,
      nodeId: PR_NODE_IDS[index],
      endpointKind: "pull-request",
      resolution: {
        _tag: "resolved",
        target: { _tag: "entity", entityId, entityKind: "pull-request" }
      },
      createdAt: CREATED_AT
    })),
    {
      workspaceId: WORKSPACE_A,
      nodeId: MISSING_PR_NODE_ID,
      endpointKind: "pull-request",
      resolution: {
        _tag: "missing",
        expectedKind: "entity",
        expectedEntityKind: "pull-request",
        missingKey: "PAY-106:pull-request"
      },
      createdAt: CREATED_AT
    },
    {
      workspaceId: WORKSPACE_A,
      nodeId: PIPELINE_FIXTURE_NODE_ID,
      endpointKind: "pipeline-execution",
      resolution: {
        _tag: "resolved",
        target: {
          _tag: "entity",
          entityId: PIPELINE_FIXTURE_ID,
          entityKind: "pipeline-execution"
        }
      },
      createdAt: CREATED_AT
    }
  ],
  evidenceItems: [],
  evidenceClaims: [],
  relationships: [
    ...[
      [PR_NODE_IDS[0], SIX_ISSUE_NODE_IDS[0]],
      [PR_NODE_IDS[0], SIX_ISSUE_NODE_IDS[1]],
      [PR_NODE_IDS[0], SIX_ISSUE_NODE_IDS[2]],
      [PR_NODE_IDS[1], SIX_ISSUE_NODE_IDS[2]],
      [PR_NODE_IDS[1], SIX_ISSUE_NODE_IDS[3]],
      [PR_NODE_IDS[1], SIX_ISSUE_NODE_IDS[4]]
    ].map(([sourceNodeId, targetNodeId], index) => ({
      workspaceId: WORKSPACE_A,
      relationshipId: `01890f6f-6d6a-7cc0-98d2-20000000010${index + 1}`,
      relationshipSchemaVersion: 1,
      revision: 1,
      supersedesRevision: null,
      kind: "implements",
      sourceNodeId,
      sourceNodeKind: "pull-request",
      targetNodeId,
      targetNodeKind: "issue",
      scope: { _tag: "release", releaseId: RELEASE_ID },
      lifecycle: { _tag: "verified", effectiveAt: CREATED_AT },
      confidence: {
        _tag: "unknown",
        rationale: "The fixture does not persist the provider observation as immutable evidence."
      },
      provenance: {
        _tag: "rule",
        ruleId: "issue-key-in-pr",
        ruleVersion: 1,
        rationale: "Issue key is present in pull request metadata."
      },
      recordedBy: { _tag: "system", component: "delivery-graph-fixture" },
      evidenceClaimIds: [],
      recordedAt: CREATED_AT
    })),
    {
      workspaceId: WORKSPACE_A,
      relationshipId: "01890f6f-6d6a-7cc0-98d2-200000000107",
      relationshipSchemaVersion: 1,
      revision: 1,
      supersedesRevision: null,
      kind: "implements",
      sourceNodeId: MISSING_PR_NODE_ID,
      sourceNodeKind: "pull-request",
      targetNodeId: SIX_ISSUE_NODE_IDS[5],
      targetNodeKind: "issue",
      scope: { _tag: "release", releaseId: RELEASE_ID },
      lifecycle: {
        _tag: "missing",
        effectiveAt: CREATED_AT,
        reason: "No pull request is associated with this release issue."
      },
      confidence: { _tag: "unknown", rationale: "No source relationship was observed." },
      provenance: {
        _tag: "rule",
        ruleId: "missing-pr-check",
        ruleVersion: 1,
        rationale: "Every release issue must have a pull request."
      },
      recordedBy: { _tag: "system", component: "delivery-graph-fixture" },
      evidenceClaimIds: [],
      recordedAt: CREATED_AT
    },
    ...PR_NODE_IDS.map((sourceNodeId, index) => ({
      workspaceId: WORKSPACE_A,
      relationshipId: `01890f6f-6d6a-7cc0-98d2-20000000011${index + 1}`,
      relationshipSchemaVersion: 1,
      revision: 1,
      supersedesRevision: null,
      kind: "delivered-by",
      sourceNodeId,
      sourceNodeKind: "pull-request",
      targetNodeId: PIPELINE_FIXTURE_NODE_ID,
      targetNodeKind: "pipeline-execution",
      scope: { _tag: "release", releaseId: RELEASE_ID },
      lifecycle: { _tag: "inferred", effectiveAt: CREATED_AT },
      confidence: {
        _tag: "inferred",
        score: 0.9,
        rationale: "Pipeline trigger includes the pull request revision."
      },
      provenance: {
        _tag: "rule",
        ruleId: "pipeline-trigger-revision",
        ruleVersion: 1,
        rationale: "Pipeline trigger revision contains the pull request head."
      },
      recordedBy: { _tag: "system", component: "delivery-graph-fixture" },
      evidenceClaimIds: [],
      recordedAt: CREATED_AT
    }))
  ]
}

describe("DeliveryGraphRepository", () => {
  it.effect("persists the six-issue release fixture across PR and pipeline dimensions", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        yield* insertSixIssueFoundation
        const repository = yield* DeliveryGraphRepository
        const receipt = yield* repository.write(WORKSPACE_A, sixIssueBatch)
        assert.deepStrictEqual(receipt, {
          entityProjectionCount: 9,
          nodeCount: 10,
          evidenceItemCount: 0,
          evidenceClaimCount: 0,
          relationshipCount: 9
        })
        const slice = yield* repository.read(WORKSPACE_A, {
          _tag: "releaseSlice",
          releaseId: RELEASE_ID,
          environmentId: null,
          limit: 100
        })
        assert.strictEqual(slice._tag, "releaseSlice")
        if (slice._tag === "releaseSlice") {
          const implementsLinks = slice.value.relationships.filter(({ kind }) => kind === "implements")
          const pipelineLinks = slice.value.relationships.filter(({ kind }) => kind === "delivered-by")
          const missingLinks = implementsLinks.filter(({ lifecycle }) => lifecycle._tag === "missing")
          const sharedIssueLinks = implementsLinks.filter(
            ({ targetNodeId }) => targetNodeId === SIX_ISSUE_NODE_IDS[2]
          )
          const secondPullRequestLinks = implementsLinks.filter(
            ({ sourceNodeId }) => sourceNodeId === PR_NODE_IDS[1]
          )
          assert.lengthOf(implementsLinks, 7)
          assert.lengthOf(pipelineLinks, 2)
          assert.lengthOf(missingLinks, 1)
          assert.lengthOf(sharedIssueLinks, 2)
          assert.lengthOf(secondPullRequestLinks, 3)
          assert.lengthOf(slice.value.entityProjections, 9)
          assert.lengthOf(slice.value.evidenceClaims, 0)
        }
      })
    ))

  it.effect("wraps the multi-query release slice in one database transaction", () =>
    Effect.gen(function*() {
      const config = yield* testConfig
      const databaseContext = yield* Layer.build(databaseLayer(config))
      const database = Context.get(databaseContext, Database)
      const transactionCount = yield* Ref.make(0)
      const observedDatabase = Layer.succeed(
        Database,
        Database.of({
          ...database,
          transaction: (effect) =>
            Ref.update(transactionCount, (count) => count + 1).pipe(
              Effect.andThen(database.transaction(effect))
            )
        })
      )
      const repositoryContext = yield* Layer.build(
        DeliveryGraphRepository.layer.pipe(
          Layer.provide(
            QuarantineRepository.layer.pipe(Layer.provideMerge(observedDatabase))
          )
        )
      )
      const repository = Context.get(repositoryContext, DeliveryGraphRepository)

      yield* insertFoundation.pipe(Effect.provide(databaseContext))
      yield* repository.write(WORKSPACE_A, initialBatch)
      yield* Ref.set(transactionCount, 0)
      const slice = yield* repository.read(WORKSPACE_A, {
        _tag: "releaseSlice",
        releaseId: RELEASE_ID,
        environmentId: null,
        limit: 100
      })

      assert.strictEqual(slice._tag, "releaseSlice")
      assert.strictEqual(yield* Ref.get(transactionCount), 1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("atomically writes and reads the graph, including legacy pipeline projection mapping", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const receipt = yield* repository.write(WORKSPACE_A, initialBatch)
        assert.deepStrictEqual(receipt, {
          entityProjectionCount: 2,
          nodeCount: 2,
          evidenceItemCount: 1,
          evidenceClaimCount: 1,
          relationshipCount: 1
        })

        const pipeline = yield* repository.read(WORKSPACE_A, {
          _tag: "entityProjection",
          entityId: PIPELINE_ID,
          revision: null
        })
        assert.strictEqual(pipeline._tag, "entityProjection")
        if (pipeline._tag === "entityProjection") {
          assert.strictEqual(pipeline.value.projection.entityType, "pipeline-execution")
        }

        const slice = yield* repository.read(WORKSPACE_A, {
          _tag: "releaseSlice",
          releaseId: RELEASE_ID,
          environmentId: null,
          limit: 100
        })
        assert.strictEqual(slice._tag, "releaseSlice")
        if (slice._tag === "releaseSlice") {
          assert.lengthOf(slice.value.relationships, 1)
          assert.lengthOf(slice.value.nodes, 2)
          assert.lengthOf(slice.value.entityProjections, 1)
          assert.lengthOf(slice.value.evidenceClaims, 1)
          assert.lengthOf(slice.value.evidenceItems, 1)
        }
      })
    ))

  it.effect("rejects empty input and isolates graph identities by workspace", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const empty = yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: []
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(empty))
        if (Result.isFailure(empty)) assert.instanceOf(empty.failure, DeliveryGraphInputError)

        yield* repository.write(WORKSPACE_A, initialBatch)
        const crossWorkspace = yield* repository.read(WORKSPACE_B, {
          _tag: "relationship",
          relationshipId: RELATIONSHIP_ID,
          revision: null
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(crossWorkspace))
        if (Result.isFailure(crossWorkspace)) {
          assert.instanceOf(crossWorkspace.failure, RecordNotFoundError)
        }
      })
    ))

  it.effect("binds release containment scope to its resolved release source", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        const mismatchedContainment = yield* repository.write(WORKSPACE_A, {
          ...initialBatch,
          relationships: [{
            ...initialBatch.relationships[0],
            scope: { _tag: "release", releaseId: OTHER_RELEASE_ID }
          }]
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(mismatchedContainment))
        if (Result.isFailure(mismatchedContainment)) {
          assert.instanceOf(mismatchedContainment.failure, PersistedRecordError)
        }
        const rows = yield* database.sql<{ readonly count: number }>`SELECT
            (SELECT COUNT(*) FROM delivery_nodes WHERE workspace_id = ${WORKSPACE_A}) +
            (SELECT COUNT(*) FROM relationship_revisions WHERE workspace_id = ${WORKSPACE_A})
              AS count`
        assert.deepStrictEqual(rows, [{ count: 0 }])
      })
    ))

  it.effect("rejects canonical entity-kind mismatches and rolls back preceding graph records", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database

        const mismatchedProjection = yield* repository.write(WORKSPACE_A, {
          entityProjections: [
            initialIssueProjection,
            {
              projection: {
                ...initialIssueProjection.projection,
                entityId: PIPELINE_ID,
                displayKey: "pipeline-as-issue",
                title: "Pipeline represented as an issue"
              },
              recordedAt: CREATED_AT
            }
          ],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: []
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatchedProjection))

        const projectionRows = yield* database.sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM entity_projection_revisions
          WHERE workspace_id = ${WORKSPACE_A}`
        assert.deepStrictEqual(projectionRows, [{ count: 0 }])

        const mismatchedNode = yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [
            {
              workspaceId: WORKSPACE_A,
              nodeId: ISSUE_NODE_ID,
              endpointKind: "issue",
              resolution: {
                _tag: "resolved",
                target: { _tag: "entity", entityId: ISSUE_ID, entityKind: "issue" }
              },
              createdAt: CREATED_AT
            },
            {
              workspaceId: WORKSPACE_A,
              nodeId: RELEASE_NODE_ID,
              endpointKind: "issue",
              resolution: {
                _tag: "resolved",
                target: { _tag: "entity", entityId: PIPELINE_ID, entityKind: "issue" }
              },
              createdAt: CREATED_AT
            }
          ],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: []
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatchedNode))

        const nodeRows = yield* database.sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM delivery_nodes
          WHERE workspace_id = ${WORKSPACE_A}`
        assert.deepStrictEqual(nodeRows, [{ count: 0 }])
      })
    ))

  it.effect("binds plugin evidence and relationship provenance to the owning connection", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        const validSystemEvidence = {
          ...initialBatch.evidenceItems[0],
          evidenceId: SECOND_EVIDENCE_ID
        }
        const wrongOwnerEvidence = {
          ...initialBatch.evidenceItems[0],
          attribution: {
            _tag: "plugin",
            pluginConnectionId: OTHER_PLUGIN_ID,
            sourceEntityId: ISSUE_ID,
            sourceEntityRevision: 1
          },
          freshness: otherPluginFreshness
        }

        const wrongOwner = yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [validSystemEvidence, wrongOwnerEvidence],
          evidenceClaims: [],
          relationships: []
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(wrongOwner))
        const evidenceRows = yield* database.sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM evidence_items
          WHERE workspace_id = ${WORKSPACE_A}`
        assert.deepStrictEqual(evidenceRows, [{ count: 0 }])

        const mismatchedFreshness = yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [{
            ...wrongOwnerEvidence,
            attribution: {
              ...wrongOwnerEvidence.attribution,
              pluginConnectionId: PLUGIN_ID
            }
          }],
          evidenceClaims: [],
          relationships: []
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatchedFreshness))
        if (Result.isFailure(mismatchedFreshness)) {
          assert.instanceOf(mismatchedFreshness.failure, DeliveryGraphInputError)
        }

        const wrongSourceRevision = yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [{
            ...initialBatch.evidenceItems[0],
            evidenceId: SECOND_EVIDENCE_ID,
            attribution: {
              _tag: "plugin",
              pluginConnectionId: PLUGIN_ID,
              sourceEntityId: ISSUE_ID,
              sourceEntityRevision: 1
            },
            freshness: pluginFreshnessFor({ vendorImmutableId: "pipeline-legacy" })
          }],
          evidenceClaims: [],
          relationships: []
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(wrongSourceRevision))

        yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [{
            ...initialBatch.evidenceItems[0],
            evidenceId: SECOND_EVIDENCE_ID,
            attribution: {
              _tag: "plugin",
              pluginConnectionId: PLUGIN_ID,
              sourceEntityId: ISSUE_ID,
              sourceEntityRevision: 1
            },
            freshness: pluginFreshnessFor({ vendorImmutableId: "PAY-42" })
          }],
          evidenceClaims: [],
          relationships: []
        })

        yield* repository.write(WORKSPACE_A, initialBatch)
        const wrongRelationshipOwner = yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: [{
            ...initialBatch.relationships[0],
            revision: 2,
            supersedesRevision: 1,
            lifecycle: { _tag: "governed", effectiveAt: UPDATED_AT },
            provenance: {
              _tag: "plugin",
              pluginConnectionId: OTHER_PLUGIN_ID,
              sourceEntityId: ISSUE_ID,
              sourceEntityRevision: 1
            },
            recordedAt: UPDATED_AT
          }]
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(wrongRelationshipOwner))
        const relationshipRows = yield* database.sql<{
          readonly count: number
          readonly currentRevision: number
        }>`SELECT COUNT(revision.revision) AS count,
              head.current_revision AS currentRevision
          FROM relationship_heads head
          INNER JOIN relationship_revisions revision
            ON revision.workspace_id = head.workspace_id
           AND revision.relationship_id = head.relationship_id
          WHERE head.workspace_id = ${WORKSPACE_A}
            AND head.relationship_id = ${RELATIONSHIP_ID}
          GROUP BY head.current_revision`
        assert.deepStrictEqual(relationshipRows, [{ count: 1, currentRevision: 1 }])
      })
    ))

  it.effect("uses exact relationship CAS and rolls back the entire stale batch", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        yield* repository.write(WORKSPACE_A, initialBatch)
        const revisionTwo = {
          ...initialBatch.relationships[0],
          revision: 2,
          supersedesRevision: 1,
          lifecycle: { _tag: "governed", effectiveAt: UPDATED_AT },
          recordedAt: UPDATED_AT
        }
        yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: [revisionTwo]
        })

        const stale = yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [
            {
              ...initialBatch.evidenceItems[0],
              evidenceId: SECOND_EVIDENCE_ID,
              recordedAt: UPDATED_AT,
              observedAt: UPDATED_AT
            }
          ],
          evidenceClaims: [],
          relationships: [revisionTwo]
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(stale))
        if (Result.isFailure(stale)) assert.instanceOf(stale.failure, RevisionConflictError)

        const rows = yield* database.sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM evidence_items
          WHERE workspace_id = ${WORKSPACE_A} AND evidence_id = ${SECOND_EVIDENCE_ID}`
        assert.strictEqual(rows[0]?.count, 0)
        const history = yield* repository.read(WORKSPACE_A, {
          _tag: "relationshipHistory",
          relationshipId: RELATIONSHIP_ID,
          limit: 10
        })
        assert.strictEqual(history._tag, "relationshipHistory")
        if (history._tag === "relationshipHistory") assert.lengthOf(history.value, 2)
      })
    ))

  it.effect("keeps projection history and rejects backdated supersession", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        yield* repository.write(WORKSPACE_A, initialBatch)
        yield* database.sql`INSERT INTO entity_revisions (
          workspace_id, entity_id, revision, source_revision, normalization_schema_version,
          source_url, first_observed_at, last_observed_at, synchronized_at, created_at
        ) VALUES (
          ${WORKSPACE_A}, ${ISSUE_ID}, 2, 'source-2', 1, NULL,
          ${CREATED_AT}, ${UPDATED_AT}, ${UPDATED_AT}, ${UPDATED_AT}
        )`
        yield* database.sql`UPDATE entities
          SET current_revision = 2, updated_at = ${UPDATED_AT}
          WHERE workspace_id = ${WORKSPACE_A} AND entity_id = ${ISSUE_ID}`

        yield* repository.write(WORKSPACE_A, {
          entityProjections: [{
            projection: {
              ...initialIssueProjection.projection,
              projectionRevision: 2,
              sourceEntityRevision: 2,
              supersedesProjectionRevision: 1,
              title: "Ship guarded refunds safely",
              details: {
                ...initialIssueProjection.projection.details,
                status: "Ready"
              }
            },
            recordedAt: UPDATED_AT
          }],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: []
        })

        const first = yield* repository.read(WORKSPACE_A, {
          _tag: "entityProjection",
          entityId: ISSUE_ID,
          revision: 1
        })
        const second = yield* repository.read(WORKSPACE_A, {
          _tag: "entityProjection",
          entityId: ISSUE_ID,
          revision: 2
        })
        assert.strictEqual(first._tag, "entityProjection")
        assert.strictEqual(second._tag, "entityProjection")
        if (first._tag === "entityProjection" && second._tag === "entityProjection") {
          assert.strictEqual(first.value.projection.title, "Ship guarded refunds")
          assert.strictEqual(second.value.projection.title, "Ship guarded refunds safely")
          assert.strictEqual(second.value.projection.sourceEntityRevision, 2)
        }

        const regressedProjection = yield* repository.write(WORKSPACE_A, {
          entityProjections: [{
            projection: {
              ...initialIssueProjection.projection,
              projectionRevision: 3,
              sourceEntityRevision: 1,
              supersedesProjectionRevision: 2,
              title: "Regressed source projection"
            },
            recordedAt: UPDATED_AT
          }],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: []
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(regressedProjection))

        yield* repository.write(WORKSPACE_A, {
          entityProjections: [{
            projection: {
              ...initialIssueProjection.projection,
              projectionRevision: 3,
              sourceEntityRevision: 2,
              supersedesProjectionRevision: 2,
              title: "Reprojected from the same source revision"
            },
            recordedAt: UPDATED_AT
          }],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: []
        })
        yield* database.sql`INSERT INTO entity_revisions (
          workspace_id, entity_id, revision, source_revision, normalization_schema_version,
          source_url, first_observed_at, last_observed_at, synchronized_at, created_at
        ) VALUES (
          ${WORKSPACE_A}, ${ISSUE_ID}, 3, 'source-3', 1, NULL,
          ${CREATED_AT}, ${UPDATED_AT}, ${UPDATED_AT}, ${UPDATED_AT}
        )`
        yield* repository.write(WORKSPACE_A, {
          entityProjections: [{
            projection: {
              ...initialIssueProjection.projection,
              projectionRevision: 4,
              sourceEntityRevision: 3,
              supersedesProjectionRevision: 3,
              title: "Advanced source projection"
            },
            recordedAt: UPDATED_AT
          }],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: []
        })
        const projectionRows = yield* database.sql<{
          readonly projectionRevision: number
          readonly sourceEntityRevision: number
        }>`SELECT projection_revision AS projectionRevision,
              source_entity_revision AS sourceEntityRevision
          FROM entity_projection_revisions
          WHERE workspace_id = ${WORKSPACE_A} AND entity_id = ${ISSUE_ID}
          ORDER BY projection_revision`
        assert.deepStrictEqual(projectionRows, [
          { projectionRevision: 1, sourceEntityRevision: 1 },
          { projectionRevision: 2, sourceEntityRevision: 2 },
          { projectionRevision: 3, sourceEntityRevision: 2 },
          { projectionRevision: 4, sourceEntityRevision: 3 }
        ])

        const backdatedClaim = yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [{
            ...initialBatch.evidenceClaims[0],
            evidenceClaimId: SUCCESSOR_CLAIM_ID,
            recordedAt: "2026-07-15T09:59:59.999Z",
            supersedesEvidenceClaimId: CLAIM_ID
          }],
          relationships: []
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(backdatedClaim))
        if (Result.isFailure(backdatedClaim)) {
          assert.instanceOf(backdatedClaim.failure, PersistedRecordError)
          assert.strictEqual(backdatedClaim.failure.diagnosticCode, "evidence-claim-precedes-evidence")
        }

        const backdatedRelationship = yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: [{
            ...initialBatch.relationships[0],
            revision: 2,
            supersedesRevision: 1,
            lifecycle: { _tag: "governed", effectiveAt: "2026-07-15T09:59:59.999Z" },
            recordedAt: "2026-07-15T09:59:59.999Z"
          }]
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(backdatedRelationship))
        if (Result.isFailure(backdatedRelationship)) {
          assert.instanceOf(backdatedRelationship.failure, PersistedRecordError)
          assert.strictEqual(
            backdatedRelationship.failure.diagnosticCode,
            "relationship-precedes-evidence-claim"
          )
        }
      })
    ))

  it.effect("rejects evidence and relationship records that invert causal time", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        const beforeEvidence = "2026-07-15T09:59:59.999Z"

        const claimBeforeEvidence = yield* repository.write(WORKSPACE_A, {
          ...initialBatch,
          evidenceClaims: [{
            ...initialBatch.evidenceClaims[0],
            recordedAt: beforeEvidence
          }],
          relationships: []
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(claimBeforeEvidence))
        const rolledBackRows = yield* database.sql<{ readonly count: number }>`SELECT
            (SELECT COUNT(*) FROM entity_projection_revisions WHERE workspace_id = ${WORKSPACE_A}) +
            (SELECT COUNT(*) FROM delivery_nodes WHERE workspace_id = ${WORKSPACE_A}) +
            (SELECT COUNT(*) FROM evidence_items WHERE workspace_id = ${WORKSPACE_A}) +
            (SELECT COUNT(*) FROM evidence_claims WHERE workspace_id = ${WORKSPACE_A}) AS count`
        assert.deepStrictEqual(rolledBackRows, [{ count: 0 }])

        const relationshipBeforeClaim = yield* repository.write(WORKSPACE_A, {
          ...initialBatch,
          relationships: [{
            ...initialBatch.relationships[0],
            lifecycle: { _tag: "verified", effectiveAt: beforeEvidence },
            recordedAt: beforeEvidence
          }]
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(relationshipBeforeClaim))

        yield* repository.write(WORKSPACE_A, initialBatch)
        yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [{
            ...initialBatch.evidenceClaims[0],
            evidenceClaimId: SUCCESSOR_CLAIM_ID,
            recordedAt: UPDATED_AT,
            supersedesEvidenceClaimId: CLAIM_ID
          }],
          relationships: [{
            ...initialBatch.relationships[0],
            revision: 2,
            supersedesRevision: 1,
            lifecycle: { _tag: "governed", effectiveAt: UPDATED_AT },
            evidenceClaimIds: [SUCCESSOR_CLAIM_ID],
            recordedAt: UPDATED_AT
          }]
        })
        const causalRows = yield* database.sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM relationship_revision_evidence
          WHERE workspace_id = ${WORKSPACE_A} AND relationship_id = ${RELATIONSHIP_ID}`
        assert.deepStrictEqual(causalRows, [{ count: 2 }])
      })
    ))

  it.effect("durably quarantines a persisted claim digest mismatch with redacted diagnostics", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        const quarantine = yield* QuarantineRepository
        yield* repository.write(WORKSPACE_A, initialBatch)

        yield* repository.read(WORKSPACE_A, {
          _tag: "evidence",
          evidenceId: EVIDENCE_ID
        })
        assert.isEmpty(yield* quarantine.list(WORKSPACE_A))

        const secretCanary = "never-return-raw-claim-payload"
        yield* database.sql`DROP TRIGGER evidence_claims_no_update`
        yield* database.sql`UPDATE evidence_claims
          SET value_json = ${`{"_tag":"text","value":"${secretCanary}"}`}
          WHERE workspace_id = ${WORKSPACE_A} AND evidence_claim_id = ${CLAIM_ID}`

        const corrupted = yield* repository.read(WORKSPACE_A, {
          _tag: "evidence",
          evidenceId: EVIDENCE_ID
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(corrupted))
        if (Result.isFailure(corrupted)) {
          assert.instanceOf(corrupted.failure, PersistedRecordError)
          assert.strictEqual(corrupted.failure.diagnosticCode, "delivery-graph-digest-mismatch")
        }

        yield* repository.read(WORKSPACE_A, {
          _tag: "evidence",
          evidenceId: EVIDENCE_ID
        }).pipe(Effect.result)
        const records = yield* quarantine.list(WORKSPACE_A)
        assert.lengthOf(records, 1)
        assert.deepInclude(records[0], {
          recordKind: "evidence-claim",
          recordKey: CLAIM_ID,
          schemaVersion: 1,
          diagnosticCode: "delivery-graph-digest-mismatch",
          diagnosticSummary: "Stored delivery graph record digest does not match its content.",
          occurrenceCount: 2
        })
        assert.match(records[0]?.payloadDigest ?? "", /^[0-9a-f]{64}$/u)
        assert.notInclude(JSON.stringify(records), secretCanary)
      })
    ))
})
