import * as Schema from "effect/Schema"

import {
  DeliveryEntityProjection,
  DeliveryNode,
  DeliveryRelationship,
  EvidenceClaim,
  EvidenceItem,
  EvidenceValue,
  LedgerRevision,
  RelationshipEndpointKind
} from "../../../../domain/deliveryGraph.js"
import { Freshness } from "../../../../domain/freshness.js"
import {
  AgentId,
  EntityId,
  EnvironmentId,
  EvidenceClaimId,
  EvidenceId,
  GraphNodeId,
  PersonId,
  PluginConnectionId,
  RelationshipId,
  ReleaseId,
  WorkspaceId
} from "../../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { PersistedRecordError } from "../../errors.js"
import { ContentBlobDigest } from "../models.js"

export const DELIVERY_GRAPH_SCHEMA_VERSION = 1

export const ProjectionRow = Schema.Struct({
  workspaceId: WorkspaceId,
  entityId: EntityId,
  projectionRevision: LedgerRevision,
  sourceEntityRevision: LedgerRevision,
  supersedesProjectionRevision: Schema.NullOr(LedgerRevision),
  projectionSchemaVersion: Schema.Int,
  entityState: Schema.Literals(["present", "deleted"]),
  entityType: DeliveryEntityProjection.fields.entityType,
  displayKey: Schema.String,
  title: Schema.String,
  extensionJson: Schema.String,
  extensionDigest: ContentBlobDigest,
  recordedAt: Schema.String
})

export const WorkspaceProjectionRow = Schema.Struct({
  ...ProjectionRow.fields,
  ownerIdentitiesJson: Schema.String,
  releaseIdsJson: Schema.String
})

export const NodeRow = Schema.Struct({
  workspaceId: WorkspaceId,
  nodeId: GraphNodeId,
  nodeKeyDigest: ContentBlobDigest,
  nodeKind: Schema.Literals(["entity", "release", "environment"]),
  endpointKind: RelationshipEndpointKind,
  resolutionState: Schema.Literals(["resolved", "missing"]),
  entityId: Schema.NullOr(EntityId),
  releaseId: Schema.NullOr(ReleaseId),
  environmentId: Schema.NullOr(EnvironmentId),
  expectedEntityKind: Schema.NullOr(DeliveryEntityProjection.fields.entityType),
  missingKey: Schema.NullOr(Schema.String),
  createdAt: Schema.String
})

export const EvidenceRow = Schema.Struct({
  workspaceId: WorkspaceId,
  evidenceId: EvidenceId,
  schemaVersion: Schema.Int,
  evidenceDigest: ContentBlobDigest,
  originKind: Schema.Literals(["plugin", "human", "agent", "system"]),
  pluginConnectionId: Schema.NullOr(PluginConnectionId),
  sourceEntityId: Schema.NullOr(EntityId),
  sourceEntityRevision: Schema.NullOr(LedgerRevision),
  personId: Schema.NullOr(PersonId),
  agentId: Schema.NullOr(AgentId),
  systemComponent: Schema.NullOr(Schema.String),
  verifierKind: Schema.Literals(["human", "agent", "system"]),
  verifierPersonId: Schema.NullOr(PersonId),
  verifierAgentId: Schema.NullOr(AgentId),
  verifierComponent: Schema.NullOr(Schema.String),
  observedAt: Schema.String,
  recordedAt: Schema.String,
  validUntil: Schema.NullOr(Schema.String),
  freshnessJson: Schema.String,
  freshnessDigest: ContentBlobDigest,
  retentionClass: EvidenceItem.fields.retention.fields.classification,
  retainUntil: Schema.NullOr(Schema.String),
  legalHold: Schema.Number
})

export const ClaimRow = Schema.Struct({
  workspaceId: WorkspaceId,
  evidenceClaimId: EvidenceClaimId,
  evidenceId: EvidenceId,
  subjectNodeId: GraphNodeId,
  predicate: EvidenceClaim.fields.predicate,
  valueJson: Schema.String,
  valueDigest: ContentBlobDigest,
  supersedesEvidenceClaimId: Schema.NullOr(EvidenceClaimId),
  recordedAt: Schema.String
})

export const RelationshipRow = Schema.Struct({
  workspaceId: WorkspaceId,
  relationshipId: RelationshipId,
  revision: LedgerRevision,
  supersedesRevision: Schema.NullOr(LedgerRevision),
  relationshipSchemaVersion: Schema.Literal(1),
  kind: DeliveryRelationship.fields.kind,
  sourceNodeId: GraphNodeId,
  sourceNodeKind: RelationshipEndpointKind,
  targetNodeId: GraphNodeId,
  targetNodeKind: RelationshipEndpointKind,
  lifecycle: Schema.String,
  lifecycleReason: Schema.NullOr(Schema.String),
  releaseId: Schema.NullOr(ReleaseId),
  environmentId: Schema.NullOr(EnvironmentId),
  confidenceKind: Schema.String,
  confidenceScore: Schema.NullOr(Schema.Number),
  confidenceRationale: Schema.NullOr(Schema.String),
  provenanceKind: Schema.String,
  provenancePluginConnectionId: Schema.NullOr(PluginConnectionId),
  provenanceSourceEntityId: Schema.NullOr(EntityId),
  provenanceSourceEntityRevision: Schema.NullOr(LedgerRevision),
  provenancePersonId: Schema.NullOr(PersonId),
  provenanceAgentId: Schema.NullOr(AgentId),
  provenanceRuleId: Schema.NullOr(Schema.String),
  provenanceRuleVersion: Schema.NullOr(Schema.Int),
  provenanceRationale: Schema.NullOr(Schema.String),
  recordedByKind: Schema.String,
  recordedByPersonId: Schema.NullOr(PersonId),
  recordedByAgentId: Schema.NullOr(AgentId),
  recordedByComponent: Schema.NullOr(Schema.String),
  effectiveAt: Schema.String,
  recordedAt: Schema.String,
  revisionDigest: ContentBlobDigest,
  evidenceClaimIds: Schema.Array(EvidenceClaimId)
})

export const projectionJson = Schema.fromJsonString(DeliveryEntityProjection.fields.details)
export const evidenceJson = Schema.fromJsonString(EvidenceItem)
export const freshnessJson = Schema.fromJsonString(Freshness)
export const evidenceValueJson = Schema.fromJsonString(EvidenceValue)
export const nodeResolutionJson = Schema.fromJsonString(DeliveryNode.fields.resolution)
export const relationshipJson = Schema.fromJsonString(DeliveryRelationship)
export const edgeJson = Schema.fromJsonString(Schema.Struct({
  kind: DeliveryRelationship.fields.kind,
  sourceNodeId: GraphNodeId,
  sourceNodeKind: RelationshipEndpointKind,
  targetNodeId: GraphNodeId,
  targetNodeKind: RelationshipEndpointKind,
  scope: DeliveryRelationship.fields.scope
}))

export const encodeTimestamp = Schema.encodeSync(UtcTimestamp)

export const decodeRows = <SchemaType extends Schema.Top>(schema: SchemaType, rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows)

export const graphRecordError = (
  workspaceId: WorkspaceId,
  recordKind: string,
  recordKey: string,
  diagnosticCode: string
) => new PersistedRecordError({ workspaceId, recordKind, recordKey, diagnosticCode })
