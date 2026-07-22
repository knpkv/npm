import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

import { Freshness } from "./freshness.js"
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
} from "./identifiers.js"
import { NormalizedIssueAttributes } from "./normalizedIssue.js"
import { NormalizedPageAttributes } from "./normalizedPage.js"
import { UtcTimestamp } from "./utcTimestamp.js"

const boundedText = (maximum: number, identifier: string) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximum)
  ).annotate({ identifier })

/** Provider-neutral kind of an object participating in delivery. */
export const DeliveryEntityKind = Schema.Literals([
  "issue",
  "pull-request",
  "page",
  "pipeline-execution",
  "deployment",
  "time-entry"
])

/** Decoded normalized entity kind. */
export type DeliveryEntityKind = typeof DeliveryEntityKind.Type

/** Connected service responsible for a normalized delivery entity. */
export const DeliveryEntityService = Schema.Literals([
  "jira",
  "codecommit",
  "confluence",
  "codepipeline",
  "clockify"
])

/** Decoded connected delivery service. */
export type DeliveryEntityService = typeof DeliveryEntityService.Type

/** Coarse cross-provider lifecycle used by workspace item search. */
export const DeliveryEntityStatusGroup = Schema.Literals(["active", "done", "failed"])

/** Decoded cross-provider lifecycle group. */
export type DeliveryEntityStatusGroup = typeof DeliveryEntityStatusGroup.Type

/** Canonical semantic kind recorded for either endpoint of a relationship. */
export const RelationshipEndpointKind = Schema.Union([
  DeliveryEntityKind,
  Schema.Literals(["release", "environment"])
])

/** Decoded semantic relationship endpoint kind. */
export type RelationshipEndpointKind = typeof RelationshipEndpointKind.Type

/** Positive immutable revision of a normalized entity or relationship. */
export const LedgerRevision = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("LedgerRevision")
)

/** Decoded ledger revision. */
export type LedgerRevision = typeof LedgerRevision.Type

const IssueDetails = Schema.TaggedStruct("issue", {
  ...NormalizedIssueAttributes.fields
})

const PullRequestDetails = Schema.TaggedStruct("pull-request", {
  repository: boundedText(200, "RepositoryName"),
  sourceBranch: boundedText(500, "SourceBranch"),
  targetBranch: boundedText(500, "TargetBranch"),
  headRevision: boundedText(512, "HeadRevision"),
  reviewState: Schema.Literals(["not-requested", "requested", "changes-requested", "approved", "merged"]),
  lifecycle: Schema.optionalKey(Schema.NullOr(Schema.Literals(["open", "closed", "merged"]))),
  description: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(50_000)))),
  authorReference: Schema.optionalKey(Schema.NullOr(boundedText(512, "PullRequestAuthorReference"))),
  baseRevision: Schema.optionalKey(Schema.NullOr(boundedText(512, "BaseRevision"))),
  mergeBaseRevision: Schema.optionalKey(Schema.NullOr(boundedText(512, "MergeBaseRevision"))),
  createdAt: Schema.optionalKey(Schema.NullOr(boundedText(64, "PullRequestCreatedAt"))),
  updatedAt: Schema.optionalKey(Schema.NullOr(boundedText(64, "PullRequestUpdatedAt")))
})

const PageDetails = Schema.TaggedStruct("page", {
  ...NormalizedPageAttributes.fields,
  spaceKey: boundedText(100, "SpaceKey"),
  revision: boundedText(512, "PageRevision"),
  status: Schema.Literals(["draft", "current", "superseded"]),
  linkedIssueKeys: Schema.optional(
    Schema.Array(boundedText(100, "LinkedIssueKey")).check(Schema.isUnique(), Schema.isMaxLength(100))
  ),
  linkedReleaseVersions: Schema.optional(
    Schema.Array(boundedText(100, "LinkedReleaseVersion")).check(Schema.isUnique(), Schema.isMaxLength(100))
  )
})

const PipelineExecutionStatus = Schema.Literals(["queued", "running", "succeeded", "failed", "stopped"])

const PipelineSourceRevision = Schema.Struct({
  actionName: boundedText(200, "PipelineSourceActionName"),
  revisionId: Schema.NullOr(boundedText(512, "PipelineSourceRevisionId")),
  revisionSummary: Schema.NullOr(boundedText(500, "PipelineSourceRevisionSummary"))
})

const PipelineStage = Schema.Struct({
  name: boundedText(200, "PipelineStageName"),
  status: PipelineExecutionStatus,
  actionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  actionsTruncated: Schema.Boolean
})

const PipelineActionArtifact = Schema.Struct({
  name: boundedText(200, "PipelineActionArtifactName"),
  direction: Schema.Literals(["input", "output"]),
  access: Schema.Literal("proxy-required")
})

const PipelineAction = Schema.Struct({
  actionExecutionId: boundedText(512, "PipelineActionExecutionId"),
  stageName: boundedText(200, "PipelineActionStageName"),
  actionName: boundedText(200, "PipelineActionName"),
  status: PipelineExecutionStatus,
  startedAt: Schema.NullOr(UtcTimestamp),
  updatedAt: Schema.NullOr(UtcTimestamp),
  updatedBy: Schema.NullOr(boundedText(512, "PipelineActionActor")),
  category: Schema.NullOr(boundedText(100, "PipelineActionCategory")),
  provider: Schema.NullOr(boundedText(100, "PipelineActionProvider")),
  owner: Schema.NullOr(boundedText(100, "PipelineActionOwner")),
  version: Schema.NullOr(boundedText(100, "PipelineActionVersion")),
  region: Schema.NullOr(boundedText(100, "PipelineActionRegion")),
  externalExecutionSummary: Schema.NullOr(boundedText(500, "PipelineExternalExecutionSummary")),
  errorCode: Schema.NullOr(boundedText(200, "PipelineActionErrorCode")),
  errorMessage: Schema.NullOr(boundedText(500, "PipelineActionErrorMessage")),
  artifacts: Schema.Array(PipelineActionArtifact).check(Schema.isMaxLength(100))
})

const PipelineSourceArtifact = Schema.Struct({
  name: boundedText(200, "PipelineSourceArtifactName"),
  revisionId: Schema.NullOr(boundedText(512, "PipelineSourceArtifactRevisionId")),
  revisionSummary: Schema.NullOr(boundedText(500, "PipelineSourceArtifactRevisionSummary")),
  createdAt: Schema.NullOr(UtcTimestamp),
  access: Schema.Literal("proxy-required")
})

const PipelineDetails = Schema.TaggedStruct("pipeline-execution", {
  pipelineName: boundedText(200, "PipelineName"),
  executionId: boundedText(512, "PipelineExecutionId"),
  status: PipelineExecutionStatus,
  triggerRevision: boundedText(512, "PipelineTriggerRevision"),
  pipelineVersion: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  statusSummary: Schema.optionalKey(Schema.NullOr(boundedText(500, "PipelineStatusSummary"))),
  startedAt: Schema.optionalKey(Schema.NullOr(UtcTimestamp)),
  updatedAt: Schema.optionalKey(Schema.NullOr(UtcTimestamp)),
  triggerType: Schema.optionalKey(Schema.NullOr(boundedText(100, "PipelineTriggerType"))),
  triggerDetail: Schema.optionalKey(Schema.NullOr(boundedText(500, "PipelineTriggerDetail"))),
  executionMode: Schema.optionalKey(Schema.NullOr(boundedText(100, "PipelineExecutionMode"))),
  executionType: Schema.optionalKey(Schema.NullOr(boundedText(100, "PipelineExecutionType"))),
  rollbackTargetExecutionId: Schema.optionalKey(
    Schema.NullOr(boundedText(512, "PipelineRollbackTargetExecutionId"))
  ),
  sourceRevisions: Schema.optionalKey(
    Schema.Array(PipelineSourceRevision).check(
      Schema.makeFilter(
        (revisions) => new Set(revisions.map((revision) => revision.actionName)).size === revisions.length,
        { expected: "unique pipeline source action names" }
      ),
      Schema.isMaxLength(100)
    )
  ),
  stages: Schema.optionalKey(
    Schema.Array(PipelineStage).check(
      Schema.makeFilter(
        (stages) => new Set(stages.map((stage) => stage.name)).size === stages.length,
        { expected: "unique pipeline stage names" }
      ),
      Schema.isMaxLength(100)
    )
  ),
  actions: Schema.optionalKey(
    Schema.Array(PipelineAction).check(
      Schema.makeFilter(
        (actions) => new Set(actions.map((action) => action.actionExecutionId)).size === actions.length,
        { expected: "unique pipeline action execution identifiers" }
      ),
      Schema.isMaxLength(200)
    )
  ),
  actionCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  actionsTruncated: Schema.optionalKey(Schema.Boolean),
  actionPagesRead: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
  sourceArtifacts: Schema.optionalKey(
    Schema.Array(PipelineSourceArtifact).check(Schema.isMaxLength(100))
  )
})

const DeploymentDetails = Schema.TaggedStruct("deployment", {
  environmentId: EnvironmentId,
  revision: boundedText(512, "DeploymentRevision"),
  status: Schema.Literals(["pending", "deploying", "succeeded", "failed", "rolled-back"])
})

const TimeEntryDetails = Schema.TaggedStruct("time-entry", {
  durationMinutes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  billable: Schema.Boolean,
  approvalState: Schema.Literals(["pending", "approved", "rejected", "not-required"])
})

/** Provider-neutral entity extension decoded before graph persistence. */
export const DeliveryEntityDetails = Schema.Union([
  IssueDetails,
  PullRequestDetails,
  PageDetails,
  PipelineDetails,
  DeploymentDetails,
  TimeEntryDetails
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded provider-neutral entity details. */
export type DeliveryEntityDetails = typeof DeliveryEntityDetails.Type

/** Immutable normalized projection for one exact entity source revision. */
export const DeliveryEntityProjection = Schema.Struct({
  workspaceId: WorkspaceId,
  entityId: EntityId,
  projectionRevision: LedgerRevision,
  sourceEntityRevision: LedgerRevision,
  supersedesProjectionRevision: Schema.NullOr(LedgerRevision),
  projectionSchemaVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  entityState: Schema.Literals(["present", "deleted"]),
  entityType: DeliveryEntityKind,
  displayKey: boundedText(200, "EntityDisplayKey"),
  title: boundedText(500, "EntityTitle"),
  details: DeliveryEntityDetails
}).check(
  Schema.makeFilter(
    ({ details, entityType }) => details._tag === entityType,
    { expected: "entity details whose tag matches the entity kind" }
  ),
  Schema.makeFilter(
    ({ projectionRevision, supersedesProjectionRevision }) =>
      projectionRevision === 1
        ? supersedesProjectionRevision === null
        : supersedesProjectionRevision === projectionRevision - 1,
    { expected: "entity projection to supersede its exact preceding revision" }
  )
)

/** Decoded normalized entity projection. */
export type DeliveryEntityProjection = typeof DeliveryEntityProjection.Type

/** Resolved graph target with an exact canonical object identity. */
export const ResolvedDeliveryNode = Schema.TaggedUnion({
  entity: { entityId: EntityId, entityKind: DeliveryEntityKind },
  environment: { environmentId: EnvironmentId, releaseId: ReleaseId },
  release: { releaseId: ReleaseId }
})

/** Resolved or intentionally missing node stored as trusted graph state. */
export const DeliveryNode = Schema.Struct({
  workspaceId: WorkspaceId,
  nodeId: GraphNodeId,
  endpointKind: RelationshipEndpointKind,
  resolution: Schema.TaggedUnion({
    resolved: { target: ResolvedDeliveryNode },
    missing: {
      expectedKind: Schema.Literals(["entity", "release", "environment"]),
      expectedEntityKind: Schema.NullOr(DeliveryEntityKind),
      missingKey: boundedText(512, "MissingDeliveryNodeKey")
    }
  }),
  createdAt: UtcTimestamp
}).check(
  Schema.makeFilter(
    ({ resolution }) =>
      resolution._tag !== "missing" ||
      (resolution.expectedKind === "entity") === (resolution.expectedEntityKind !== null),
    { expected: "only missing entity nodes to carry an expected entity kind" }
  ),
  Schema.makeFilter(
    ({ endpointKind, resolution }) => {
      if (resolution._tag === "missing") {
        return resolution.expectedKind === "entity"
          ? endpointKind === resolution.expectedEntityKind
          : endpointKind === resolution.expectedKind
      }

      return resolution.target._tag === "entity"
        ? endpointKind === resolution.target.entityKind
        : endpointKind === resolution.target._tag
    },
    { expected: "graph node endpoint kind to match its resolved or expected target kind" }
  )
)

/** Decoded graph node. */
export type DeliveryNode = typeof DeliveryNode.Type

/** Semantic relationship between delivery nodes. Direction is significant. */
export const RelationshipKind = Schema.Literals([
  "contains",
  "implements",
  "depends-on",
  "verified-by",
  "delivered-by",
  "documented-by",
  "tracks-time-for"
])

/** Decoded relationship kind. */
export type RelationshipKind = typeof RelationshipKind.Type

const ALL_RELATIONSHIP_ENDPOINT_KINDS: ReadonlyArray<RelationshipEndpointKind> = [
  "issue",
  "pull-request",
  "page",
  "pipeline-execution",
  "deployment",
  "time-entry",
  "release",
  "environment"
]

const ALL_ENTITY_ENDPOINT_KINDS: ReadonlyArray<RelationshipEndpointKind> = [
  "issue",
  "pull-request",
  "page",
  "pipeline-execution",
  "deployment",
  "time-entry"
]

type RelationshipEndpointRule = Readonly<{
  source: ReadonlyArray<RelationshipEndpointKind>
  target: ReadonlyArray<RelationshipEndpointKind>
}>

/**
 * Version-one canonical direction matrix. Passive relationship names read from
 * source to target: for example, a pull request is `delivered-by` a pipeline
 * execution. `depends-on` is intentionally the one generic graph edge.
 */
export const RELATIONSHIP_ENDPOINT_MATRIX_V1: Readonly<
  Record<RelationshipKind, RelationshipEndpointRule>
> = {
  "contains": { source: ["release"], target: ALL_ENTITY_ENDPOINT_KINDS },
  "implements": { source: ["pull-request"], target: ["issue"] },
  "depends-on": {
    source: ALL_RELATIONSHIP_ENDPOINT_KINDS,
    target: ALL_RELATIONSHIP_ENDPOINT_KINDS
  },
  "verified-by": { source: ["pull-request"], target: ["pipeline-execution"] },
  "delivered-by": { source: ["pull-request"], target: ["pipeline-execution"] },
  "documented-by": { source: ["issue", "release"], target: ["page"] },
  "tracks-time-for": { source: ["time-entry"], target: ["issue"] }
}

const relationshipEndpointIsAllowed = (
  kind: RelationshipKind,
  sourceNodeKind: RelationshipEndpointKind,
  targetNodeKind: RelationshipEndpointKind
): boolean => {
  const rule: RelationshipEndpointRule = RELATIONSHIP_ENDPOINT_MATRIX_V1[kind]
  return rule.source.some((candidate) => candidate === sourceNodeKind) &&
    rule.target.some((candidate) => candidate === targetNodeKind)
}

/** Explainable confidence; inferred links can never masquerade as confirmed. */
export const RelationshipConfidence = Schema.TaggedUnion({
  unknown: { rationale: boundedText(1_000, "UnknownRelationshipConfidenceRationale") },
  confirmed: {},
  inferred: {
    score: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    rationale: boundedText(1_000, "RelationshipConfidenceRationale")
  }
})

/** Decoded relationship confidence. */
export type RelationshipConfidence = typeof RelationshipConfidence.Type

/** Attribution for creation of a relationship revision. */
export const RelationshipProvenance = Schema.TaggedUnion({
  plugin: {
    pluginConnectionId: PluginConnectionId,
    sourceEntityId: EntityId,
    sourceEntityRevision: LedgerRevision
  },
  human: { personId: PersonId, rationale: boundedText(1_000, "HumanRelationshipRationale") },
  agent: { agentId: AgentId, rationale: boundedText(1_000, "AgentRelationshipRationale") },
  rule: {
    ruleId: boundedText(200, "RelationshipRuleId"),
    ruleVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    rationale: boundedText(1_000, "RuleRelationshipRationale")
  }
})

/** Decoded relationship provenance. */
export type RelationshipProvenance = typeof RelationshipProvenance.Type

/** Lifecycle of one relationship revision. Prior revisions remain immutable. */
export const RelationshipLifecycle = Schema.TaggedUnion({
  missing: { effectiveAt: UtcTimestamp, reason: boundedText(1_000, "MissingRelationshipReason") },
  inferred: { effectiveAt: UtcTimestamp },
  proposed: { effectiveAt: UtcTimestamp },
  verified: { effectiveAt: UtcTimestamp },
  governed: { effectiveAt: UtcTimestamp },
  rejected: { effectiveAt: UtcTimestamp, reason: boundedText(1_000, "RejectionReason") },
  superseded: { effectiveAt: UtcTimestamp, reason: boundedText(1_000, "SupersessionReason") }
})

/** Decoded relationship lifecycle. */
export type RelationshipLifecycle = typeof RelationshipLifecycle.Type

/** Exact release or environment slice in which a relationship is evaluated. */
export const RelationshipScope = Schema.NullOr(
  Schema.TaggedUnion({
    release: { releaseId: ReleaseId },
    environment: { releaseId: ReleaseId, environmentId: EnvironmentId }
  })
)

/** Human, agent, or system that appended an immutable ledger revision. */
export const LedgerActor = Schema.TaggedUnion({
  human: { personId: PersonId },
  agent: { agentId: AgentId },
  system: { component: boundedText(200, "LedgerSystemComponent") }
})

/** Immutable relationship ledger revision. */
export const DeliveryRelationship = Schema.Struct({
  workspaceId: WorkspaceId,
  relationshipId: RelationshipId,
  relationshipSchemaVersion: Schema.Literal(1),
  revision: LedgerRevision,
  supersedesRevision: Schema.NullOr(LedgerRevision),
  kind: RelationshipKind,
  sourceNodeId: GraphNodeId,
  sourceNodeKind: RelationshipEndpointKind,
  targetNodeId: GraphNodeId,
  targetNodeKind: RelationshipEndpointKind,
  scope: RelationshipScope,
  lifecycle: RelationshipLifecycle,
  confidence: RelationshipConfidence,
  provenance: RelationshipProvenance,
  recordedBy: LedgerActor,
  evidenceClaimIds: Schema.Array(EvidenceClaimId).check(Schema.isMaxLength(128)),
  recordedAt: UtcTimestamp
}).check(
  Schema.makeFilter(
    ({ evidenceClaimIds }) => new Set(evidenceClaimIds).size === evidenceClaimIds.length,
    { expected: "relationship evidence references to be unique" }
  ),
  Schema.makeFilter(
    ({ confidence, evidenceClaimIds }) => confidence._tag !== "confirmed" || evidenceClaimIds.length > 0,
    { expected: "confirmed relationship confidence to reference immutable evidence" }
  ),
  Schema.makeFilter(
    ({ sourceNodeId, targetNodeId }) => sourceNodeId !== targetNodeId,
    { expected: "relationship source and target to differ" }
  ),
  Schema.makeFilter(
    ({ kind, sourceNodeKind, targetNodeKind }) => relationshipEndpointIsAllowed(kind, sourceNodeKind, targetNodeKind),
    { expected: "relationship endpoints to follow the canonical version-one direction matrix" }
  ),
  Schema.makeFilter(
    ({ kind, scope }) => kind !== "contains" || scope !== null,
    { expected: "release containment to carry an explicit release or environment scope" }
  ),
  Schema.makeFilter(
    ({ confidence, lifecycle }) => lifecycle._tag !== "inferred" || confidence._tag !== "confirmed",
    { expected: "an inferred relationship lifecycle not to claim confirmed confidence" }
  ),
  Schema.makeFilter(
    ({ revision, supersedesRevision }) =>
      revision === 1 ? supersedesRevision === null : supersedesRevision === revision - 1,
    { expected: "relationship to supersede its exact preceding revision" }
  )
)

/** Decoded relationship ledger revision. */
export type DeliveryRelationship = typeof DeliveryRelationship.Type

/** Closed assertion vocabulary used by immutable evidence claims. */
export const EvidencePredicate = Schema.Literals([
  "relationship-observed",
  "status-observed",
  "approval-recorded",
  "check-observed",
  "execution-observed",
  "deployment-observed",
  "documentation-observed",
  "time-observed"
])

/** Decoded evidence predicate. */
export type EvidencePredicate = typeof EvidencePredicate.Type

/** Bounded, provider-neutral evidence value. */
export const EvidenceValue = Schema.TaggedUnion({
  flag: { value: Schema.Boolean },
  state: { value: boundedText(500, "EvidenceState") },
  revision: { value: boundedText(512, "EvidenceRevision") },
  reference: { targetNodeId: GraphNodeId }
})

/** Decoded evidence value. */
export type EvidenceValue = typeof EvidenceValue.Type

/** Exact actor or source revision responsible for an evidence claim. */
export const EvidenceAttribution = Schema.TaggedUnion({
  plugin: {
    pluginConnectionId: PluginConnectionId,
    sourceEntityId: EntityId,
    sourceEntityRevision: LedgerRevision
  },
  human: { personId: PersonId },
  agent: { agentId: AgentId },
  system: { component: boundedText(200, "EvidenceSystemComponent") }
})

/** Decoded evidence attribution. */
export type EvidenceAttribution = typeof EvidenceAttribution.Type

/** Explicit retention policy attached when evidence is recorded. */
export const EvidenceRetention = Schema.Struct({
  classification: Schema.Literals(["audit", "evidence", "normalized-cache"]),
  retainUntil: Schema.NullOr(UtcTimestamp),
  legalHold: Schema.Boolean
})

/** Decoded evidence retention metadata. */
export type EvidenceRetention = typeof EvidenceRetention.Type

/** Independent verification of an evidence observation. */
export const EvidenceVerifier = Schema.TaggedUnion({
  human: { personId: PersonId },
  agent: { agentId: AgentId },
  system: { component: boundedText(200, "EvidenceVerifierComponent") }
})

/** Immutable observation envelope with provenance, validity, and retention. */
export const EvidenceItem = Schema.Struct({
  workspaceId: WorkspaceId,
  evidenceId: EvidenceId,
  schemaVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  attribution: EvidenceAttribution,
  verifier: EvidenceVerifier,
  observedAt: UtcTimestamp,
  recordedAt: UtcTimestamp,
  validUntil: Schema.NullOr(UtcTimestamp),
  freshness: Freshness,
  retention: EvidenceRetention
}).check(
  Schema.makeFilter(
    ({ attribution, freshness }) => {
      if (attribution._tag !== "plugin") return true

      return freshness.provenance._tag !== "none" &&
        attribution.pluginConnectionId === freshness.provenance.sourceRevision.pluginConnectionId
    },
    { expected: "plugin evidence attribution to carry its exact freshness source revision" }
  ),
  Schema.makeFilter(
    ({ observedAt, recordedAt }) => DateTime.Order(observedAt, recordedAt) <= 0,
    { expected: "evidence observation time not to follow recording time" }
  ),
  Schema.makeFilter(
    ({ observedAt, validUntil }) => validUntil === null || DateTime.Order(observedAt, validUntil) < 0,
    { expected: "evidence validity to end after observation" }
  ),
  Schema.makeFilter(
    ({ recordedAt, retention }) =>
      retention.retainUntil === null || DateTime.Order(recordedAt, retention.retainUntil) <= 0,
    { expected: "evidence retention not to end before recording" }
  )
)

/** Decoded immutable evidence observation. */
export type EvidenceItem = typeof EvidenceItem.Type

/** One immutable normalized claim derived from an evidence observation. */
export const EvidenceClaim = Schema.Struct({
  workspaceId: WorkspaceId,
  evidenceClaimId: EvidenceClaimId,
  evidenceId: EvidenceId,
  subjectNodeId: GraphNodeId,
  predicate: EvidencePredicate,
  value: EvidenceValue,
  recordedAt: UtcTimestamp,
  supersedesEvidenceClaimId: Schema.NullOr(EvidenceClaimId)
}).check(
  Schema.makeFilter(
    ({ evidenceClaimId, supersedesEvidenceClaimId }) => evidenceClaimId !== supersedesEvidenceClaimId,
    { expected: "evidence not to supersede itself" }
  )
)

/** Decoded immutable evidence claim. */
export type EvidenceClaim = typeof EvidenceClaim.Type

/** Independent source availability and validity dimensions for an evidence item. */
export type EvidenceFreshnessAssessment = Readonly<{
  source: "current" | "stale" | "missing" | "unavailable"
  validity: "valid" | "expired"
}>

const sourceFreshnessAt = (
  freshness: Freshness,
  at: DateTime.DateTime
): EvidenceFreshnessAssessment["source"] => {
  if (freshness._tag !== "current") return freshness._tag

  const ageMilliseconds = DateTime.toEpochMillis(at) - DateTime.toEpochMillis(freshness.sourceObservedAt)
  return ageMilliseconds < freshness.staleAfterSeconds * 1_000 ? "current" : "stale"
}

/** Determine source freshness and evidence validity at an injected instant. */
export const evidenceFreshnessAt = (
  evidence: EvidenceItem,
  at: DateTime.DateTime
): EvidenceFreshnessAssessment => ({
  source: sourceFreshnessAt(evidence.freshness, at),
  validity: evidence.validUntil === null || DateTime.Order(at, evidence.validUntil) < 0
    ? "valid"
    : "expired"
})

/** Determine whether retained evidence bytes are eligible for governed cleanup. */
export const evidenceRetentionEligibilityAt = (
  evidence: EvidenceItem,
  at: DateTime.DateTime
): "retain" | "eligible" =>
  !evidence.retention.legalHold &&
    evidence.retention.retainUntil !== null &&
    DateTime.Order(evidence.retention.retainUntil, at) <= 0
    ? "eligible"
    : "retain"
