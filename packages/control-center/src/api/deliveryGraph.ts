import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import {
  DeliveryEntityProjection,
  DeliveryNode,
  DeliveryRelationship,
  EvidenceClaim,
  EvidenceItem,
  LedgerRevision
} from "../domain/deliveryGraph.js"
import { EnvironmentId, EvidenceId, RelationshipId, ReleaseId } from "../domain/identifiers.js"
import {
  RelationshipRepairDisposition,
  RelationshipRepairProposal,
  RelationshipRepairRationale
} from "../domain/relationshipRepair.js"
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import {
  ConflictApiError,
  ForbiddenApiError,
  InvalidRequestApiError,
  NotFoundApiError,
  PayloadTooLargeApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { SessionCookieAuth, SessionMutationAuth } from "./session.js"
import { CanonicalNonNegativeIntegerFromString } from "./wire.js"

const MAXIMUM_RELEASE_SLICE_RECORDS = 500
const MAXIMUM_RELATIONSHIP_HISTORY = 200
const MAXIMUM_EVIDENCE_CLAIMS = 200

const boundedArray = <T, E, RD, RE>(schema: Schema.Codec<T, E, RD, RE>, maximum: number) =>
  Schema.Array(schema).check(Schema.isMaxLength(maximum))

/** One persisted entity projection with its ledger observation time. */
export const InspectedEntityProjection = Schema.Struct({
  projection: DeliveryEntityProjection,
  recordedAt: UtcTimestamp
}).annotate({ identifier: "InspectedEntityProjection" })

/** Bounded deterministic graph prefix; `truncated` explicitly reports incomplete material. */
export const ReleaseDeliveryGraphInspection = Schema.Struct({
  releaseId: ReleaseId,
  environmentId: Schema.NullOr(EnvironmentId),
  truncated: Schema.Boolean,
  nodes: boundedArray(DeliveryNode, MAXIMUM_RELEASE_SLICE_RECORDS),
  entityProjections: boundedArray(InspectedEntityProjection, MAXIMUM_RELEASE_SLICE_RECORDS),
  relationships: boundedArray(DeliveryRelationship, MAXIMUM_RELEASE_SLICE_RECORDS),
  evidenceClaims: boundedArray(EvidenceClaim, MAXIMUM_RELEASE_SLICE_RECORDS),
  evidenceItems: boundedArray(EvidenceItem, MAXIMUM_RELEASE_SLICE_RECORDS)
}).annotate({ identifier: "ReleaseDeliveryGraphInspection" })

/** Decoded release delivery-graph inspection. */
export type ReleaseDeliveryGraphInspection = typeof ReleaseDeliveryGraphInspection.Type

/** Bounded immutable lifecycle history for one relationship, newest first. */
export const RelationshipHistoryInspection = Schema.Struct({
  relationshipId: RelationshipId,
  revisions: boundedArray(DeliveryRelationship, MAXIMUM_RELATIONSHIP_HISTORY)
}).annotate({ identifier: "RelationshipHistoryInspection" })

/** Decoded relationship lifecycle history. */
export type RelationshipHistoryInspection = typeof RelationshipHistoryInspection.Type

/** One immutable evidence item and every bounded claim attributed to it. */
export const EvidenceInspection = Schema.Struct({
  evidence: EvidenceItem,
  claims: boundedArray(EvidenceClaim, MAXIMUM_EVIDENCE_CLAIMS)
}).annotate({ identifier: "EvidenceInspection" })

/** Decoded evidence inspection. */
export type EvidenceInspection = typeof EvidenceInspection.Type

/** Read-only repair suggestion derived from one current incomplete relationship. */
export const RelationshipRepairCandidate = Schema.Struct({
  relationship: DeliveryRelationship,
  suggestedDisposition: Schema.Literals(["link", "verify", "reject"]),
  explanation: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_000)),
  impact: Schema.Struct({
    releaseId: ReleaseId,
    environmentId: Schema.NullOr(EnvironmentId)
  }),
  requiredPermission: Schema.Literal("workspace-owner")
}).annotate({ identifier: "RelationshipRepairCandidate" })

/** Decoded read-only relationship repair suggestion. */
export type RelationshipRepairCandidate = typeof RelationshipRepairCandidate.Type

/** Bounded candidate discovery result; discovery never mutates the relationship ledger. */
export const RelationshipRepairCandidates = Schema.Struct({
  releaseId: ReleaseId,
  environmentId: Schema.NullOr(EnvironmentId),
  truncated: Schema.Boolean,
  candidates: boundedArray(RelationshipRepairCandidate, MAXIMUM_RELEASE_SLICE_RECORDS)
}).annotate({ identifier: "RelationshipRepairCandidates" })

/** Decoded relationship repair candidate discovery result. */
export type RelationshipRepairCandidates = typeof RelationshipRepairCandidates.Type

/** Non-mutating proposal input with the optimistic precondition required by a future apply step. */
export const RelationshipRepairProposalDraft = Schema.Struct({
  candidate: RelationshipRepairCandidate,
  precondition: Schema.Struct({
    relationshipId: RelationshipId,
    expectedRevision: LedgerRevision
  }),
  proposal: Schema.Struct({
    disposition: Schema.Literals(["link", "verify", "reject"]),
    rationale: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_000))
  })
}).annotate({ identifier: "RelationshipRepairProposalDraft" })

/** Decoded read-only relationship repair proposal draft. */
export type RelationshipRepairProposalDraft = typeof RelationshipRepairProposalDraft.Type

/** Idempotent intent for creating a durable proposal from one exact repair candidate. */
export const CreateRelationshipRepairProposalRequest = Schema.Struct({
  proposalId: RelationshipRepairProposal.fields.proposalId,
  environmentId: RelationshipRepairProposal.fields.environmentId,
  expectedRevision: RelationshipRepairProposal.fields.expectedRevision,
  disposition: RelationshipRepairDisposition,
  rationale: RelationshipRepairRationale
}).annotate({ identifier: "CreateRelationshipRepairProposalRequest" })

/** Decoded relationship-repair proposal creation request. */
export type CreateRelationshipRepairProposalRequest = typeof CreateRelationshipRepairProposalRequest.Type

const readErrors = [
  UnauthorizedApiError,
  ForbiddenApiError,
  NotFoundApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError
]

const releaseSlice = HttpApiEndpoint.get("releaseSlice", "/api/v1/relationships/releases/:releaseId", {
  params: { releaseId: ReleaseId },
  query: { environmentId: Schema.optionalKey(EnvironmentId) },
  success: ReleaseDeliveryGraphInspection,
  error: readErrors
}).middleware(SessionCookieAuth)

const relationship = HttpApiEndpoint.get("relationship", "/api/v1/relationships/:relationshipId", {
  params: { relationshipId: RelationshipId },
  query: {
    revision: Schema.optionalKey(CanonicalNonNegativeIntegerFromString.pipe(Schema.decodeTo(LedgerRevision)))
  },
  success: DeliveryRelationship,
  error: readErrors
}).middleware(SessionCookieAuth)

const repairCandidates = HttpApiEndpoint.get(
  "repairCandidates",
  "/api/v1/relationships/releases/:releaseId/repair-candidates",
  {
    params: { releaseId: ReleaseId },
    query: { environmentId: Schema.optionalKey(EnvironmentId) },
    success: RelationshipRepairCandidates,
    error: readErrors
  }
).middleware(SessionCookieAuth)

const repairProposalDraft = HttpApiEndpoint.get(
  "repairProposalDraft",
  "/api/v1/relationships/releases/:releaseId/repair-candidates/:relationshipId/proposal-draft",
  {
    params: { releaseId: ReleaseId, relationshipId: RelationshipId },
    query: {
      environmentId: Schema.optionalKey(EnvironmentId),
      revision: CanonicalNonNegativeIntegerFromString.pipe(Schema.decodeTo(LedgerRevision))
    },
    success: RelationshipRepairProposalDraft,
    error: readErrors
  }
).middleware(SessionCookieAuth)

const createRepairProposal = HttpApiEndpoint.post(
  "createRepairProposal",
  "/api/v1/relationships/releases/:releaseId/repair-candidates/:relationshipId/proposals",
  {
    params: { releaseId: ReleaseId, relationshipId: RelationshipId },
    payload: CreateRelationshipRepairProposalRequest,
    success: RelationshipRepairProposal,
    error: [
      ...readErrors,
      InvalidRequestApiError,
      ConflictApiError,
      PayloadTooLargeApiError
    ]
  }
)
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const relationshipHistory = HttpApiEndpoint.get(
  "relationshipHistory",
  "/api/v1/relationships/:relationshipId/history",
  {
    params: { relationshipId: RelationshipId },
    success: RelationshipHistoryInspection,
    error: readErrors
  }
).middleware(SessionCookieAuth)

const evidence = HttpApiEndpoint.get("evidence", "/api/v1/evidence/:evidenceId", {
  params: { evidenceId: EvidenceId },
  success: EvidenceInspection,
  error: readErrors
}).middleware(SessionCookieAuth)

/** Authenticated, workspace-safe delivery relationship and evidence inspection. */
export class DeliveryGraphApiGroup extends HttpApiGroup.make("deliveryGraph")
  .add(
    releaseSlice,
    repairCandidates,
    repairProposalDraft,
    createRepairProposal,
    relationship,
    relationshipHistory,
    evidence
  )
{}
