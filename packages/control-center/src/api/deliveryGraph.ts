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
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import {
  ForbiddenApiError,
  NotFoundApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { SessionCookieAuth } from "./session.js"
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

/** Complete bounded graph material for one release and optional environment. */
export const ReleaseDeliveryGraphInspection = Schema.Struct({
  releaseId: ReleaseId,
  environmentId: Schema.NullOr(EnvironmentId),
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
  .add(releaseSlice, relationship, relationshipHistory, evidence)
{}
