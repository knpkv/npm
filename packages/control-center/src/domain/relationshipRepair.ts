import * as Schema from "effect/Schema"

import { Actor } from "./actors.js"
import { LedgerRevision } from "./deliveryGraph.js"
import {
  EnvironmentId,
  RelationshipId,
  RelationshipRepairProposalId,
  ReleaseId,
  SessionId,
  WorkspaceId
} from "./identifiers.js"
import { UtcTimestamp } from "./utcTimestamp.js"

/** Explicit decision proposed for an incomplete delivery relationship. */
export const RelationshipRepairDisposition = Schema.Literals(["link", "verify", "reject"])

/** Decoded relationship-repair disposition. */
export type RelationshipRepairDisposition = typeof RelationshipRepairDisposition.Type

/** Bounded human-readable justification stored with a repair proposal. */
export const RelationshipRepairRationale = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_000)
).annotate({ identifier: "RelationshipRepairRationale" })

/** Decoded relationship-repair rationale. */
export type RelationshipRepairRationale = typeof RelationshipRepairRationale.Type

/** Authenticated origin retained for proposal review and later audit. */
export const RelationshipRepairProposalOrigin = Schema.Struct({
  actor: Actor,
  sessionId: SessionId
})

/** Decoded relationship-repair proposal origin. */
export type RelationshipRepairProposalOrigin = typeof RelationshipRepairProposalOrigin.Type

/** Durable pending proposal bound to one exact immutable relationship revision. */
export const RelationshipRepairProposal = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  proposalId: RelationshipRepairProposalId,
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  environmentId: Schema.NullOr(EnvironmentId),
  relationshipId: RelationshipId,
  expectedRevision: LedgerRevision,
  disposition: RelationshipRepairDisposition,
  rationale: RelationshipRepairRationale,
  origin: RelationshipRepairProposalOrigin,
  status: Schema.Literal("pending"),
  proposedAt: UtcTimestamp
}).annotate({ identifier: "RelationshipRepairProposal" })

/** Decoded durable relationship-repair proposal. */
export type RelationshipRepairProposal = typeof RelationshipRepairProposal.Type
