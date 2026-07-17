import { Schema, SchemaTransformation } from "effect"

const CANONICAL_LOWERCASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const canonicalUuid7 = <const Brand extends string>(brand: Brand) =>
  Schema.String.check(Schema.isUUID(7)).pipe(
    Schema.decodeTo(
      Schema.String.check(
        Schema.isUUID(7),
        Schema.isPattern(CANONICAL_LOWERCASE_UUID_PATTERN, {
          expected: "a canonical lowercase UUID v7"
        })
      ),
      SchemaTransformation.toLowerCase()
    ),
    Schema.brand(brand)
  )

/** Canonical identifier of an isolated Control Center workspace. */
export const WorkspaceId = canonicalUuid7("WorkspaceId")

/** Decoded workspace identifier. */
export type WorkspaceId = typeof WorkspaceId.Type

/** Canonical identifier of a release aggregate. */
export const ReleaseId = canonicalUuid7("ReleaseId")

/** Decoded release identifier. */
export type ReleaseId = typeof ReleaseId.Type

/** Canonical identifier of a normalized delivery entity. */
export const EntityId = canonicalUuid7("EntityId")

/** Decoded delivery-entity identifier. */
export type EntityId = typeof EntityId.Type

/** Canonical identifier of a human collaborator. */
export const PersonId = canonicalUuid7("PersonId")

/** Decoded person identifier. */
export type PersonId = typeof PersonId.Type

/** Canonical identifier of an automated agent. */
export const AgentId = canonicalUuid7("AgentId")

/** Decoded agent identifier. */
export type AgentId = typeof AgentId.Type

/** Canonical identifier of a deployment environment. */
export const EnvironmentId = canonicalUuid7("EnvironmentId")

/** Decoded environment identifier. */
export type EnvironmentId = typeof EnvironmentId.Type

/** Canonical identifier of a configured plugin connection. */
export const PluginConnectionId = canonicalUuid7("PluginConnectionId")

/** Decoded plugin-connection identifier. */
export type PluginConnectionId = typeof PluginConnectionId.Type

/** Canonical identifier of a collaborator role assignment. */
export const RoleAssignmentId = canonicalUuid7("RoleAssignmentId")

/** Decoded role-assignment identifier. */
export type RoleAssignmentId = typeof RoleAssignmentId.Type

/** Canonical identifier of one delivery-graph relationship. */
export const RelationshipId = canonicalUuid7("RelationshipId")

/** Decoded delivery-graph relationship identifier. */
export type RelationshipId = typeof RelationshipId.Type

/** Canonical identifier of one governed relationship-repair proposal. */
export const RelationshipRepairProposalId = canonicalUuid7("RelationshipRepairProposalId")

/** Decoded relationship-repair proposal identifier. */
export type RelationshipRepairProposalId = typeof RelationshipRepairProposalId.Type

/** Canonical identifier of one immutable relationship-repair review. */
export const RelationshipRepairReviewId = canonicalUuid7("RelationshipRepairReviewId")

/** Decoded relationship-repair review identifier. */
export type RelationshipRepairReviewId = typeof RelationshipRepairReviewId.Type

/** Canonical identifier of one immutable evidence claim. */
export const EvidenceClaimId = canonicalUuid7("EvidenceClaimId")

/** Decoded immutable evidence-claim identifier. */
export type EvidenceClaimId = typeof EvidenceClaimId.Type

/** Canonical identifier of one immutable evidence observation envelope. */
export const EvidenceId = canonicalUuid7("EvidenceId")

/** Decoded immutable evidence observation identifier. */
export type EvidenceId = typeof EvidenceId.Type

/** Canonical identifier of one immutable readiness assessment. */
export const ReadinessAssessmentId = canonicalUuid7("ReadinessAssessmentId")

/** Decoded immutable readiness-assessment identifier. */
export type ReadinessAssessmentId = typeof ReadinessAssessmentId.Type

/** Canonical identifier of one resolved or explicitly missing graph node. */
export const GraphNodeId = canonicalUuid7("GraphNodeId")

/** Decoded graph-node identifier. */
export type GraphNodeId = typeof GraphNodeId.Type

/** Workspace-local monotonic position used for durable event replay. */
export const EventCursor = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("EventCursor"))

/** Decoded nonnegative event position; persisted event rows start at one. */
export type EventCursor = typeof EventCursor.Type

/** Canonical identifier of one durable domain event. */
export const DomainEventId = canonicalUuid7("DomainEventId")

/** Decoded durable domain-event identifier. */
export type DomainEventId = typeof DomainEventId.Type

/** Canonical identifier of one asynchronous Control Center job. */
export const JobId = canonicalUuid7("JobId")

/** Decoded asynchronous job identifier. */
export type JobId = typeof JobId.Type

/** Canonical identifier of an authenticated browser session. */
export const SessionId = canonicalUuid7("SessionId")

/** Decoded authenticated browser-session identifier. */
export type SessionId = typeof SessionId.Type

/** Canonical identifier of one exact-scope authenticated share grant. */
export const ShareId = canonicalUuid7("ShareId")

/** Decoded authorized-share identifier. */
export type ShareId = typeof ShareId.Type

/** Canonical identifier of one governed provider action. */
export const GovernedActionId = canonicalUuid7("GovernedActionId")

/** Decoded governed-action identifier. */
export type GovernedActionId = typeof GovernedActionId.Type

/** Canonical identifier of one immutable governed-action transition. */
export const GovernedActionTransitionId = canonicalUuid7("GovernedActionTransitionId")

/** Decoded governed-action transition identifier. */
export type GovernedActionTransitionId = typeof GovernedActionTransitionId.Type

/** Canonical identifier of one immutable human action authorization. */
export const GovernedActionAuthorizationId = canonicalUuid7("GovernedActionAuthorizationId")

/** Decoded governed-action authorization identifier. */
export type GovernedActionAuthorizationId = typeof GovernedActionAuthorizationId.Type

/** Canonical identifier of one governed-action execution attempt. */
export const GovernedActionAttemptId = canonicalUuid7("GovernedActionAttemptId")

/** Decoded governed-action attempt identifier. */
export type GovernedActionAttemptId = typeof GovernedActionAttemptId.Type
