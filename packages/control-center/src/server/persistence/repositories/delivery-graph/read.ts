import {
  type RenderedSql,
  renderWorkspaceEntityOwnersQuery,
  renderWorkspaceEntityRelationshipsQuery,
  renderWorkspaceEntityReleasesQuery
} from "@knpkv/control-center-sql"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { derivePersonInitials, PersonAvatar, PersonSourceIdentity, Role } from "../../../../domain/actors.js"
import { type DeliveryNode, type DeliveryRelationship, LedgerRevision } from "../../../../domain/deliveryGraph.js"
import type { EntityId, EvidenceId, GraphNodeId, WorkspaceId } from "../../../../domain/identifiers.js"
import { EvidenceClaimId, PersonId, RelationshipId, ReleaseId } from "../../../../domain/identifiers.js"
import { Database } from "../../Database.js"
import { RecordNotFoundError } from "../../errors.js"
import { type DeliveryGraphQuery, DeliveryGraphReadResult } from "./contract.js"
import { makeDeliveryGraphDecoders } from "./decode.js"
import { captureMalformedDeliveryGraphRow } from "./quarantine.js"
import { selectBoundedRelationshipClosure } from "./release-slice.js"
import {
  ClaimRow,
  decodeRows,
  EvidenceRow,
  graphRecordError,
  NodeRow,
  ProjectionRow,
  RelationshipRow,
  WorkspaceProjectionRow
} from "./rows.js"

const WorkspaceProjectionCountRow = Schema.Struct({
  matchedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

const WorkspaceProjectionReleaseIds = Schema.fromJsonString(Schema.Array(ReleaseId))
const WorkspaceOwnerIdentity = Schema.Struct({
  avatarJson: Schema.String,
  displayName: Schema.String,
  personId: PersonId,
  rolesCsv: Schema.String
})
const WorkspaceOwnerIdentities = Schema.fromJsonString(Schema.Array(WorkspaceOwnerIdentity))
const WorkspaceOwnerOptionRow = WorkspaceOwnerIdentity
const WorkspaceOwnerRoleRow = Schema.Struct({
  avatarJson: Schema.String,
  displayName: Schema.String,
  personId: PersonId,
  role: Role
})
const WorkspaceEntityRelationshipIdentity = Schema.Struct({ relationshipId: RelationshipId })
const WorkspaceEntityReleaseIdentity = Schema.Struct({ releaseId: Schema.NullOr(ReleaseId) })
const PersonAvatarJson = Schema.fromJsonString(PersonAvatar)
const WorkspaceOwnerDisplayName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200)
)
const WorkspaceOwnerRoles = Schema.Array(Role).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16),
  Schema.isUnique()
)

const decodeWorkspaceOwner = Effect.fn("DeliveryGraphRepository.decodeWorkspaceOwner")(function*(
  workspaceId: WorkspaceId,
  owner: typeof WorkspaceOwnerIdentity.Type
) {
  const displayName = yield* Schema.decodeUnknownEffect(WorkspaceOwnerDisplayName)(owner.displayName).pipe(
    Effect.mapError(() => graphRecordError(workspaceId, "person", owner.personId, "person-schema-invalid"))
  )
  const avatar = yield* Schema.decodeUnknownEffect(PersonAvatarJson)(owner.avatarJson).pipe(
    Effect.mapError(() => graphRecordError(workspaceId, "person-avatar", owner.personId, "schema-decode-failed"))
  )
  const roles = yield* Schema.decodeUnknownEffect(WorkspaceOwnerRoles)(
    owner.rolesCsv.split(",").sort()
  ).pipe(
    Effect.mapError(() => graphRecordError(workspaceId, "person", owner.personId, "person-schema-invalid"))
  )
  return {
    avatarFallback: avatar._tag === "initials" ? avatar.text : derivePersonInitials(displayName),
    displayName,
    personId: owner.personId,
    roles
  }
})

export const makeDeliveryGraphReader = Effect.gen(function*() {
  const database = yield* Database
  const sql = database.sql
  const {
    decodeClaimRow,
    decodeEvidenceRow,
    decodeNodeRow,
    decodeProjectionRow,
    decodeRelationshipRow
  } = yield* makeDeliveryGraphDecoders

  const executePlan = Effect.fn("DeliveryGraphRepository.executePlan")(function*<RowSchema extends Schema.Top>(
    plan: RenderedSql,
    schema: RowSchema
  ) {
    const rows = yield* sql.unsafe(plan.sql, [...plan.params])
    return yield* decodeRows(schema, rows)
  })

  const loadProjection = Effect.fn("DeliveryGraphRepository.loadProjection")(function*(
    workspaceId: WorkspaceId,
    entityId: EntityId,
    revision: LedgerRevision | null
  ) {
    const rows = yield* sql`SELECT
        projection.workspace_id AS workspaceId,
        projection.entity_id AS entityId,
        projection.projection_revision AS projectionRevision,
        projection.source_entity_revision AS sourceEntityRevision,
        projection.supersedes_projection_revision AS supersedesProjectionRevision,
        projection.projection_schema_version AS projectionSchemaVersion,
        projection.entity_state AS entityState,
        CASE entity.entity_type
          WHEN 'pipeline' THEN 'pipeline-execution'
          ELSE entity.entity_type
        END AS entityType,
        projection.display_key AS displayKey,
        projection.title,
        projection.extension_json AS extensionJson,
        projection.extension_digest AS extensionDigest,
        projection.recorded_at AS recordedAt
      FROM entity_projection_revisions projection
      INNER JOIN entities entity
        ON entity.workspace_id = projection.workspace_id
       AND entity.entity_id = projection.entity_id
      WHERE projection.workspace_id = ${workspaceId}
        AND projection.entity_id = ${entityId}
        AND (${revision} IS NULL OR projection.projection_revision = ${revision})
      ORDER BY projection.projection_revision DESC
      LIMIT 1`
    const decoded = yield* decodeRows(ProjectionRow, rows).pipe(
      Effect.mapError(() =>
        graphRecordError(
          workspaceId,
          "entity-projection",
          entityId,
          "entity-projection-schema-invalid"
        )
      ),
      captureMalformedDeliveryGraphRow(rows)
    )
    const row = decoded[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "entity-projection",
        recordKey: revision === null ? entityId : `${entityId}:${revision}`
      })
    }
    return yield* decodeProjectionRow(row).pipe(captureMalformedDeliveryGraphRow(row))
  })

  const loadNode = Effect.fn("DeliveryGraphRepository.loadNode")(function*(
    workspaceId: WorkspaceId,
    nodeId: GraphNodeId
  ) {
    const rows = yield* sql`SELECT
        workspace_id AS workspaceId, node_id AS nodeId, node_key_digest AS nodeKeyDigest,
        node_kind AS nodeKind, endpoint_kind AS endpointKind,
        resolution_state AS resolutionState, entity_id AS entityId,
        release_id AS releaseId, environment_id AS environmentId,
        expected_entity_kind AS expectedEntityKind, missing_key AS missingKey, created_at AS createdAt
      FROM delivery_nodes
      WHERE workspace_id = ${workspaceId} AND node_id = ${nodeId}`
    const decoded = yield* decodeRows(NodeRow, rows).pipe(
      Effect.mapError(() =>
        graphRecordError(
          workspaceId,
          "delivery-node",
          nodeId,
          "delivery-node-schema-invalid"
        )
      ),
      captureMalformedDeliveryGraphRow(rows)
    )
    const row = decoded[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "delivery-node",
        recordKey: nodeId
      })
    }
    return yield* decodeNodeRow(row).pipe(captureMalformedDeliveryGraphRow(row))
  })

  const loadEvidence = Effect.fn("DeliveryGraphRepository.loadEvidence")(function*(
    workspaceId: WorkspaceId,
    evidenceId: EvidenceId
  ) {
    const rows = yield* sql`SELECT
        workspace_id AS workspaceId, evidence_id AS evidenceId, schema_version AS schemaVersion,
        evidence_digest AS evidenceDigest, origin_kind AS originKind,
        plugin_connection_id AS pluginConnectionId, source_entity_id AS sourceEntityId,
        source_entity_revision AS sourceEntityRevision, person_id AS personId, agent_id AS agentId,
        system_component AS systemComponent, verifier_kind AS verifierKind,
        verifier_person_id AS verifierPersonId, verifier_agent_id AS verifierAgentId,
        verifier_component AS verifierComponent, observed_at AS observedAt, recorded_at AS recordedAt,
        valid_until AS validUntil, freshness_json AS freshnessJson,
        freshness_digest AS freshnessDigest, retention_class AS retentionClass, retain_until AS retainUntil,
        legal_hold AS legalHold
      FROM evidence_items
      WHERE workspace_id = ${workspaceId} AND evidence_id = ${evidenceId}`
    const decoded = yield* decodeRows(EvidenceRow, rows).pipe(
      Effect.mapError(() =>
        graphRecordError(
          workspaceId,
          "evidence-item",
          evidenceId,
          "evidence-item-schema-invalid"
        )
      ),
      captureMalformedDeliveryGraphRow(rows)
    )
    const row = decoded[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "evidence-item",
        recordKey: evidenceId
      })
    }
    return yield* decodeEvidenceRow(row).pipe(captureMalformedDeliveryGraphRow(row))
  })

  const loadClaim = Effect.fn("DeliveryGraphRepository.loadClaim")(function*(
    workspaceId: WorkspaceId,
    evidenceClaimId: EvidenceClaimId
  ) {
    const rows = yield* sql`SELECT
        workspace_id AS workspaceId, evidence_claim_id AS evidenceClaimId,
        evidence_id AS evidenceId, subject_node_id AS subjectNodeId, predicate,
        value_json AS valueJson, value_digest AS valueDigest,
        supersedes_claim_id AS supersedesEvidenceClaimId, recorded_at AS recordedAt
      FROM evidence_claims
      WHERE workspace_id = ${workspaceId} AND evidence_claim_id = ${evidenceClaimId}`
    const decoded = yield* decodeRows(ClaimRow, rows).pipe(
      Effect.mapError(() =>
        graphRecordError(
          workspaceId,
          "evidence-claim",
          evidenceClaimId,
          "evidence-claim-schema-invalid"
        )
      ),
      captureMalformedDeliveryGraphRow(rows)
    )
    const row = decoded[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "evidence-claim",
        recordKey: evidenceClaimId
      })
    }
    return yield* decodeClaimRow(row).pipe(captureMalformedDeliveryGraphRow(row))
  })

  const listClaimsForEvidence = Effect.fn("DeliveryGraphRepository.listClaimsForEvidence")(function*(
    workspaceId: WorkspaceId,
    evidenceId: EvidenceId,
    limit: number
  ) {
    const identities = yield* sql`SELECT evidence_claim_id AS evidenceClaimId
      FROM evidence_claims
      WHERE workspace_id = ${workspaceId} AND evidence_id = ${evidenceId}
      ORDER BY recorded_at, evidence_claim_id
      LIMIT ${limit}`
    const decoded = yield* decodeRows(Schema.Struct({ evidenceClaimId: EvidenceClaimId }), identities)
    return yield* Effect.forEach(decoded, ({ evidenceClaimId }) => loadClaim(workspaceId, evidenceClaimId))
  })

  const loadRelationship = Effect.fn("DeliveryGraphRepository.loadRelationship")(function*(
    workspaceId: WorkspaceId,
    relationshipId: RelationshipId,
    revision: LedgerRevision | null
  ) {
    const rows = yield* sql`SELECT
        revision.workspace_id AS workspaceId, revision.relationship_id AS relationshipId,
        revision.revision, revision.supersedes_revision AS supersedesRevision,
        revision.schema_version AS relationshipSchemaVersion, revision.kind,
        revision.source_node_id AS sourceNodeId, revision.source_node_kind AS sourceNodeKind,
        revision.target_node_id AS targetNodeId, revision.target_node_kind AS targetNodeKind,
        revision.lifecycle, revision.lifecycle_reason AS lifecycleReason,
        revision.release_id AS releaseId, revision.environment_id AS environmentId,
        revision.confidence_kind AS confidenceKind, revision.confidence_score AS confidenceScore,
        revision.confidence_rationale AS confidenceRationale,
        revision.provenance_kind AS provenanceKind,
        revision.provenance_plugin_connection_id AS provenancePluginConnectionId,
        revision.provenance_source_entity_id AS provenanceSourceEntityId,
        revision.provenance_source_entity_revision AS provenanceSourceEntityRevision,
        revision.provenance_person_id AS provenancePersonId,
        revision.provenance_agent_id AS provenanceAgentId,
        revision.provenance_rule_id AS provenanceRuleId,
        revision.provenance_rule_version AS provenanceRuleVersion,
        revision.provenance_rationale AS provenanceRationale,
        revision.recorded_by_kind AS recordedByKind,
        revision.recorded_by_person_id AS recordedByPersonId,
        revision.recorded_by_agent_id AS recordedByAgentId,
        revision.recorded_by_component AS recordedByComponent,
        revision.effective_at AS effectiveAt, revision.recorded_at AS recordedAt,
        revision.revision_digest AS revisionDigest, NULL AS evidenceClaimIds
      FROM relationship_revisions revision
      INNER JOIN relationship_heads head
        ON head.workspace_id = revision.workspace_id
       AND head.relationship_id = revision.relationship_id
      WHERE revision.workspace_id = ${workspaceId}
        AND revision.relationship_id = ${relationshipId}
        AND revision.revision = COALESCE(${revision}, head.current_revision)
      LIMIT 1`
    const baseSchema = Schema.Struct({ ...RelationshipRow.fields, evidenceClaimIds: Schema.Null })
    const decoded = yield* decodeRows(baseSchema, rows).pipe(
      Effect.mapError(() =>
        graphRecordError(
          workspaceId,
          "delivery-relationship",
          relationshipId,
          "delivery-relationship-schema-invalid"
        )
      ),
      captureMalformedDeliveryGraphRow(rows)
    )
    const row = decoded[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "delivery-relationship",
        recordKey: revision === null ? relationshipId : `${relationshipId}:${revision}`
      })
    }
    const evidenceRows = yield* sql`SELECT evidence_claim_id AS evidenceClaimId
      FROM relationship_revision_evidence
      WHERE workspace_id = ${workspaceId}
        AND relationship_id = ${relationshipId}
        AND relationship_revision = ${row.revision}
      ORDER BY evidence_claim_id`
    const evidenceClaimIds = (yield* decodeRows(
      Schema.Struct({ evidenceClaimId: EvidenceClaimId }),
      evidenceRows
    )).map(({ evidenceClaimId }) => evidenceClaimId)
    const persistedRow = { ...row, evidenceClaimIds }
    return yield* decodeRelationshipRow(persistedRow).pipe(
      captureMalformedDeliveryGraphRow(persistedRow)
    )
  })

  const loadWorkspaceEntityOwners = Effect.fn("DeliveryGraphRepository.loadWorkspaceEntityOwners")(function*(
    workspaceId: WorkspaceId,
    entityId: EntityId
  ) {
    const rows = yield* executePlan(
      renderWorkspaceEntityOwnersQuery({ workspaceId, entityId }),
      WorkspaceOwnerRoleRow
    )
    const identities = new Map<PersonId, {
      readonly avatarJson: string
      readonly displayName: string
      readonly personId: PersonId
      readonly roles: Set<Role>
    }>()
    for (const row of rows) {
      const existing = identities.get(row.personId)
      if (existing === undefined) {
        identities.set(row.personId, { ...row, roles: new Set([row.role]) })
      } else {
        existing.roles.add(row.role)
      }
    }
    const candidates = [...identities.values()]
    const owners = yield* Effect.forEach(candidates.slice(0, 20), (owner) =>
      Effect.gen(function*() {
        const decoded = yield* decodeWorkspaceOwner(workspaceId, {
          avatarJson: owner.avatarJson,
          displayName: owner.displayName,
          personId: owner.personId,
          rolesCsv: [...owner.roles].sort().join(",")
        })
        const identityRows = yield* sql<Record<string, unknown>>`SELECT
            identity.plugin_connection_id AS pluginConnectionId,
            identity.provider_id AS providerId,
            identity.vendor_person_id AS vendorPersonId
          FROM person_identities AS identity
          WHERE identity.workspace_id = ${workspaceId}
            AND identity.person_id = ${owner.personId}
            AND identity.provider_id = 'confluence'
          ORDER BY CASE WHEN identity.plugin_connection_id = (
            SELECT entity.plugin_connection_id
            FROM entities AS entity
            WHERE entity.workspace_id = ${workspaceId}
              AND entity.entity_id = ${entityId}
          ) THEN 0 ELSE 1 END,
            identity.plugin_connection_id,
            identity.vendor_person_id
          LIMIT 16`
        const sourceIdentities = yield* decodeRows(PersonSourceIdentity, identityRows)
        return sourceIdentities.length === 0 ? decoded : { ...decoded, sourceIdentities }
      }))
    return { owners, ownersTruncated: candidates.length > 20 }
  })

  const loadWorkspaceEntityReleaseIds = Effect.fn(
    "DeliveryGraphRepository.loadWorkspaceEntityReleaseIds"
  )(function*(workspaceId: WorkspaceId, entityId: EntityId) {
    const rows = yield* executePlan(
      renderWorkspaceEntityReleasesQuery({ workspaceId, entityId }),
      WorkspaceEntityReleaseIdentity
    )
    const releaseIds = rows.flatMap(({ releaseId }): ReadonlyArray<ReleaseId> => releaseId === null ? [] : [releaseId])
    return {
      releaseIds: releaseIds.slice(0, 500),
      releaseMembershipsTruncated: releaseIds.length > 500
    }
  })

  const hydrateRelationshipClosure = Effect.fn(
    "DeliveryGraphRepository.hydrateRelationshipClosure"
  )(function*(
    workspaceId: WorkspaceId,
    candidateRelationships: ReadonlyArray<DeliveryRelationship>,
    bounds: { readonly relationships: number; readonly nodes: number; readonly evidenceClaims: number },
    projectionPolicy: (nodes: ReadonlyArray<DeliveryNode>) => ReadonlyArray<EntityId>
  ) {
    const bounded = selectBoundedRelationshipClosure(candidateRelationships, bounds)
    const relationships = bounded.relationships
    const nodeIds = Array.from(
      new Set(relationships.flatMap(({ sourceNodeId, targetNodeId }) => [sourceNodeId, targetNodeId]))
    )
    const nodes = yield* Effect.forEach(nodeIds, (nodeId) => loadNode(workspaceId, nodeId))
    const entityProjections = yield* Effect.forEach(
      projectionPolicy(nodes),
      (entityId) => loadProjection(workspaceId, entityId, null)
    )
    const claimIds = Array.from(
      new Set(relationships.flatMap(({ evidenceClaimIds }) => evidenceClaimIds))
    )
    const evidenceClaims = yield* Effect.forEach(
      claimIds,
      (evidenceClaimId) => loadClaim(workspaceId, evidenceClaimId)
    )
    const evidenceIds = Array.from(new Set(evidenceClaims.map(({ evidenceId }) => evidenceId)))
    const evidenceItems = yield* Effect.forEach(
      evidenceIds,
      (evidenceId) => loadEvidence(workspaceId, evidenceId)
    )
    return {
      entityProjections,
      evidenceClaims,
      evidenceItems,
      nodes,
      relationships,
      truncated: bounded.truncated
    }
  })

  const readDecoded = Effect.fn("DeliveryGraphRepository.readDecoded")(function*(
    workspaceId: WorkspaceId,
    query: DeliveryGraphQuery
  ) {
    switch (query._tag) {
      case "entityProjection":
        return DeliveryGraphReadResult.make({
          _tag: "entityProjection",
          value: yield* loadProjection(workspaceId, query.entityId, query.revision)
        })
      case "node":
        return DeliveryGraphReadResult.make({
          _tag: "node",
          value: yield* loadNode(workspaceId, query.nodeId)
        })
      case "evidence": {
        const evidence = yield* loadEvidence(workspaceId, query.evidenceId)
        const claims = yield* listClaimsForEvidence(workspaceId, query.evidenceId, query.limit)
        return DeliveryGraphReadResult.make({ _tag: "evidence", value: { evidence, claims } })
      }
      case "relationship":
        return DeliveryGraphReadResult.make({
          _tag: "relationship",
          value: yield* loadRelationship(workspaceId, query.relationshipId, query.revision)
        })
      case "relationshipHistory": {
        const rows = yield* sql`SELECT revision
          FROM relationship_revisions
          WHERE workspace_id = ${workspaceId} AND relationship_id = ${query.relationshipId}
          ORDER BY revision DESC LIMIT ${query.limit}`
        const revisions = yield* decodeRows(Schema.Struct({ revision: LedgerRevision }), rows)
        if (revisions.length === 0) {
          return yield* new RecordNotFoundError({
            workspaceId,
            recordKind: "delivery-relationship",
            recordKey: query.relationshipId
          })
        }
        const value = yield* Effect.forEach(
          revisions,
          ({ revision }) => loadRelationship(workspaceId, query.relationshipId, revision)
        )
        return DeliveryGraphReadResult.make({ _tag: "relationshipHistory", value })
      }
      case "entitySlice": {
        const projection = yield* loadProjection(workspaceId, query.entityId, null)
        if (projection.projection.entityState === "deleted") {
          return yield* new RecordNotFoundError({
            workspaceId,
            recordKind: "entity-projection",
            recordKey: query.entityId
          })
        }
        const { owners, ownersTruncated } = yield* loadWorkspaceEntityOwners(workspaceId, query.entityId)
        const { releaseIds, releaseMembershipsTruncated } = yield* loadWorkspaceEntityReleaseIds(
          workspaceId,
          query.entityId
        )
        const identityRows = yield* executePlan(
          renderWorkspaceEntityRelationshipsQuery({
            workspaceId,
            entityId: query.entityId,
            limit: query.limit + 1
          }),
          WorkspaceEntityRelationshipIdentity
        )
        const candidateRelationships = yield* Effect.forEach(
          identityRows.slice(0, query.limit),
          ({ relationshipId }) => loadRelationship(workspaceId, relationshipId, null)
        )
        const closure = yield* hydrateRelationshipClosure(workspaceId, candidateRelationships, {
          relationships: query.limit,
          nodes: 200,
          evidenceClaims: 200
        }, (nodes) => {
          const relatedEntityIds = new Set<EntityId>()
          for (const node of nodes) {
            if (node.resolution._tag !== "resolved" || node.resolution.target._tag !== "entity") continue
            if (node.resolution.target.entityId !== query.entityId) {
              relatedEntityIds.add(node.resolution.target.entityId)
            }
          }
          return [...relatedEntityIds]
        })
        return DeliveryGraphReadResult.make({
          _tag: "entitySlice",
          value: {
            entity: {
              canonicalReleaseId: releaseIds[0] ?? null,
              owners,
              ownersTruncated,
              releaseIds,
              releaseMembershipsTruncated,
              ...projection
            },
            truncated: identityRows.length > query.limit || closure.truncated,
            nodes: closure.nodes,
            relatedEntityProjections: closure.entityProjections,
            relationships: closure.relationships,
            evidenceClaims: closure.evidenceClaims,
            evidenceItems: closure.evidenceItems
          }
        })
      }
      case "nodeRelationships": {
        const identityRows = yield* sql`SELECT relationship_id AS relationshipId FROM (
            SELECT revision.relationship_id
            FROM relationship_revisions revision
            INNER JOIN relationship_heads head
              ON head.workspace_id = revision.workspace_id
             AND head.relationship_id = revision.relationship_id
             AND head.current_revision = revision.revision
            WHERE revision.workspace_id = ${workspaceId}
              AND revision.source_node_id = ${query.nodeId}
              AND revision.lifecycle NOT IN ('rejected', 'superseded')
            UNION
            SELECT revision.relationship_id
            FROM relationship_revisions revision
            INNER JOIN relationship_heads head
              ON head.workspace_id = revision.workspace_id
             AND head.relationship_id = revision.relationship_id
             AND head.current_revision = revision.revision
            WHERE revision.workspace_id = ${workspaceId}
              AND revision.target_node_id = ${query.nodeId}
              AND revision.lifecycle NOT IN ('rejected', 'superseded')
          )
          ORDER BY relationship_id
          LIMIT ${query.limit + 1}`
        const identities = yield* decodeRows(Schema.Struct({ relationshipId: RelationshipId }), identityRows)
        const relationships = yield* Effect.forEach(
          identities.slice(0, query.limit),
          ({ relationshipId }) => loadRelationship(workspaceId, relationshipId, null)
        )
        return DeliveryGraphReadResult.make({
          _tag: "nodeRelationships",
          value: {
            nodeId: query.nodeId,
            truncated: identities.length > query.limit,
            relationships
          }
        })
      }
      case "releaseSlice": {
        const identityLimit = query.limit + 1
        const identityRows = query.environmentId === null
          ? yield* sql`SELECT revision.relationship_id AS relationshipId
              FROM relationship_revisions revision
              INNER JOIN relationship_heads head
                ON head.workspace_id = revision.workspace_id
               AND head.relationship_id = revision.relationship_id
               AND head.current_revision = revision.revision
              WHERE revision.workspace_id = ${workspaceId}
                AND revision.release_id = ${query.releaseId}
                AND revision.environment_id IS NULL
                AND revision.lifecycle NOT IN ('rejected', 'superseded')
              ORDER BY revision.recorded_at DESC
              LIMIT ${identityLimit}`
          : yield* sql`SELECT revision.relationship_id AS relationshipId
              FROM relationship_revisions revision
              INNER JOIN relationship_heads head
                ON head.workspace_id = revision.workspace_id
               AND head.relationship_id = revision.relationship_id
               AND head.current_revision = revision.revision
              WHERE revision.workspace_id = ${workspaceId}
                AND revision.release_id = ${query.releaseId}
                AND revision.environment_id = ${query.environmentId}
                AND revision.lifecycle NOT IN ('rejected', 'superseded')
              ORDER BY revision.recorded_at DESC
              LIMIT ${identityLimit}`
        const identities = yield* decodeRows(Schema.Struct({ relationshipId: RelationshipId }), identityRows)
        const candidateRelationships = yield* Effect.forEach(
          identities.slice(0, query.limit),
          ({ relationshipId }) => loadRelationship(workspaceId, relationshipId, null)
        )
        const closure = yield* hydrateRelationshipClosure(workspaceId, candidateRelationships, {
          relationships: query.limit,
          nodes: 500,
          evidenceClaims: 500
        }, (nodes) =>
          nodes.flatMap((node): ReadonlyArray<EntityId> => {
            if (node.resolution._tag !== "resolved" || node.resolution.target._tag !== "entity") return []
            return [node.resolution.target.entityId]
          }))
        return DeliveryGraphReadResult.make({
          _tag: "releaseSlice",
          value: {
            releaseId: query.releaseId,
            environmentId: query.environmentId,
            truncated: identities.length > query.limit || closure.truncated,
            nodes: closure.nodes,
            entityProjections: closure.entityProjections,
            relationships: closure.relationships,
            evidenceClaims: closure.evidenceClaims,
            evidenceItems: closure.evidenceItems
          }
        })
      }
      case "componentRelationships": {
        const identityRows = yield* sql`SELECT revision.relationship_id AS relationshipId
          FROM relationship_revisions revision
          INNER JOIN relationship_heads head
            ON head.workspace_id = revision.workspace_id
           AND head.relationship_id = revision.relationship_id
           AND head.current_revision = revision.revision
          WHERE revision.workspace_id = ${workspaceId}
            AND (${query.releaseId} IS NULL OR revision.release_id = ${query.releaseId})
            AND revision.environment_id IS NULL
            AND revision.lifecycle NOT IN ('rejected', 'superseded')
            AND revision.recorded_by_kind = 'system'
            AND revision.recorded_by_component = ${query.component}
          ORDER BY revision.relationship_id
          LIMIT ${query.limit + 1}`
        const identities = yield* decodeRows(Schema.Struct({ relationshipId: RelationshipId }), identityRows)
        const relationships = yield* Effect.forEach(
          identities.slice(0, query.limit),
          ({ relationshipId }) => loadRelationship(workspaceId, relationshipId, null)
        )
        return DeliveryGraphReadResult.make({
          _tag: "componentRelationships",
          value: {
            releaseId: query.releaseId,
            truncated: identities.length > query.limit,
            relationships
          }
        })
      }
      case "workspaceEntityProjections": {
        const rowLimit = query.limit + 1
        const ownerRole = sql`assignment.role IN (
          'change-owner', 'issue-owner', 'issue-assignee', 'page-owner', 'author', 'operator',
          'contributor', 'reviewer', 'watcher', 'deployment-approver', 'merge-approver'
        )`
        const activeOwner = sql`assignment.workspace_id = projection.workspace_id
          AND assignment.entity_id = projection.entity_id
          AND assignment.scope_kind = 'entity'
          AND assignment.actor_kind = 'human'
          AND assignment.lifecycle_kind = 'active'
          AND ${ownerRole}`
        const entityType = sql`CASE entity.entity_type
          WHEN 'pipeline' THEN 'pipeline-execution'
          ELSE entity.entity_type
        END`
        const service = sql`CASE ${entityType}
          WHEN 'issue' THEN 'jira'
          WHEN 'pull-request' THEN 'codecommit'
          WHEN 'page' THEN 'confluence'
          WHEN 'pipeline-execution' THEN 'codepipeline'
          WHEN 'deployment' THEN 'codepipeline'
          WHEN 'time-entry' THEN 'clockify'
        END`
        const rawStatusText = sql`lower(COALESCE(
          json_extract(projection.extension_json, '$.status'),
          json_extract(projection.extension_json, '$.reviewState'),
          json_extract(projection.extension_json, '$.approvalState'),
          ''
        ))`
        const statusText = sql`CASE ${entityType}
          WHEN 'issue' THEN ${rawStatusText}
          ELSE replace(${rawStatusText}, '-', ' ')
        END`
        const pullRequestReviewText = sql`replace(lower(COALESCE(
          json_extract(projection.extension_json, '$.reviewState'),
          ''
        )), '-', ' ')`
        const pullRequestLifecycleText = sql`lower(COALESCE(
          json_extract(projection.extension_json, '$.lifecycle'),
          ''
        ))`
        const pullRequestSearchStatusText = sql`trim(
          CASE ${pullRequestReviewText}
            WHEN 'not requested' THEN 'review not requested'
            WHEN 'requested' THEN 'review requested'
            ELSE ${pullRequestReviewText}
          END || ' ' || ${pullRequestLifecycleText}
        )`
        const searchStatusText = sql`CASE ${entityType}
          WHEN 'pull-request' THEN ${pullRequestSearchStatusText}
          ELSE ${statusText}
        END`
        const statusGroup = sql`CASE ${entityType}
          WHEN 'issue' THEN CASE
            WHEN ${statusText} IN ('blocked', 'rejected') THEN 'failed'
            WHEN ${statusText} IN ('closed', 'done', 'resolved') THEN 'done'
            ELSE 'active'
          END
          WHEN 'pull-request' THEN CASE
            WHEN ${pullRequestReviewText} = 'changes requested' THEN 'failed'
            WHEN ${pullRequestReviewText} IN ('approved', 'merged') THEN 'done'
            WHEN ${pullRequestLifecycleText} IN ('closed', 'merged') THEN 'done'
            ELSE 'active'
          END
          WHEN 'page' THEN CASE
            WHEN ${statusText} = 'superseded' THEN 'failed'
            WHEN ${statusText} = 'current' THEN 'done'
            ELSE 'active'
          END
          WHEN 'pipeline-execution' THEN CASE
            WHEN ${statusText} IN ('failed', 'stopped') THEN 'failed'
            WHEN ${statusText} = 'succeeded' THEN 'done'
            ELSE 'active'
          END
          WHEN 'deployment' THEN CASE
            WHEN ${statusText} IN ('failed', 'rolled back') THEN 'failed'
            WHEN ${statusText} = 'succeeded' THEN 'done'
            ELSE 'active'
          END
          WHEN 'time-entry' THEN CASE
            WHEN ${statusText} = 'rejected' THEN 'failed'
            WHEN ${statusText} IN ('approved', 'not required') THEN 'done'
            ELSE 'active'
          END
        END`
        const isCurrent = sql`projection.workspace_id = ${workspaceId}
          AND projection.entity_state = 'present'
          AND projection.source_entity_revision = entity.current_revision
          AND NOT EXISTS (
            SELECT 1
            FROM entity_projection_revisions newer
            WHERE newer.workspace_id = projection.workspace_id
              AND newer.entity_id = projection.entity_id
              AND newer.projection_revision > projection.projection_revision
          )`
        const matchesFilters = sql`(${query.query} IS NULL OR instr(
            lower(projection.display_key || ' ' || projection.title || ' ' || ${searchStatusText}),
            lower(${query.query})
          ) > 0)
          AND (${query.service} IS NULL OR ${service} = ${query.service})
          AND (${query.status} IS NULL OR ${statusGroup} = ${query.status})
          AND (${query.type} IS NULL OR ${entityType} = ${query.type})
          AND (${query.owner} IS NULL OR EXISTS (
            SELECT 1
            FROM role_assignments assignment
            INNER JOIN persons person
              ON person.workspace_id = assignment.workspace_id
             AND person.person_id = assignment.person_id
             AND person.is_active = 1
            WHERE ${activeOwner}
              AND assignment.person_id = ${query.owner}
          ))`
        // The repository executes this reader in one transaction, so counts and rows share a snapshot.
        const countRows = yield* sql`SELECT
            COUNT(CASE WHEN ${matchesFilters} THEN 1 END) AS matchedCount,
            COUNT(*) AS totalCount
          FROM entity_projection_revisions projection
          INNER JOIN entities entity
            ON entity.workspace_id = projection.workspace_id
           AND entity.entity_id = projection.entity_id
          WHERE ${isCurrent}`
        const counts = (yield* decodeRows(WorkspaceProjectionCountRow, countRows))[0]
        if (counts === undefined) return yield* Effect.die("Expected workspace projection counts")
        const rows = yield* sql`SELECT
            projection.workspace_id AS workspaceId,
            projection.entity_id AS entityId,
            projection.projection_revision AS projectionRevision,
            projection.source_entity_revision AS sourceEntityRevision,
            projection.supersedes_projection_revision AS supersedesProjectionRevision,
            projection.projection_schema_version AS projectionSchemaVersion,
            projection.entity_state AS entityState,
            ${entityType} AS entityType,
            projection.display_key AS displayKey,
            projection.title,
            projection.extension_json AS extensionJson,
            projection.extension_digest AS extensionDigest,
            projection.recorded_at AS recordedAt,
            COALESCE((
              SELECT json_group_array(json_object(
                'avatarJson', owner.avatar_json,
                'displayName', owner.display_name,
                'personId', owner.person_id,
                'rolesCsv', owner.roles_csv
              ))
              FROM (
                SELECT person.person_id, person.display_name, person.avatar_json,
                  group_concat(DISTINCT assignment.role) AS roles_csv
                FROM role_assignments assignment
                INNER JOIN persons person
                  ON person.workspace_id = assignment.workspace_id
                 AND person.person_id = assignment.person_id
                 AND person.is_active = 1
                WHERE ${activeOwner}
                GROUP BY person.person_id, person.display_name, person.avatar_json
                ORDER BY CASE WHEN person.person_id = ${query.owner} THEN 0 ELSE 1 END,
                  person.display_name, person.person_id
                LIMIT 21
              ) owner
            ), '[]') AS ownerIdentitiesJson,
            COALESCE((
              SELECT json_group_array(current_release.release_id)
              FROM (
                SELECT DISTINCT relationship.release_id
                FROM delivery_nodes node
                INNER JOIN relationship_revisions relationship
                  ON relationship.workspace_id = node.workspace_id
                 AND (relationship.source_node_id = node.node_id OR relationship.target_node_id = node.node_id)
                INNER JOIN relationship_heads head
                  ON head.workspace_id = relationship.workspace_id
                 AND head.relationship_id = relationship.relationship_id
                 AND head.current_revision = relationship.revision
                WHERE node.workspace_id = projection.workspace_id
                  AND node.entity_id = projection.entity_id
                  AND relationship.release_id IS NOT NULL
                  AND relationship.lifecycle NOT IN ('rejected', 'superseded')
                ORDER BY relationship.release_id
                LIMIT 501
              ) current_release
            ), '[]') AS releaseIdsJson
          FROM entity_projection_revisions projection
          INNER JOIN entities entity
            ON entity.workspace_id = projection.workspace_id
           AND entity.entity_id = projection.entity_id
          WHERE ${isCurrent}
            AND ${matchesFilters}
          ORDER BY projection.display_key, projection.entity_id
          LIMIT ${rowLimit}`
        const decoded = yield* decodeRows(WorkspaceProjectionRow, rows).pipe(
          Effect.mapError(() =>
            graphRecordError(
              workspaceId,
              "workspace-entity-projections",
              workspaceId,
              "entity-projection-schema-invalid"
            )
          ),
          captureMalformedDeliveryGraphRow(rows)
        )
        const items = yield* Effect.forEach(decoded.slice(0, query.limit), (row) =>
          Effect.gen(function*() {
            const releaseIds = yield* Schema.decodeUnknownEffect(WorkspaceProjectionReleaseIds)(row.releaseIdsJson)
              .pipe(
                Effect.mapError(() =>
                  graphRecordError(
                    workspaceId,
                    "workspace-entity-projections",
                    row.entityId,
                    "workspace-release-memberships-schema-invalid"
                  )
                ),
                captureMalformedDeliveryGraphRow(row)
              )
            const boundedReleaseIds = releaseIds.slice(0, 500)
            const ownerIdentities = yield* Schema.decodeUnknownEffect(WorkspaceOwnerIdentities)(
              row.ownerIdentitiesJson
            ).pipe(
              Effect.mapError(() =>
                graphRecordError(
                  workspaceId,
                  "person",
                  row.entityId,
                  "person-schema-invalid"
                )
              ),
              captureMalformedDeliveryGraphRow(row)
            )
            const owners = yield* Effect.forEach(
              ownerIdentities.slice(0, 20),
              (owner) => decodeWorkspaceOwner(workspaceId, owner).pipe(captureMalformedDeliveryGraphRow(owner))
            )
            const { projection, recordedAt } = yield* decodeProjectionRow(row).pipe(
              captureMalformedDeliveryGraphRow(row)
            )
            return {
              canonicalReleaseId: boundedReleaseIds[0] ?? null,
              owners,
              ownersTruncated: ownerIdentities.length > 20,
              releaseIds: boundedReleaseIds,
              releaseMembershipsTruncated: releaseIds.length > 500,
              projection,
              recordedAt
            }
          }))
        const ownerOptionRows = yield* sql`SELECT
            person.person_id AS personId,
            person.display_name AS displayName,
            person.avatar_json AS avatarJson,
            group_concat(DISTINCT assignment.role) AS rolesCsv
          FROM role_assignments assignment
          INNER JOIN persons person
            ON person.workspace_id = assignment.workspace_id
           AND person.person_id = assignment.person_id
           AND person.is_active = 1
          INNER JOIN entity_projection_revisions projection
            ON projection.workspace_id = assignment.workspace_id
           AND projection.entity_id = assignment.entity_id
          INNER JOIN entities entity
            ON entity.workspace_id = projection.workspace_id
           AND entity.entity_id = projection.entity_id
          WHERE ${activeOwner}
            AND ${isCurrent}
          GROUP BY person.person_id, person.display_name, person.avatar_json
          ORDER BY person.display_name, person.person_id
          LIMIT 201`
        const decodedOwnerOptions = yield* decodeRows(WorkspaceOwnerOptionRow, ownerOptionRows).pipe(
          Effect.mapError(() =>
            graphRecordError(
              workspaceId,
              "person",
              workspaceId,
              "person-schema-invalid"
            )
          ),
          captureMalformedDeliveryGraphRow(ownerOptionRows)
        )
        const ownerOptions = yield* Effect.forEach(
          decodedOwnerOptions.slice(0, 200),
          (owner) => decodeWorkspaceOwner(workspaceId, owner).pipe(captureMalformedDeliveryGraphRow(owner))
        )
        return DeliveryGraphReadResult.make({
          _tag: "workspaceEntityProjections",
          value: {
            items,
            matchedCount: counts.matchedCount,
            ownerOptions,
            ownerOptionsTruncated: decodedOwnerOptions.length > 200,
            totalCount: counts.totalCount,
            truncated: decoded.length > query.limit
          }
        })
      }
      case "releaseSummary": {
        const rows = yield* sql`WITH current_relationships AS (
            SELECT revision.source_node_id, revision.source_node_kind,
              revision.target_node_id, revision.target_node_kind
            FROM relationship_revisions revision
            INNER JOIN relationship_heads head
              ON head.workspace_id = revision.workspace_id
             AND head.relationship_id = revision.relationship_id
             AND head.current_revision = revision.revision
            WHERE revision.workspace_id = ${workspaceId}
              AND revision.release_id = ${query.releaseId}
              AND revision.environment_id IS NULL
              AND revision.lifecycle NOT IN ('rejected', 'superseded')
          ), endpoints AS (
            SELECT source_node_id AS node_id, source_node_kind AS endpoint_kind
            FROM current_relationships
            UNION
            SELECT target_node_id AS node_id, target_node_kind AS endpoint_kind
            FROM current_relationships
          ), resolved_endpoints AS (
            SELECT endpoints.node_id, endpoints.endpoint_kind
            FROM endpoints
            INNER JOIN delivery_nodes node
              ON node.workspace_id = ${workspaceId}
             AND node.node_id = endpoints.node_id
             AND node.resolution_state = 'resolved'
          )
          SELECT
            COUNT(DISTINCT CASE WHEN endpoint_kind = 'issue' THEN node_id END) AS issues,
            COUNT(DISTINCT CASE WHEN endpoint_kind = 'pull-request' THEN node_id END) AS pullRequests,
            COUNT(DISTINCT CASE WHEN endpoint_kind = 'pipeline-execution' THEN node_id END) AS pipelineExecutions
          FROM resolved_endpoints`
        const summaries = yield* decodeRows(
          Schema.Struct({
            issues: Schema.Int,
            pullRequests: Schema.Int,
            pipelineExecutions: Schema.Int
          }),
          rows
        )
        const value = summaries[0]
        if (value === undefined) return yield* Effect.die("release relationship summary query returned no row")
        return DeliveryGraphReadResult.make({ _tag: "releaseSummary", value })
      }
    }
  })

  return { readDecoded }
})
