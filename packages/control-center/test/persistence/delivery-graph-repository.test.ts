import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Ref, Result, Schema } from "effect"

import { ReleaseDeliveryGraphInspection } from "../../src/api/deliveryGraph.js"
import {
  EntityId,
  EvidenceId,
  GraphNodeId,
  PersonId,
  PluginConnectionId,
  RelationshipId,
  ReleaseId,
  RoleAssignmentId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { Revision, VendorImmutableId } from "../../src/domain/sourceRevision.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  PersistedRecordError,
  RecordNotFoundError,
  RevisionConflictError
} from "../../src/server/persistence/errors.js"
import { selectBoundedRelationshipClosure } from "../../src/server/persistence/repositories/delivery-graph/release-slice.js"
import {
  DeliveryGraphInputError,
  DeliveryGraphQuery,
  DeliveryGraphRepository
} from "../../src/server/persistence/repositories/deliveryGraphRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"

const WORKSPACE_A = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-100000000001")
const WORKSPACE_B = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-100000000002")
const PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-100000000003")
const OTHER_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-10000000000e")
const CLOCKIFY_PLUGIN_ID = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-100000000018")
const NOISE_CONFLUENCE_PLUGIN_IDS = Array.from(
  { length: 16 },
  (_, index) =>
    Schema.decodeSync(PluginConnectionId)(
      `01890f6f-6d6a-7cc0-98d2-${String(index + 1).padStart(12, "0")}`
    )
)
const ISSUE_ID = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-100000000004")
const PIPELINE_ID = Schema.decodeSync(EntityId)("01890f6f-6d6a-7cc0-98d2-100000000005")
const ISSUE_NODE_ID = Schema.decodeSync(GraphNodeId)("01890f6f-6d6a-7cc0-98d2-100000000006")
const RELEASE_NODE_ID = Schema.decodeSync(GraphNodeId)("01890f6f-6d6a-7cc0-98d2-100000000007")
const RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-100000000008")
const OTHER_RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-10000000000f")
const OTHER_RELEASE_NODE_ID = Schema.decodeSync(GraphNodeId)("01890f6f-6d6a-7cc0-98d2-100000000011")
const OTHER_RELATIONSHIP_ID = Schema.decodeSync(RelationshipId)("01890f6f-6d6a-7cc0-98d2-100000000012")
const OWNER_PERSON_ID = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-100000000013")
const OWNER_ASSIGNMENT_ID = Schema.decodeSync(RoleAssignmentId)("01890f6f-6d6a-7cc0-98d2-100000000014")
const OWNER_AUTHOR_ASSIGNMENT_ID = Schema.decodeSync(RoleAssignmentId)("01890f6f-6d6a-7cc0-98d2-100000000015")
const OWNER_OPERATOR_ASSIGNMENT_ID = Schema.decodeSync(RoleAssignmentId)("01890f6f-6d6a-7cc0-98d2-100000000016")
const OWNER_ASSIGNEE_ASSIGNMENT_ID = Schema.decodeSync(RoleAssignmentId)("01890f6f-6d6a-7cc0-98d2-100000000017")
const EVIDENCE_ID = Schema.decodeSync(EvidenceId)("01890f6f-6d6a-7cc0-98d2-100000000009")
const SECOND_EVIDENCE_ID = Schema.decodeSync(EvidenceId)("01890f6f-6d6a-7cc0-98d2-10000000000a")
const THIRD_EVIDENCE_ID = Schema.decodeSync(EvidenceId)("01890f6f-6d6a-7cc0-98d2-100000000010")
const RELATIONSHIP_ID = Schema.decodeSync(RelationshipId)("01890f6f-6d6a-7cc0-98d2-10000000000c")
const CLAIM_ID = "01890f6f-6d6a-7cc0-98d2-10000000000b"
const SUCCESSOR_CLAIM_ID = "01890f6f-6d6a-7cc0-98d2-10000000000d"
const CREATED_AT = "2026-07-15T10:00:00.000Z"
const UPDATED_AT = "2026-07-15T10:05:00.000Z"
const SOURCE_FIRST_AT = "2026-07-15T09:55:00.000Z"
const SOURCE_LAST_AT = "2026-07-15T09:58:00.000Z"
const SOURCE_URL = "https://jira.example/browse/PAY-42"
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
  readonly cached?: boolean
  readonly firstObservedAt?: string
  readonly lastObservedAt?: string
  readonly normalizationSchemaVersion?: number
  readonly providerId?: "jira" | "confluence"
  readonly pluginConnectionId?: typeof PLUGIN_ID | typeof OTHER_PLUGIN_ID
  readonly revision?: string
  readonly sourceUrl?: string | null
  readonly synchronizedAt?: string
  readonly vendorImmutableId: string
}) => {
  const sourceRevision = {
    providerId: input.providerId ?? "jira",
    pluginConnectionId: input.pluginConnectionId ?? PLUGIN_ID,
    vendorImmutableId: input.vendorImmutableId,
    revision: input.revision ?? "source-1",
    sourceUrl: input.sourceUrl === undefined ? SOURCE_URL : input.sourceUrl,
    firstObservedAt: input.firstObservedAt ?? SOURCE_FIRST_AT,
    lastObservedAt: input.lastObservedAt ?? SOURCE_LAST_AT,
    synchronizedAt: input.synchronizedAt ?? CREATED_AT,
    normalizationSchemaVersion: input.normalizationSchemaVersion ?? 1
  }
  return {
    _tag: "current",
    pluginHealth: { _tag: "healthy", checkedAt: CREATED_AT },
    provenance: input.cached
      ? { _tag: "cache", cachedAt: CREATED_AT, sourceRevision }
      : { _tag: "provider", sourceRevision },
    sourceObservedAt: sourceRevision.lastObservedAt,
    staleAfterSeconds: 300,
    synchronizedAt: CREATED_AT
  }
}

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
  yield* database.sql`INSERT INTO persons (
    workspace_id, person_id, display_name, avatar_json, is_active,
    revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_A}, ${OWNER_PERSON_ID}, 'Avery Bell',
    ${JSON.stringify({ _tag: "initials", text: "AB" })}, 1, 1, ${CREATED_AT}, ${CREATED_AT}
  )`
  yield* database.sql`INSERT INTO role_assignments (
    workspace_id, assignment_id, actor_kind, person_id, agent_id, role,
    scope_kind, release_id, environment_id, entity_id, lifecycle_kind,
    assigned_at, ended_at, revoked_at, revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_A}, ${OWNER_ASSIGNMENT_ID}, 'human', ${OWNER_PERSON_ID}, NULL, 'issue-owner',
    'entity', NULL, NULL, ${ISSUE_ID}, 'active',
    ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}
  ), (
    ${WORKSPACE_A}, ${OWNER_AUTHOR_ASSIGNMENT_ID}, 'human', ${OWNER_PERSON_ID}, NULL, 'author',
    'entity', NULL, NULL, ${ISSUE_ID}, 'active',
    ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}
  ), (
    ${WORKSPACE_A}, ${OWNER_OPERATOR_ASSIGNMENT_ID}, 'human', ${OWNER_PERSON_ID}, NULL, 'operator',
    'entity', NULL, NULL, ${ISSUE_ID}, 'active',
    ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}
  ), (
    ${WORKSPACE_A}, ${OWNER_ASSIGNEE_ASSIGNMENT_ID}, 'human', ${OWNER_PERSON_ID}, NULL, 'issue-assignee',
    'entity', NULL, NULL, ${ISSUE_ID}, 'active',
    ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}
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
      ${WORKSPACE_A}, ${entityId}, 1, 'source-1', 1,
      ${entityId === ISSUE_ID ? SOURCE_URL : "https://jira.example/pipelines/legacy"},
      ${SOURCE_FIRST_AT}, ${SOURCE_LAST_AT}, ${CREATED_AT}, ${CREATED_AT}
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
      status: "Ready-for-review",
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
      lifecycle: index === 1
        ? { _tag: "proposed", effectiveAt: CREATED_AT }
        : { _tag: "verified", effectiveAt: CREATED_AT },
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
  it("bounds the complete release closure at 250 of 251 disjoint relationships", () => {
    const relationships = Array.from({ length: 251 }, (_, index) => ({
      sourceNodeId: `source-${index}`,
      targetNodeId: `target-${index}`,
      evidenceClaimIds: []
    }))

    const exactBoundary = selectBoundedRelationshipClosure(relationships.slice(0, 250), {
      relationships: 500,
      nodes: 500,
      evidenceClaims: 500
    })
    assert.lengthOf(exactBoundary.relationships, 250)
    assert.isFalse(exactBoundary.truncated)

    const overflow = selectBoundedRelationshipClosure(relationships, {
      relationships: 500,
      nodes: 500,
      evidenceClaims: 500
    })
    assert.lengthOf(overflow.relationships, 250)
    assert.isTrue(overflow.truncated)
    assert.lengthOf(
      new Set(overflow.relationships.flatMap(({ sourceNodeId, targetNodeId }) => [
        sourceNodeId,
        targetNodeId
      ])),
      500
    )

    const claimHeavy = selectBoundedRelationshipClosure(
      Array.from({ length: 5 }, (_, relationshipIndex) => ({
        sourceNodeId: "shared-source",
        targetNodeId: "shared-target",
        evidenceClaimIds: Array.from(
          { length: 128 },
          (_, claimIndex) => `claim-${relationshipIndex}-${claimIndex}`
        )
      })),
      { relationships: 500, nodes: 500, evidenceClaims: 500 }
    )
    assert.lengthOf(claimHeavy.relationships, 3)
    assert.lengthOf(new Set(claimHeavy.relationships.flatMap(({ evidenceClaimIds }) => evidenceClaimIds)), 384)
    assert.isTrue(claimHeavy.truncated)

    const exactClaimBoundary = selectBoundedRelationshipClosure(
      Array.from({ length: 4 }, (_, relationshipIndex) => ({
        sourceNodeId: "shared-source",
        targetNodeId: "shared-target",
        evidenceClaimIds: Array.from(
          { length: 125 },
          (_, claimIndex) => `boundary-claim-${relationshipIndex}-${claimIndex}`
        )
      })),
      { relationships: 500, nodes: 500, evidenceClaims: 500 }
    )
    assert.lengthOf(exactClaimBoundary.relationships, 4)
    assert.lengthOf(
      new Set(exactClaimBoundary.relationships.flatMap(({ evidenceClaimIds }) => evidenceClaimIds)),
      500
    )
    assert.isFalse(exactClaimBoundary.truncated)

    const rootOverflow = selectBoundedRelationshipClosure(
      Array.from({ length: 501 }, (_, index) => ({
        sourceNodeId: "shared-source",
        targetNodeId: "shared-target",
        evidenceClaimIds: [`shared-claim-${index % 500}`]
      })),
      { relationships: 500, nodes: 500, evidenceClaims: 500 }
    )
    assert.lengthOf(rootOverflow.relationships, 500)
    assert.isTrue(rootOverflow.truncated)

    const rootBoundary = selectBoundedRelationshipClosure(
      Array.from({ length: 500 }, (_, index) => ({
        sourceNodeId: "shared-source",
        targetNodeId: "shared-target",
        evidenceClaimIds: [`boundary-root-claim-${index}`]
      })),
      { relationships: 500, nodes: 500, evidenceClaims: 500 }
    )
    assert.lengthOf(rootBoundary.relationships, 500)
    assert.isFalse(rootBoundary.truncated)
  })

  it.effect("bounds evidence claim inspection at the repository query", () =>
    withRepository(Effect.gen(function*() {
      yield* insertFoundation
      const repository = yield* DeliveryGraphRepository
      yield* repository.write(WORKSPACE_A, initialBatch)
      yield* repository.write(WORKSPACE_A, {
        entityProjections: [],
        nodes: [],
        evidenceItems: [],
        evidenceClaims: [{
          ...initialBatch.evidenceClaims[0],
          evidenceClaimId: SUCCESSOR_CLAIM_ID,
          value: { _tag: "flag", value: true },
          supersedesEvidenceClaimId: CLAIM_ID,
          recordedAt: UPDATED_AT
        }],
        relationships: []
      })

      const bounded = yield* repository.read(WORKSPACE_A, {
        _tag: "evidence",
        evidenceId: EVIDENCE_ID,
        limit: 1
      })
      assert.strictEqual(bounded._tag, "evidence")
      if (bounded._tag === "evidence") {
        assert.lengthOf(bounded.value.claims, 1)
        assert.strictEqual(bounded.value.claims[0]?.evidenceClaimId, CLAIM_ID)
      }
    })))

  it.effect("bounds derived release closure before loading 502 disjoint nodes", () =>
    withRepository(Effect.gen(function*() {
      yield* insertFoundation
      const repository = yield* DeliveryGraphRepository
      const nodes = Array.from({ length: 502 }, (_, index) => ({
        workspaceId: WORKSPACE_A,
        nodeId: `01890f6f-6d6a-7cc0-98e0-${index.toString(16).padStart(12, "0")}`,
        endpointKind: "issue",
        resolution: {
          _tag: "missing",
          expectedKind: "entity",
          expectedEntityKind: "issue",
          missingKey: `overflow-issue-${index}`
        },
        createdAt: CREATED_AT
      }))
      yield* repository.write(WORKSPACE_A, {
        entityProjections: [],
        nodes: nodes.slice(0, 500),
        evidenceItems: [],
        evidenceClaims: [],
        relationships: []
      })
      yield* repository.write(WORKSPACE_A, {
        entityProjections: [],
        nodes: nodes.slice(500),
        evidenceItems: [],
        evidenceClaims: [],
        relationships: Array.from({ length: 251 }, (_, index) => ({
          workspaceId: WORKSPACE_A,
          relationshipId: `01890f6f-6d6a-7cc0-98e1-${index.toString(16).padStart(12, "0")}`,
          relationshipSchemaVersion: 1,
          revision: 1,
          supersedesRevision: null,
          kind: "depends-on",
          sourceNodeId: nodes[index * 2]?.nodeId,
          sourceNodeKind: "issue",
          targetNodeId: nodes[index * 2 + 1]?.nodeId,
          targetNodeKind: "issue",
          scope: { _tag: "release", releaseId: RELEASE_ID },
          lifecycle: { _tag: "proposed", effectiveAt: CREATED_AT },
          confidence: { _tag: "unknown", rationale: "Generated closure overflow fixture." },
          provenance: {
            _tag: "rule",
            ruleId: "closure-overflow-fixture",
            ruleVersion: 1,
            rationale: "Generated relationship exercises aggregate read bounds."
          },
          recordedBy: { _tag: "system", component: "delivery-graph-fixture" },
          evidenceClaimIds: [],
          recordedAt: CREATED_AT
        }))
      })

      const slice = yield* repository.read(WORKSPACE_A, {
        _tag: "releaseSlice",
        releaseId: RELEASE_ID,
        environmentId: null,
        limit: 500
      })
      assert.strictEqual(slice._tag, "releaseSlice")
      if (slice._tag === "releaseSlice") {
        assert.lengthOf(slice.value.relationships, 250)
        assert.lengthOf(slice.value.nodes, 500)
        assert.isTrue(slice.value.truncated)
        assert.doesNotThrow(() => Schema.encodeSync(ReleaseDeliveryGraphInspection)(slice.value))
      }
    })))

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
          assert.isFalse(slice.value.truncated)
          assert.doesNotThrow(() => Schema.encodeSync(ReleaseDeliveryGraphInspection)(slice.value))
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

        const summary = yield* repository.read(WORKSPACE_A, {
          _tag: "releaseSummary",
          releaseId: RELEASE_ID
        })
        assert.strictEqual(summary._tag, "releaseSummary")
        if (summary._tag === "releaseSummary") {
          assert.deepStrictEqual(summary.value, {
            issues: 6,
            pipelineExecutions: 1,
            pullRequests: 2
          })
        }

        const retiredRelationship = sixIssueBatch.relationships[0]
        if (retiredRelationship === undefined) {
          return yield* Effect.die("Expected release relationship fixture")
        }
        yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: [{
            ...retiredRelationship,
            revision: 2,
            supersedesRevision: 1,
            lifecycle: {
              _tag: "superseded",
              effectiveAt: UPDATED_AT,
              reason: "Release membership no longer applies."
            },
            recordedAt: UPDATED_AT
          }]
        })
        const summaryWithoutRetiredRelationship = yield* repository.read(WORKSPACE_A, {
          _tag: "releaseSummary",
          releaseId: RELEASE_ID
        })
        assert.strictEqual(summaryWithoutRetiredRelationship._tag, "releaseSummary")
        if (summaryWithoutRetiredRelationship._tag === "releaseSummary") {
          assert.deepStrictEqual(summaryWithoutRetiredRelationship.value, {
            issues: 5,
            pipelineExecutions: 1,
            pullRequests: 2
          })
        }

        const bounded = yield* repository.read(WORKSPACE_A, {
          _tag: "releaseSlice",
          releaseId: RELEASE_ID,
          environmentId: null,
          limit: 1
        })
        assert.strictEqual(bounded._tag, "releaseSlice")
        if (bounded._tag === "releaseSlice") {
          assert.isTrue(bounded.value.truncated)
          assert.lengthOf(bounded.value.relationships, 1)
          assert.isAtMost(bounded.value.nodes.length, 500)
          assert.isAtMost(bounded.value.evidenceClaims.length, 500)
          assert.doesNotThrow(() => Schema.encodeSync(ReleaseDeliveryGraphInspection)(bounded.value))
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

        const synchronized = yield* repository.read(WORKSPACE_A, {
          _tag: "sourceEntityProjection",
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          vendorImmutableId: VendorImmutableId.make("PAY-42"),
          revision: Revision.make("source-1")
        })
        assert.strictEqual(synchronized._tag, "sourceEntityProjection")
        if (synchronized._tag === "sourceEntityProjection") {
          assert.strictEqual(synchronized.value.sourceRevision, "source-1")
          assert.strictEqual(synchronized.value.projection.entityId, ISSUE_ID)
        }
        const mismatchedRevision = yield* repository.read(WORKSPACE_A, {
          _tag: "sourceEntityProjection",
          pluginConnectionId: PLUGIN_ID,
          providerId: "jira",
          vendorImmutableId: VendorImmutableId.make("PAY-42"),
          revision: Revision.make("source-2")
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatchedRevision))
        if (Result.isFailure(mismatchedRevision)) {
          assert.instanceOf(mismatchedRevision.failure, RecordNotFoundError)
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

  it.effect("reads one exact bounded entity slice without crossing workspace boundaries", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        yield* repository.write(WORKSPACE_A, initialBatch)
        yield* database.sql`UPDATE entities
          SET plugin_connection_id = ${OTHER_PLUGIN_ID}, provider_id = 'confluence'
          WHERE workspace_id = ${WORKSPACE_A} AND entity_id = ${ISSUE_ID}`
        yield* Effect.forEach(
          Array.from({ length: 16 }, (_, index) => `jira-account-${String(index).padStart(2, "0")}`),
          (vendorPersonId) =>
            database.sql`INSERT INTO person_identities (
              workspace_id, person_id, plugin_connection_id, provider_id, vendor_person_id, created_at
            ) VALUES (
              ${WORKSPACE_A}, ${OWNER_PERSON_ID}, ${PLUGIN_ID}, 'jira', ${vendorPersonId}, ${CREATED_AT}
            )`,
          { discard: true }
        )
        yield* database.sql`INSERT INTO person_identities (
            workspace_id, person_id, plugin_connection_id, provider_id, vendor_person_id, created_at
          ) VALUES (
            ${WORKSPACE_A}, ${OWNER_PERSON_ID}, ${OTHER_PLUGIN_ID}, 'confluence', 'account-avery', ${CREATED_AT}
          )`
        yield* Effect.forEach(
          NOISE_CONFLUENCE_PLUGIN_IDS,
          (pluginConnectionId, index) =>
            Effect.gen(function*() {
              yield* database.sql`INSERT INTO plugin_connections (
                  workspace_id, plugin_connection_id, provider_id, display_name,
                  revision, is_enabled, created_at, updated_at
                ) VALUES (
                  ${WORKSPACE_A}, ${pluginConnectionId}, 'confluence',
                  ${`Noise Confluence ${String(index)}`}, 1, 1, ${CREATED_AT}, ${CREATED_AT}
                )`
              yield* database.sql`INSERT INTO person_identities (
                  workspace_id, person_id, plugin_connection_id, provider_id, vendor_person_id, created_at
                ) VALUES (
                  ${WORKSPACE_A}, ${OWNER_PERSON_ID}, ${pluginConnectionId}, 'confluence',
                  ${`noise-account-${String(index).padStart(2, "0")}`}, ${CREATED_AT}
                )`
            }),
          { discard: true }
        )

        const firstRelationship = initialBatch.relationships[0]
        if (firstRelationship === undefined) return yield* Effect.die("Expected relationship fixture")
        yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [{
            workspaceId: WORKSPACE_A,
            nodeId: OTHER_RELEASE_NODE_ID,
            endpointKind: "release",
            resolution: { _tag: "resolved", target: { _tag: "release", releaseId: OTHER_RELEASE_ID } },
            createdAt: UPDATED_AT
          }],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: [{
            ...firstRelationship,
            relationshipId: OTHER_RELATIONSHIP_ID,
            revision: 1,
            supersedesRevision: null,
            sourceNodeId: OTHER_RELEASE_NODE_ID,
            scope: { _tag: "release", releaseId: OTHER_RELEASE_ID },
            confidence: { _tag: "unknown", rationale: "Independent release association fixture." },
            evidenceClaimIds: [],
            recordedAt: UPDATED_AT
          }]
        })

        const bounded = yield* repository.read(WORKSPACE_A, {
          _tag: "entitySlice",
          entityId: ISSUE_ID,
          limit: 1
        })
        assert.strictEqual(bounded._tag, "entitySlice")
        if (bounded._tag === "entitySlice") {
          assert.strictEqual(bounded.value.entity.projection.entityId, ISSUE_ID)
          assert.deepStrictEqual(bounded.value.entity.releaseIds, [RELEASE_ID, OTHER_RELEASE_ID].sort())
          assert.lengthOf(bounded.value.entity.owners, 1)
          const owner = bounded.value.entity.owners[0]
          assert.isDefined(owner)
          assert.strictEqual(owner?.avatarFallback, "AB")
          assert.strictEqual(owner?.displayName, "Avery Bell")
          assert.strictEqual(owner?.personId, OWNER_PERSON_ID)
          assert.deepStrictEqual(owner?.roles, ["author", "issue-assignee", "issue-owner", "operator"])
          const sourceIdentities = owner?.sourceIdentities ?? []
          assert.lengthOf(sourceIdentities, 1)
          assert.deepStrictEqual(sourceIdentities[0], {
            pluginConnectionId: OTHER_PLUGIN_ID,
            providerId: "confluence",
            vendorPersonId: VendorImmutableId.make("account-avery")
          })
          assert.isTrue(sourceIdentities.every(({ providerId }) => providerId === "confluence"))
          assert.lengthOf(bounded.value.relationships, 1)
          assert.isTrue(bounded.value.truncated)
        }

        const crossedWorkspace = yield* repository.read(WORKSPACE_B, {
          _tag: "entitySlice",
          entityId: ISSUE_ID,
          limit: 100
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(crossedWorkspace))
        if (Result.isFailure(crossedWorkspace)) {
          assert.instanceOf(crossedWorkspace.failure, RecordNotFoundError)
        }
      })
    ))

  it.effect("does not expose Confluence owner identities for a Jira entity", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        yield* repository.write(WORKSPACE_A, initialBatch)
        yield* database.sql`INSERT INTO person_identities (
            workspace_id, person_id, plugin_connection_id, provider_id, vendor_person_id, created_at
          ) VALUES (
            ${WORKSPACE_A}, ${OWNER_PERSON_ID}, ${OTHER_PLUGIN_ID}, 'confluence', 'account-avery', ${CREATED_AT}
          )`

        const result = yield* repository.read(WORKSPACE_A, {
          _tag: "entitySlice",
          entityId: ISSUE_ID,
          limit: 100
        })
        assert.strictEqual(result._tag, "entitySlice")
        if (result._tag === "entitySlice") {
          assert.isUndefined(result.value.entity.owners[0]?.sourceIdentities)
        }
      })
    ))

  it.effect("hydrates an exact Clockify identity for a Clockify entity owner", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        yield* repository.write(WORKSPACE_A, initialBatch)
        yield* database.sql`INSERT INTO plugin_connections (
            workspace_id, plugin_connection_id, provider_id, display_name,
            revision, is_enabled, created_at, updated_at
          ) VALUES (
            ${WORKSPACE_A}, ${CLOCKIFY_PLUGIN_ID}, 'clockify', 'Payments Clockify',
            1, 1, ${CREATED_AT}, ${CREATED_AT}
          )`
        yield* database.sql`UPDATE entities
          SET plugin_connection_id = ${CLOCKIFY_PLUGIN_ID}, provider_id = 'clockify'
          WHERE workspace_id = ${WORKSPACE_A} AND entity_id = ${ISSUE_ID}`
        yield* database.sql`INSERT INTO person_identities (
            workspace_id, person_id, plugin_connection_id, provider_id, vendor_person_id, created_at
          ) VALUES (
            ${WORKSPACE_A}, ${OWNER_PERSON_ID}, ${CLOCKIFY_PLUGIN_ID}, 'clockify',
            'clockify-user-avery', ${CREATED_AT}
          )`

        const result = yield* repository.read(WORKSPACE_A, {
          _tag: "entitySlice",
          entityId: ISSUE_ID,
          limit: 100
        })
        assert.strictEqual(result._tag, "entitySlice")
        if (result._tag === "entitySlice") {
          assert.deepStrictEqual(result.value.entity.owners[0]?.sourceIdentities, [{
            pluginConnectionId: CLOCKIFY_PLUGIN_ID,
            providerId: "clockify",
            vendorPersonId: VendorImmutableId.make("clockify-user-avery")
          }])
        }
      })
    ))

  it.effect("quarantines malformed Confluence owner source identities", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        const quarantine = yield* QuarantineRepository
        yield* repository.write(WORKSPACE_A, initialBatch)
        yield* database.sql`UPDATE entities
          SET plugin_connection_id = ${OTHER_PLUGIN_ID}, provider_id = 'confluence'
          WHERE workspace_id = ${WORKSPACE_A} AND entity_id = ${ISSUE_ID}`
        yield* database.sql`PRAGMA ignore_check_constraints = ON`
        yield* database.sql`INSERT INTO person_identities (
            workspace_id, person_id, plugin_connection_id, provider_id, vendor_person_id, created_at
          ) VALUES (
            ${WORKSPACE_A}, ${OWNER_PERSON_ID}, ${OTHER_PLUGIN_ID}, 'confluence',
            ' account-avery ', ${CREATED_AT}
          )`
        yield* database.sql`PRAGMA ignore_check_constraints = OFF`

        const result = yield* repository.read(WORKSPACE_A, {
          _tag: "entitySlice",
          entityId: ISSUE_ID,
          limit: 100
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, PersistedRecordError)
          assert.deepInclude(result.failure, {
            recordKind: "person",
            recordKey: OWNER_PERSON_ID,
            diagnosticCode: "person-schema-invalid"
          })
        }
        const records = yield* quarantine.list(WORKSPACE_A)
        assert.deepInclude(records.find(({ recordKind }) => recordKind === "person"), {
          recordKind: "person",
          recordKey: OWNER_PERSON_ID,
          diagnosticCode: "person-schema-invalid"
        })
      })
    ))

  it.effect("redacts page bodies in repository summaries while retaining exact entity content", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        yield* repository.write(WORKSPACE_A, initialBatch)
        yield* database.sql`UPDATE entities
          SET plugin_connection_id = ${OTHER_PLUGIN_ID}, provider_id = 'confluence', entity_type = 'page'
          WHERE workspace_id = ${WORKSPACE_A} AND entity_id = ${ISSUE_ID}`

        const sentinel = "repository-page-body-sentinel"
        yield* repository.write(WORKSPACE_A, {
          entityProjections: [{
            projection: {
              workspaceId: WORKSPACE_A,
              entityId: ISSUE_ID,
              projectionRevision: 2,
              sourceEntityRevision: 1,
              supersedesProjectionRevision: 1,
              projectionSchemaVersion: 1,
              entityState: "present",
              entityType: "page",
              displayKey: "DOC-42",
              title: "Release runbook",
              details: {
                _tag: "page",
                spaceKey: "PAY",
                revision: "2",
                status: "current",
                content: { representation: "safe-markdown", markdown: sentinel },
                contentState: "loaded"
              }
            },
            recordedAt: UPDATED_AT
          }],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: []
        })

        const workspace = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: null,
          query: null,
          service: null,
          status: null,
          type: null,
          limit: 500
        })
        assert.strictEqual(workspace._tag, "workspaceEntityProjections")
        if (workspace._tag === "workspaceEntityProjections") {
          const page = workspace.value.items.find(({ projection }) => projection.entityId === ISSUE_ID)?.projection
          assert.strictEqual(page?.details._tag, "page")
          if (page?.details._tag === "page") {
            assert.isNull(page.details.content)
            assert.strictEqual(page.details.contentState, "lazy")
          }
        }

        const release = yield* repository.read(WORKSPACE_A, {
          _tag: "releaseSlice",
          releaseId: RELEASE_ID,
          environmentId: null,
          limit: 100
        })
        assert.strictEqual(release._tag, "releaseSlice")
        if (release._tag === "releaseSlice") {
          const page = release.value.entityProjections.find(({ projection }) => projection.entityId === ISSUE_ID)
            ?.projection
          assert.strictEqual(page?.details._tag, "page")
          if (page?.details._tag === "page") {
            assert.isNull(page.details.content)
            assert.strictEqual(page.details.contentState, "lazy")
          }
        }

        const exact = yield* repository.read(WORKSPACE_A, {
          _tag: "entitySlice",
          entityId: ISSUE_ID,
          limit: 100
        })
        assert.strictEqual(exact._tag, "entitySlice")
        if (exact._tag === "entitySlice" && exact.value.entity.projection.details._tag === "page") {
          assert.strictEqual(exact.value.entity.projection.details.content?.markdown, sentinel)
          assert.strictEqual(exact.value.entity.projection.details.contentState, "loaded")
        }

        yield* database.sql`DROP TRIGGER entity_projection_revisions_no_update`
        yield* database.sql`UPDATE entity_projection_revisions
          SET extension_json = json_set(extension_json, '$.status', 'draft')
          WHERE workspace_id = ${WORKSPACE_A}
            AND entity_id = ${ISSUE_ID}
            AND projection_revision = 2`

        const corruptedWorkspace = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: null,
          query: null,
          service: null,
          status: null,
          type: null,
          limit: 500
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(corruptedWorkspace))
        if (Result.isFailure(corruptedWorkspace)) {
          assert.instanceOf(corruptedWorkspace.failure, PersistedRecordError)
        }

        const corruptedRelease = yield* repository.read(WORKSPACE_A, {
          _tag: "releaseSlice",
          releaseId: RELEASE_ID,
          environmentId: null,
          limit: 100
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(corruptedRelease))
        if (Result.isFailure(corruptedRelease)) {
          assert.instanceOf(corruptedRelease.failure, PersistedRecordError)
        }

        yield* database.sql`UPDATE entity_projection_revisions
          SET extension_json = 'not-json'
          WHERE workspace_id = ${WORKSPACE_A}
            AND entity_id = ${ISSUE_ID}
            AND projection_revision = 2`
        const malformedWorkspace = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: null,
          query: null,
          service: null,
          status: null,
          type: null,
          limit: 500
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(malformedWorkspace))
        if (Result.isFailure(malformedWorkspace)) {
          assert.instanceOf(malformedWorkspace.failure, PersistedRecordError)
        }
      })
    ))

  it.effect("indexes current present workspace projections including unlinked entities and excluding deleted heads", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        yield* repository.write(WORKSPACE_A, initialBatch)
        const excludedAssignmentPersonId = Schema.decodeSync(PersonId)(
          "01890f6f-6d6a-7cc0-98d2-300000000010"
        )
        const inactivePersonId = Schema.decodeSync(PersonId)(
          "01890f6f-6d6a-7cc0-98d2-300000000011"
        )
        yield* database.sql`INSERT INTO persons (
          workspace_id, person_id, display_name, avatar_json, is_active,
          revision, created_at, updated_at
        ) VALUES
          (${WORKSPACE_A}, ${excludedAssignmentPersonId}, 'Excluded Assignment',
            ${JSON.stringify({ _tag: "initials", text: "EA" })}, 1, 1, ${CREATED_AT}, ${UPDATED_AT}),
          (${WORKSPACE_A}, ${inactivePersonId}, 'Inactive Person',
            ${JSON.stringify({ _tag: "initials", text: "IP" })}, 0, 1, ${CREATED_AT}, ${UPDATED_AT})`
        yield* database.sql`INSERT INTO role_assignments (
          workspace_id, assignment_id, actor_kind, person_id, agent_id, role,
          scope_kind, release_id, environment_id, entity_id, lifecycle_kind,
          assigned_at, ended_at, revoked_at, revision, created_at, updated_at
        ) VALUES
          (${WORKSPACE_A}, '01890f6f-6d6a-7cc0-98d2-300000000001', 'human', ${OWNER_PERSON_ID}, NULL,
            'contributor', 'entity', NULL, NULL, ${ISSUE_ID}, 'active',
            ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}),
          (${WORKSPACE_A}, '01890f6f-6d6a-7cc0-98d2-300000000002', 'human', ${OWNER_PERSON_ID}, NULL,
            'reviewer', 'entity', NULL, NULL, ${ISSUE_ID}, 'active',
            ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}),
          (${WORKSPACE_A}, '01890f6f-6d6a-7cc0-98d2-300000000003', 'human', ${OWNER_PERSON_ID}, NULL,
            'watcher', 'entity', NULL, NULL, ${ISSUE_ID}, 'active',
            ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}),
          (${WORKSPACE_A}, '01890f6f-6d6a-7cc0-98d2-300000000004', 'human', ${OWNER_PERSON_ID}, NULL,
            'deployment-approver', 'entity', NULL, NULL, ${ISSUE_ID}, 'active',
            ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}),
          (${WORKSPACE_A}, '01890f6f-6d6a-7cc0-98d2-300000000005', 'human', ${OWNER_PERSON_ID}, NULL,
            'merge-approver', 'entity', NULL, NULL, ${ISSUE_ID}, 'active',
            ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}),
          (${WORKSPACE_A}, '01890f6f-6d6a-7cc0-98d2-300000000006', 'human', ${OWNER_PERSON_ID}, NULL,
            'workspace-owner', 'entity', NULL, NULL, ${ISSUE_ID}, 'active',
            ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}),
          (${WORKSPACE_A}, '01890f6f-6d6a-7cc0-98d2-300000000007', 'human', ${excludedAssignmentPersonId}, NULL,
            'contributor', 'entity', NULL, NULL, ${ISSUE_ID}, 'ended',
            ${CREATED_AT}, ${UPDATED_AT}, NULL, 1, ${CREATED_AT}, ${UPDATED_AT}),
          (${WORKSPACE_A}, '01890f6f-6d6a-7cc0-98d2-300000000008', 'human', ${excludedAssignmentPersonId}, NULL,
            'reviewer', 'release', ${RELEASE_ID}, NULL, NULL, 'active',
            ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}),
          (${WORKSPACE_A}, '01890f6f-6d6a-7cc0-98d2-300000000009', 'human', ${inactivePersonId}, NULL,
            'watcher', 'entity', NULL, NULL, ${ISSUE_ID}, 'active',
            ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT})`

        const bounded = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: null,
          query: null,
          service: null,
          status: null,
          type: null,
          limit: 1
        })
        assert.strictEqual(bounded._tag, "workspaceEntityProjections")
        if (bounded._tag === "workspaceEntityProjections") {
          assert.isTrue(bounded.value.truncated)
          assert.strictEqual(bounded.value.matchedCount, 2)
          assert.strictEqual(bounded.value.totalCount, 2)
          assert.lengthOf(bounded.value.items, 1)
          assert.strictEqual(bounded.value.items[0]?.canonicalReleaseId, RELEASE_ID)
          assert.deepStrictEqual(bounded.value.items[0]?.releaseIds, [RELEASE_ID])
          assert.deepStrictEqual(bounded.value.items[0]?.owners, [{
            avatarFallback: "AB",
            displayName: "Avery Bell",
            personId: OWNER_PERSON_ID,
            roles: [
              "author",
              "contributor",
              "deployment-approver",
              "issue-assignee",
              "issue-owner",
              "merge-approver",
              "operator",
              "reviewer",
              "watcher"
            ]
          }])
          assert.isFalse(bounded.value.items[0]?.ownersTruncated)
          assert.deepStrictEqual(bounded.value.ownerOptions, [{
            avatarFallback: "AB",
            displayName: "Avery Bell",
            personId: OWNER_PERSON_ID,
            roles: [
              "author",
              "contributor",
              "deployment-approver",
              "issue-assignee",
              "issue-owner",
              "merge-approver",
              "operator",
              "reviewer",
              "watcher"
            ]
          }])
          assert.isFalse(bounded.value.ownerOptionsTruncated)
        }

        const current = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: null,
          query: null,
          service: null,
          status: null,
          type: null,
          limit: 500
        })
        assert.strictEqual(current._tag, "workspaceEntityProjections")
        if (current._tag === "workspaceEntityProjections") {
          assert.isFalse(current.value.truncated)
          assert.lengthOf(current.value.items, 2)
          assert.isNull(
            current.value.items.find(({ projection }) => projection.entityId === PIPELINE_ID)?.canonicalReleaseId
          )
          assert.deepStrictEqual(
            current.value.items.find(({ projection }) => projection.entityId === PIPELINE_ID)?.releaseIds,
            []
          )
          assert.deepStrictEqual(
            current.value.items.find(({ projection }) => projection.entityId === PIPELINE_ID)?.owners,
            []
          )
        }

        const owned = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: OWNER_PERSON_ID,
          query: null,
          service: null,
          status: null,
          type: null,
          limit: 500
        })
        assert.strictEqual(owned._tag, "workspaceEntityProjections")
        if (owned._tag === "workspaceEntityProjections") {
          assert.strictEqual(owned.value.matchedCount, 1)
          assert.strictEqual(owned.value.totalCount, 2)
          assert.deepStrictEqual(
            owned.value.items.map(({ projection }) => projection.entityId),
            [ISSUE_ID]
          )
        }

        const filtered = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: null,
          query: "main pipeline",
          service: "codepipeline",
          status: "done",
          type: "pipeline-execution",
          limit: 500
        })
        assert.strictEqual(filtered._tag, "workspaceEntityProjections")
        if (filtered._tag === "workspaceEntityProjections") {
          assert.isFalse(filtered.value.truncated)
          assert.strictEqual(filtered.value.matchedCount, 1)
          assert.strictEqual(filtered.value.totalCount, 2)
          assert.deepStrictEqual(filtered.value.ownerOptions.map(({ personId }) => personId), [OWNER_PERSON_ID])
          assert.deepStrictEqual(
            filtered.value.items.map(({ projection }) => projection.entityId),
            [PIPELINE_ID]
          )
        }

        const jiraStatusSearch = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: OWNER_PERSON_ID,
          query: "Ready-for-review",
          service: "jira",
          status: "active",
          type: "issue",
          limit: 500
        })
        assert.strictEqual(jiraStatusSearch._tag, "workspaceEntityProjections")
        if (jiraStatusSearch._tag === "workspaceEntityProjections") {
          assert.strictEqual(jiraStatusSearch.value.matchedCount, 1)
          assert.deepStrictEqual(
            jiraStatusSearch.value.items.map(({ projection }) => projection.entityId),
            [ISSUE_ID]
          )
        }

        const overflowOwners = Array.from({ length: 20 }, (_, index) => {
          const suffix = String(index + 1).padStart(2, "0")
          return {
            assignmentId: Schema.decodeSync(RoleAssignmentId)(
              `01890f6f-6d6a-7cc0-98d2-2000000001${suffix}`
            ),
            avatarFallback: `Z${suffix}`,
            displayName: `Zed Owner ${suffix}`,
            personId: Schema.decodeSync(PersonId)(`01890f6f-6d6a-7cc0-98d2-1000000001${suffix}`)
          }
        })
        yield* Effect.forEach(
          overflowOwners,
          ({ assignmentId, avatarFallback, displayName, personId }) =>
            Effect.gen(function*() {
              yield* database.sql`INSERT INTO persons (
              workspace_id, person_id, display_name, avatar_json, is_active,
              revision, created_at, updated_at
            ) VALUES (
              ${WORKSPACE_A}, ${personId}, ${displayName},
              ${JSON.stringify({ _tag: "initials", text: avatarFallback })}, 1, 1, ${CREATED_AT}, ${CREATED_AT}
            )`
              yield* database.sql`INSERT INTO role_assignments (
              workspace_id, assignment_id, actor_kind, person_id, agent_id, role,
              scope_kind, release_id, environment_id, entity_id, lifecycle_kind,
              assigned_at, ended_at, revoked_at, revision, created_at, updated_at
            ) VALUES (
              ${WORKSPACE_A}, ${assignmentId}, 'human', ${personId}, NULL, 'issue-owner',
              'entity', NULL, NULL, ${ISSUE_ID}, 'active',
              ${CREATED_AT}, NULL, NULL, 1, ${CREATED_AT}, ${CREATED_AT}
            )`
            })
        )
        const selectedOverflowOwner = overflowOwners.at(-1)
        if (selectedOverflowOwner === undefined) return yield* Effect.die("Expected bounded owner fixture")
        const selectedBoundedOwners = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: selectedOverflowOwner.personId,
          query: null,
          service: null,
          status: null,
          type: null,
          limit: 500
        })
        assert.strictEqual(selectedBoundedOwners._tag, "workspaceEntityProjections")
        if (selectedBoundedOwners._tag === "workspaceEntityProjections") {
          assert.lengthOf(selectedBoundedOwners.value.items[0]?.owners ?? [], 20)
          assert.strictEqual(
            selectedBoundedOwners.value.items[0]?.owners[0]?.personId,
            selectedOverflowOwner.personId
          )
          assert.isTrue(selectedBoundedOwners.value.items[0]?.ownersTruncated)
        }

        const firstRelationship = initialBatch.relationships[0]
        if (firstRelationship === undefined) return yield* Effect.die("Expected relationship fixture")
        yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [{
            workspaceId: WORKSPACE_A,
            nodeId: OTHER_RELEASE_NODE_ID,
            endpointKind: "release",
            resolution: { _tag: "resolved", target: { _tag: "release", releaseId: OTHER_RELEASE_ID } },
            createdAt: UPDATED_AT
          }],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: [{
            ...firstRelationship,
            relationshipId: OTHER_RELATIONSHIP_ID,
            revision: 1,
            supersedesRevision: null,
            sourceNodeId: OTHER_RELEASE_NODE_ID,
            scope: { _tag: "release", releaseId: OTHER_RELEASE_ID },
            confidence: { _tag: "unknown", rationale: "Independent release association fixture." },
            evidenceClaimIds: [],
            recordedAt: UPDATED_AT
          }]
        })
        const multipleAssociations = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: null,
          query: null,
          service: null,
          status: null,
          type: null,
          limit: 500
        })
        assert.strictEqual(multipleAssociations._tag, "workspaceEntityProjections")
        if (multipleAssociations._tag === "workspaceEntityProjections") {
          const issue = multipleAssociations.value.items.find(
            ({ projection }) => projection.entityId === ISSUE_ID
          )
          assert.deepStrictEqual(issue?.releaseIds, [RELEASE_ID, OTHER_RELEASE_ID].sort())
          assert.strictEqual(issue?.canonicalReleaseId, [RELEASE_ID, OTHER_RELEASE_ID].sort()[0])
          assert.isFalse(issue?.releaseMembershipsTruncated)
        }

        yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: [{
            ...firstRelationship,
            revision: 2,
            supersedesRevision: 1,
            lifecycle: { _tag: "rejected", effectiveAt: UPDATED_AT, reason: "Incorrect release association." },
            recordedAt: UPDATED_AT
          }]
        })
        const activeAssociation = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: null,
          query: null,
          service: null,
          status: null,
          type: null,
          limit: 500
        })
        assert.strictEqual(activeAssociation._tag, "workspaceEntityProjections")
        if (activeAssociation._tag === "workspaceEntityProjections") {
          assert.strictEqual(
            activeAssociation.value.items.find(({ projection }) => projection.entityId === ISSUE_ID)
              ?.canonicalReleaseId,
            OTHER_RELEASE_ID
          )
          assert.deepStrictEqual(
            activeAssociation.value.items.find(({ projection }) => projection.entityId === ISSUE_ID)?.releaseIds,
            [OTHER_RELEASE_ID]
          )
        }

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
              entityState: "deleted"
            },
            recordedAt: UPDATED_AT
          }],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: []
        })

        const afterDeletion = yield* repository.read(WORKSPACE_A, {
          _tag: "workspaceEntityProjections",
          owner: null,
          query: null,
          service: null,
          status: null,
          type: null,
          limit: 500
        })
        assert.strictEqual(afterDeletion._tag, "workspaceEntityProjections")
        if (afterDeletion._tag === "workspaceEntityProjections") {
          assert.deepStrictEqual(
            afterDeletion.value.items.map(({ projection }) => projection.entityId),
            [PIPELINE_ID]
          )
          assert.deepStrictEqual(afterDeletion.value.items[0]?.releaseIds, [])
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

        const invalidSourceRevisions = [
          {
            field: "providerId",
            freshness: pluginFreshnessFor({
              providerId: "confluence",
              vendorImmutableId: "PAY-42"
            })
          },
          {
            field: "pluginConnectionId",
            freshness: pluginFreshnessFor({
              pluginConnectionId: OTHER_PLUGIN_ID,
              vendorImmutableId: "PAY-42"
            })
          },
          {
            field: "vendorImmutableId",
            freshness: pluginFreshnessFor({
              vendorImmutableId: "pipeline-legacy"
            })
          },
          {
            field: "revision",
            freshness: pluginFreshnessFor({
              revision: "source-other",
              vendorImmutableId: "PAY-42"
            })
          },
          {
            field: "sourceUrl",
            freshness: pluginFreshnessFor({
              sourceUrl: "https://jira.example/browse/PAY-99",
              vendorImmutableId: "PAY-42"
            })
          },
          {
            field: "firstObservedAt",
            freshness: pluginFreshnessFor({
              firstObservedAt: "2026-07-15T09:54:00.000Z",
              vendorImmutableId: "PAY-42"
            })
          },
          {
            field: "lastObservedAt",
            freshness: pluginFreshnessFor({
              lastObservedAt: "2026-07-15T09:57:00.000Z",
              vendorImmutableId: "PAY-42"
            })
          },
          {
            field: "synchronizedAt",
            freshness: pluginFreshnessFor({
              synchronizedAt: "2026-07-15T09:59:00.000Z",
              vendorImmutableId: "PAY-42"
            })
          },
          {
            field: "normalizationSchemaVersion",
            freshness: pluginFreshnessFor({
              normalizationSchemaVersion: 2,
              vendorImmutableId: "PAY-42"
            })
          }
        ]
        yield* Effect.forEach(
          invalidSourceRevisions,
          ({ field, freshness }) =>
            Effect.gen(function*() {
              const mismatch = yield* repository.write(WORKSPACE_A, {
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
                  freshness
                }],
                evidenceClaims: [],
                relationships: []
              }).pipe(Effect.result)
              assert.isTrue(Result.isFailure(mismatch), `${field} mismatch must fail`)
            }),
          { discard: true }
        )

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
        yield* repository.write(WORKSPACE_A, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [{
            ...initialBatch.evidenceItems[0],
            evidenceId: THIRD_EVIDENCE_ID,
            attribution: {
              _tag: "plugin",
              pluginConnectionId: PLUGIN_ID,
              sourceEntityId: ISSUE_ID,
              sourceEntityRevision: 1
            },
            freshness: pluginFreshnessFor({ cached: true, vendorImmutableId: "PAY-42" })
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

  it.effect("quarantines malformed workspace collaborator identity data under the person record", () =>
    withRepository(
      Effect.gen(function*() {
        yield* insertFoundation
        const repository = yield* DeliveryGraphRepository
        const database = yield* Database
        const quarantine = yield* QuarantineRepository
        yield* repository.write(WORKSPACE_A, initialBatch)

        const query = Schema.decodeSync(DeliveryGraphQuery)({
          _tag: "workspaceEntityProjections",
          owner: null,
          query: null,
          service: null,
          status: null,
          type: null,
          limit: 500
        })
        yield* database.sql`UPDATE persons
          SET avatar_json = '{"unexpected":"avatar"}'
          WHERE workspace_id = ${WORKSPACE_A} AND person_id = ${OWNER_PERSON_ID}`
        const malformedAvatar = yield* repository.read(WORKSPACE_A, query).pipe(Effect.result)
        assert.isTrue(Result.isFailure(malformedAvatar))
        const avatarRecords = yield* quarantine.list(WORKSPACE_A)
        assert.deepInclude(avatarRecords[0], {
          recordKind: "person-avatar",
          recordKey: OWNER_PERSON_ID,
          diagnosticCode: "schema-decode-failed"
        })

        yield* database.sql`UPDATE persons
          SET avatar_json = ${JSON.stringify({ _tag: "initials", text: "AB" })}
          WHERE workspace_id = ${WORKSPACE_A} AND person_id = ${OWNER_PERSON_ID}`
        yield* database.sql`PRAGMA ignore_check_constraints = ON`
        yield* database.sql`UPDATE persons
          SET display_name = ''
          WHERE workspace_id = ${WORKSPACE_A} AND person_id = ${OWNER_PERSON_ID}`
        yield* database.sql`PRAGMA ignore_check_constraints = OFF`
        const malformedPerson = yield* repository.read(WORKSPACE_A, query).pipe(Effect.result)
        assert.isTrue(Result.isFailure(malformedPerson))
        const records = yield* quarantine.list(WORKSPACE_A)
        assert.deepInclude(records.find(({ recordKind }) => recordKind === "person"), {
          recordKind: "person",
          recordKey: OWNER_PERSON_ID,
          diagnosticCode: "person-schema-invalid"
        })
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
          evidenceId: EVIDENCE_ID,
          limit: 200
        })
        assert.isEmpty(yield* quarantine.list(WORKSPACE_A))

        const secretCanary = "never-return-raw-claim-payload"
        yield* database.sql`DROP TRIGGER evidence_claims_no_update`
        yield* database.sql`UPDATE evidence_claims
          SET value_json = ${`{"_tag":"text","value":"${secretCanary}"}`}
          WHERE workspace_id = ${WORKSPACE_A} AND evidence_claim_id = ${CLAIM_ID}`

        const corrupted = yield* repository.read(WORKSPACE_A, {
          _tag: "evidence",
          evidenceId: EVIDENCE_ID,
          limit: 200
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(corrupted))
        if (Result.isFailure(corrupted)) {
          assert.instanceOf(corrupted.failure, PersistedRecordError)
          assert.strictEqual(corrupted.failure.diagnosticCode, "delivery-graph-digest-mismatch")
        }

        yield* repository.read(WORKSPACE_A, {
          _tag: "evidence",
          evidenceId: EVIDENCE_ID,
          limit: 200
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
