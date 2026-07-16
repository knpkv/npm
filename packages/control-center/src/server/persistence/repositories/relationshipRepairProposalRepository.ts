import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { Actor } from "../../../domain/actors.js"
import { LedgerRevision } from "../../../domain/deliveryGraph.js"
import {
  AgentId,
  EnvironmentId,
  PersonId,
  RelationshipId,
  RelationshipRepairProposalId,
  RelationshipRepairReviewId,
  ReleaseId,
  SessionId,
  WorkspaceId
} from "../../../domain/identifiers.js"
import {
  RelationshipRepairApplication,
  RelationshipRepairDisposition,
  RelationshipRepairProposal,
  RelationshipRepairProposalOrigin,
  RelationshipRepairRationale,
  RelationshipRepairReview,
  RelationshipRepairReviewDecision
} from "../../../domain/relationshipRepair.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import {
  PersistedRecordError,
  PersistenceOperationError,
  RecordAlreadyExistsError,
  RecordNotFoundError,
  RevisionConflictError
} from "../errors.js"
import { mapPersistenceOperation, readChanges } from "./internal.js"

const RECORD_KIND = "relationship-repair-proposal"
const MAXIMUM_PROPOSAL_PAGE_SIZE = 128
const encodeTimestamp = Schema.encodeSync(UtcTimestamp)

/** Raised when a relationship-repair persistence command fails boundary decoding. */
export class RelationshipRepairProposalInputError extends Schema.TaggedErrorClass<
  RelationshipRepairProposalInputError
>()("RelationshipRepairProposalInputError", {
  operation: Schema.Literals(["application", "create", "get", "list", "record-application", "review"])
}) {}

/** Caller intent for one durable pending relationship-repair proposal. */
export const CreateRelationshipRepairProposalInput = Schema.Struct({
  proposalId: RelationshipRepairProposalId,
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  environmentId: Schema.NullOr(EnvironmentId),
  relationshipId: RelationshipId,
  expectedRevision: LedgerRevision,
  disposition: RelationshipRepairDisposition,
  rationale: RelationshipRepairRationale,
  origin: RelationshipRepairProposalOrigin,
  proposedAt: UtcTimestamp
})

/** Decoded durable relationship-repair proposal intent. */
export type CreateRelationshipRepairProposalInput = typeof CreateRelationshipRepairProposalInput.Type

/** Workspace-scoped proposal lookup. */
export const ReadRelationshipRepairProposalInput = Schema.Struct({
  workspaceId: WorkspaceId,
  proposalId: RelationshipRepairProposalId
})

/** Bounded release/environment proposal query. */
export const ListRelationshipRepairProposalsInput = Schema.Struct({
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  environmentId: Schema.NullOr(EnvironmentId),
  status: Schema.NullOr(RelationshipRepairProposal.fields.status)
})

/** Idempotent reviewer decision over one pending proposal. */
export const ReviewRelationshipRepairProposalInput = Schema.Struct({
  workspaceId: WorkspaceId,
  proposalId: RelationshipRepairProposalId,
  reviewId: RelationshipRepairReviewId,
  decision: RelationshipRepairReviewDecision,
  rationale: RelationshipRepairRationale,
  origin: RelationshipRepairProposalOrigin,
  reviewedAt: UtcTimestamp
})

/** Decoded immutable relationship-repair review command. */
export type ReviewRelationshipRepairProposalInput = typeof ReviewRelationshipRepairProposalInput.Type

/** Workspace-scoped lookup for an existing proposal application. */
export const ReadRelationshipRepairApplicationInput = ReadRelationshipRepairProposalInput

/** Owner-authorized record of an exact relationship revision appended by a proposal. */
export const RecordRelationshipRepairApplicationInput = Schema.Struct({
  workspaceId: WorkspaceId,
  proposalId: RelationshipRepairProposalId,
  relationshipId: RelationshipId,
  appliedRevision: LedgerRevision,
  origin: RelationshipRepairProposalOrigin,
  appliedAt: UtcTimestamp
})

/** Decoded relationship-repair application command. */
export type RecordRelationshipRepairApplicationInput = typeof RecordRelationshipRepairApplicationInput.Type

const ProposalRow = Schema.Struct({
  workspaceId: WorkspaceId,
  proposalId: RelationshipRepairProposalId,
  schemaVersion: Schema.Literal(2),
  releaseId: ReleaseId,
  environmentId: Schema.NullOr(EnvironmentId),
  relationshipId: RelationshipId,
  expectedRevision: LedgerRevision,
  disposition: RelationshipRepairDisposition,
  rationale: RelationshipRepairRationale,
  actorKind: Schema.Literals(["human", "agent"]),
  personId: Schema.NullOr(PersonId),
  agentId: Schema.NullOr(AgentId),
  sessionId: SessionId,
  status: RelationshipRepairProposal.fields.status,
  proposedAt: UtcTimestamp,
  reviewId: Schema.NullOr(RelationshipRepairReviewId),
  reviewDecision: Schema.NullOr(RelationshipRepairReviewDecision),
  reviewRationale: Schema.NullOr(RelationshipRepairRationale),
  reviewerActorKind: Schema.NullOr(Schema.Literals(["human", "agent"])),
  reviewerPersonId: Schema.NullOr(PersonId),
  reviewerAgentId: Schema.NullOr(AgentId),
  reviewerSessionId: Schema.NullOr(SessionId),
  reviewedAt: Schema.NullOr(UtcTimestamp)
})

type ProposalRow = typeof ProposalRow.Type
const ProposalRowIdentity = Schema.Struct({ proposalId: RelationshipRepairProposalId })

const ApplicationRow = Schema.Struct({
  proposalId: RelationshipRepairProposalId,
  relationshipId: RelationshipId,
  appliedRevision: LedgerRevision,
  actorKind: Schema.Literals(["human", "agent"]),
  personId: Schema.NullOr(PersonId),
  agentId: Schema.NullOr(AgentId),
  sessionId: SessionId,
  appliedAt: UtcTimestamp
})

const actorFromColumns = (input: {
  readonly actorKind: "human" | "agent"
  readonly personId: PersonId | null
  readonly agentId: AgentId | null
}): Actor | undefined => {
  if (input.actorKind === "human" && input.personId !== null && input.agentId === null) {
    return Actor.make({ _tag: "human", personId: input.personId })
  }
  if (input.actorKind === "agent" && input.agentId !== null && input.personId === null) {
    return Actor.make({ _tag: "agent", agentId: input.agentId })
  }
  return undefined
}

const sameActor = (left: Actor, right: Actor): boolean =>
  left._tag === right._tag &&
  (left._tag === "human"
    ? left.personId === (right._tag === "human" ? right.personId : null)
    : left.agentId === (right._tag === "agent" ? right.agentId : null))

const sameCreateIntent = (
  existing: RelationshipRepairProposal,
  requested: CreateRelationshipRepairProposalInput
): boolean =>
  existing.proposalId === requested.proposalId &&
  existing.workspaceId === requested.workspaceId &&
  existing.releaseId === requested.releaseId &&
  existing.environmentId === requested.environmentId &&
  existing.relationshipId === requested.relationshipId &&
  existing.expectedRevision === requested.expectedRevision &&
  existing.disposition === requested.disposition &&
  existing.rationale === requested.rationale &&
  existing.origin.sessionId === requested.origin.sessionId &&
  sameActor(existing.origin.actor, requested.origin.actor)

const sameReviewIntent = (
  existing: RelationshipRepairReview,
  requested: ReviewRelationshipRepairProposalInput
): boolean =>
  existing.reviewId === requested.reviewId &&
  existing.decision === requested.decision &&
  existing.rationale === requested.rationale &&
  existing.origin.sessionId === requested.origin.sessionId &&
  sameActor(existing.origin.actor, requested.origin.actor)

const makeRelationshipRepairProposalRepository = Effect.gen(function*() {
  const database = yield* Database
  const sql = database.sql

  const findApplicationRows = (
    workspaceId: WorkspaceId,
    proposalId: RelationshipRepairProposalId
  ) =>
    sql<Record<string, unknown>>`SELECT
      proposal_id AS proposalId,
      relationship_id AS relationshipId,
      applied_revision AS appliedRevision,
      actor_kind AS actorKind,
      person_id AS personId,
      agent_id AS agentId,
      session_id AS sessionId,
      applied_at AS appliedAt
    FROM relationship_repair_applications
    WHERE workspace_id = ${workspaceId}
      AND proposal_id = ${proposalId}`

  const decodeApplicationRow = Effect.fn("RelationshipRepairProposalRepository.decodeApplicationRow")(function*(
    workspaceId: WorkspaceId,
    proposalId: RelationshipRepairProposalId,
    rawRow: unknown
  ) {
    const decoded = Schema.decodeUnknownResult(ApplicationRow)(rawRow)
    if (Result.isFailure(decoded)) {
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "relationship-repair-application",
        recordKey: proposalId,
        diagnosticCode: "relationship-repair-application-schema-invalid"
      })
    }
    const row = decoded.success
    const actor = actorFromColumns(row)
    if (actor === undefined) {
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: "relationship-repair-application",
        recordKey: proposalId,
        diagnosticCode: "relationship-repair-application-actor-invalid"
      })
    }
    return RelationshipRepairApplication.make({
      proposalId: row.proposalId,
      relationshipId: row.relationshipId,
      appliedRevision: row.appliedRevision,
      origin: { actor, sessionId: row.sessionId },
      appliedAt: row.appliedAt
    })
  })

  const selectColumns = sql`SELECT
    proposal.workspace_id AS workspaceId,
    proposal.proposal_id AS proposalId,
    proposal.schema_version AS schemaVersion,
    proposal.release_id AS releaseId,
    proposal.environment_id AS environmentId,
    proposal.relationship_id AS relationshipId,
    proposal.expected_revision AS expectedRevision,
    proposal.disposition,
    proposal.rationale,
    proposal.actor_kind AS actorKind,
    proposal.person_id AS personId,
    proposal.agent_id AS agentId,
    proposal.session_id AS sessionId,
    proposal.status,
    proposal.proposed_at AS proposedAt,
    review.review_id AS reviewId,
    review.decision AS reviewDecision,
    review.rationale AS reviewRationale,
    review.actor_kind AS reviewerActorKind,
    review.person_id AS reviewerPersonId,
    review.agent_id AS reviewerAgentId,
    review.session_id AS reviewerSessionId,
    review.reviewed_at AS reviewedAt
  FROM relationship_repair_proposals proposal
  LEFT JOIN relationship_repair_reviews review
    ON review.workspace_id = proposal.workspace_id
    AND review.proposal_id = proposal.proposal_id`

  const findRows = (workspaceId: WorkspaceId, proposalId: RelationshipRepairProposalId) =>
    sql<Record<string, unknown>>`${selectColumns}
    WHERE proposal.workspace_id = ${workspaceId}
      AND proposal.proposal_id = ${proposalId}`

  const decodeRow = Effect.fn("RelationshipRepairProposalRepository.decodeRow")(function*(
    workspaceId: WorkspaceId,
    proposalId: RelationshipRepairProposalId,
    rawRow: unknown
  ) {
    const decoded = Schema.decodeUnknownResult(ProposalRow)(rawRow)
    if (Result.isFailure(decoded)) {
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: RECORD_KIND,
        recordKey: proposalId,
        diagnosticCode: "relationship-repair-proposal-schema-invalid"
      })
    }
    const row = decoded.success
    const actor = actorFromColumns(row)
    if (actor === undefined) {
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: RECORD_KIND,
        recordKey: proposalId,
        diagnosticCode: "relationship-repair-proposal-actor-invalid"
      })
    }

    let review: RelationshipRepairReview | null = null
    if (row.status === "pending") {
      if (
        row.reviewId !== null || row.reviewDecision !== null || row.reviewRationale !== null ||
        row.reviewerActorKind !== null || row.reviewerPersonId !== null || row.reviewerAgentId !== null ||
        row.reviewerSessionId !== null || row.reviewedAt !== null
      ) {
        return yield* new PersistedRecordError({
          workspaceId,
          recordKind: RECORD_KIND,
          recordKey: proposalId,
          diagnosticCode: "relationship-repair-pending-review-invalid"
        })
      }
    } else {
      if (
        row.reviewId === null || row.reviewDecision !== row.status || row.reviewRationale === null ||
        row.reviewerActorKind === null || row.reviewerSessionId === null || row.reviewedAt === null
      ) {
        return yield* new PersistedRecordError({
          workspaceId,
          recordKind: RECORD_KIND,
          recordKey: proposalId,
          diagnosticCode: "relationship-repair-final-review-invalid"
        })
      }
      const reviewer = actorFromColumns({
        actorKind: row.reviewerActorKind,
        personId: row.reviewerPersonId,
        agentId: row.reviewerAgentId
      })
      if (reviewer === undefined) {
        return yield* new PersistedRecordError({
          workspaceId,
          recordKind: RECORD_KIND,
          recordKey: proposalId,
          diagnosticCode: "relationship-repair-reviewer-invalid"
        })
      }
      review = RelationshipRepairReview.make({
        reviewId: row.reviewId,
        decision: row.reviewDecision,
        rationale: row.reviewRationale,
        origin: { actor: reviewer, sessionId: row.reviewerSessionId },
        reviewedAt: row.reviewedAt
      })
    }

    return RelationshipRepairProposal.make({
      schemaVersion: row.schemaVersion,
      proposalId: row.proposalId,
      workspaceId: row.workspaceId,
      releaseId: row.releaseId,
      environmentId: row.environmentId,
      relationshipId: row.relationshipId,
      expectedRevision: row.expectedRevision,
      disposition: row.disposition,
      rationale: row.rationale,
      origin: { actor, sessionId: row.sessionId },
      status: row.status,
      proposedAt: row.proposedAt,
      review
    })
  })

  const getDecoded = Effect.fn("RelationshipRepairProposalRepository.getDecoded")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly proposalId: RelationshipRepairProposalId
  }) {
    const rows = yield* findRows(input.workspaceId, input.proposalId)
    const rawRow = rows[0]
    if (rawRow === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId: input.workspaceId,
        recordKind: RECORD_KIND,
        recordKey: input.proposalId
      })
    }
    if (rows.length !== 1) {
      return yield* new PersistenceOperationError({ operation: "relationship-repair-proposal.read-identity" })
    }
    return yield* decodeRow(input.workspaceId, input.proposalId, rawRow)
  })

  const decodeInput = <Decoded, Encoded>(
    operation: "application" | "create" | "get" | "list" | "record-application" | "review",
    schema: Schema.Codec<Decoded, Encoded>,
    input: unknown
  ) =>
    Schema.decodeUnknownEffect(Schema.toType(schema))(input).pipe(
      Effect.mapError(() => new RelationshipRepairProposalInputError({ operation }))
    )

  return {
    application: Effect.fn("RelationshipRepairProposalRepository.application")(function*(input: unknown) {
      const request = yield* decodeInput("application", ReadRelationshipRepairApplicationInput, input)
      const rows = yield* findApplicationRows(request.workspaceId, request.proposalId).pipe(
        mapPersistenceOperation("relationship-repair-proposal.application")
      )
      const row = rows[0]
      if (row === undefined) return null
      if (rows.length !== 1) {
        return yield* new PersistenceOperationError({
          operation: "relationship-repair-proposal.application-identity"
        })
      }
      return yield* decodeApplicationRow(request.workspaceId, request.proposalId, row)
    }),
    create: Effect.fn("RelationshipRepairProposalRepository.create")(function*(input: unknown) {
      const request = yield* decodeInput("create", CreateRelationshipRepairProposalInput, input)
      const proposedAt = encodeTimestamp(request.proposedAt)
      return yield* database.transaction(Effect.gen(function*() {
        const existingRows = yield* findRows(request.workspaceId, request.proposalId)
        const existingRaw = existingRows[0]
        if (existingRaw !== undefined) {
          const existing = yield* decodeRow(request.workspaceId, request.proposalId, existingRaw)
          if (sameCreateIntent(existing, request)) return existing
          return yield* new RecordAlreadyExistsError({
            workspaceId: request.workspaceId,
            recordKind: RECORD_KIND,
            recordKey: request.proposalId
          })
        }

        const personId = request.origin.actor._tag === "human" ? request.origin.actor.personId : null
        const agentId = request.origin.actor._tag === "agent" ? request.origin.actor.agentId : null
        yield* sql`INSERT OR IGNORE INTO relationship_repair_proposals (
          workspace_id, proposal_id, schema_version, release_id, environment_id,
          relationship_id, expected_revision, disposition, rationale, actor_kind,
          person_id, agent_id, session_id, status, proposed_at
        ) SELECT
          ${request.workspaceId}, ${request.proposalId}, 2, ${request.releaseId}, ${request.environmentId},
          ${request.relationshipId}, ${request.expectedRevision}, ${request.disposition}, ${request.rationale},
          ${request.origin.actor._tag}, ${personId}, ${agentId}, ${request.origin.sessionId}, 'pending',
          ${proposedAt}
        FROM relationship_heads head
        JOIN relationship_revisions revision
          ON revision.workspace_id = head.workspace_id
          AND revision.relationship_id = head.relationship_id
          AND revision.revision = head.current_revision
        WHERE head.workspace_id = ${request.workspaceId}
          AND head.relationship_id = ${request.relationshipId}
          AND head.current_revision = ${request.expectedRevision}
          AND revision.release_id = ${request.releaseId}
          AND (
            (${request.environmentId} IS NULL AND revision.environment_id IS NULL) OR
            revision.environment_id = ${request.environmentId}
          )
          AND revision.lifecycle IN ('missing', 'inferred', 'proposed')`

        if ((yield* readChanges(sql)) === 0) {
          const headRows = yield* sql<Record<string, unknown>>`SELECT current_revision AS revision
            FROM relationship_heads
            WHERE workspace_id = ${request.workspaceId}
              AND relationship_id = ${request.relationshipId}`
          const head = Schema.decodeUnknownResult(Schema.Struct({ revision: LedgerRevision }))(headRows[0])
          if (Result.isSuccess(head) && head.success.revision !== request.expectedRevision) {
            return yield* new RevisionConflictError({
              workspaceId: request.workspaceId,
              recordKind: "delivery-relationship",
              recordKey: request.relationshipId,
              expectedRevision: request.expectedRevision,
              actualRevision: head.success.revision
            })
          }
          if (Result.isSuccess(head)) {
            const pendingRows = yield* sql`SELECT proposal_id
              FROM relationship_repair_proposals
              WHERE workspace_id = ${request.workspaceId}
                AND relationship_id = ${request.relationshipId}
                AND expected_revision = ${request.expectedRevision}
                AND status = 'pending'`
            if (pendingRows.length > 0) {
              return yield* new RecordAlreadyExistsError({
                workspaceId: request.workspaceId,
                recordKind: RECORD_KIND,
                recordKey: request.proposalId
              })
            }
          }
          return yield* new RecordNotFoundError({
            workspaceId: request.workspaceId,
            recordKind: "delivery-relationship",
            recordKey: request.relationshipId
          })
        }
        return yield* getDecoded(request)
      })).pipe(mapPersistenceOperation("relationship-repair-proposal.create"))
    }),
    get: Effect.fn("RelationshipRepairProposalRepository.get")(function*(input: unknown) {
      const request = yield* decodeInput("get", ReadRelationshipRepairProposalInput, input)
      return yield* getDecoded(request).pipe(mapPersistenceOperation("relationship-repair-proposal.get"))
    }),
    list: Effect.fn("RelationshipRepairProposalRepository.list")(function*(input: unknown) {
      const request = yield* decodeInput("list", ListRelationshipRepairProposalsInput, input)
      const rows = yield* sql<Record<string, unknown>>`${selectColumns}
        WHERE proposal.workspace_id = ${request.workspaceId}
          AND proposal.release_id = ${request.releaseId}
          AND (
            (${request.environmentId} IS NULL AND proposal.environment_id IS NULL) OR
            proposal.environment_id = ${request.environmentId}
          )
          AND (${request.status} IS NULL OR proposal.status = ${request.status})
        ORDER BY proposal.proposed_at DESC, proposal.proposal_id DESC
        LIMIT ${MAXIMUM_PROPOSAL_PAGE_SIZE + 1}`.pipe(
        mapPersistenceOperation("relationship-repair-proposal.list")
      )
      const proposals = yield* Effect.forEach(
        rows.slice(0, MAXIMUM_PROPOSAL_PAGE_SIZE),
        (row) =>
          Effect.gen(function*() {
            const identity = Schema.decodeUnknownResult(ProposalRowIdentity)(row)
            if (Result.isFailure(identity)) {
              return yield* new PersistedRecordError({
                workspaceId: request.workspaceId,
                recordKind: RECORD_KIND,
                recordKey: request.releaseId,
                diagnosticCode: "relationship-repair-proposal-identity-invalid"
              })
            }
            return yield* decodeRow(request.workspaceId, identity.success.proposalId, row)
          }),
        { concurrency: 1 }
      )
      return { proposals, truncated: rows.length > MAXIMUM_PROPOSAL_PAGE_SIZE }
    }),
    review: Effect.fn("RelationshipRepairProposalRepository.review")(function*(input: unknown) {
      const request = yield* decodeInput("review", ReviewRelationshipRepairProposalInput, input)
      const reviewedAt = encodeTimestamp(request.reviewedAt)
      return yield* database.transaction(Effect.gen(function*() {
        const proposal = yield* getDecoded(request)
        if (proposal.review !== null) {
          if (sameReviewIntent(proposal.review, request)) return proposal
          return yield* new RecordAlreadyExistsError({
            workspaceId: request.workspaceId,
            recordKind: "relationship-repair-review",
            recordKey: request.reviewId
          })
        }
        if (sameActor(proposal.origin.actor, request.origin.actor)) {
          return yield* new RecordAlreadyExistsError({
            workspaceId: request.workspaceId,
            recordKind: "relationship-repair-review",
            recordKey: request.reviewId
          })
        }

        const reviewCollision = yield* sql`SELECT proposal_id
          FROM relationship_repair_reviews
          WHERE workspace_id = ${request.workspaceId}
            AND review_id = ${request.reviewId}`
        if (reviewCollision.length > 0) {
          return yield* new RecordAlreadyExistsError({
            workspaceId: request.workspaceId,
            recordKind: "relationship-repair-review",
            recordKey: request.reviewId
          })
        }

        const personId = request.origin.actor._tag === "human" ? request.origin.actor.personId : null
        const agentId = request.origin.actor._tag === "agent" ? request.origin.actor.agentId : null
        yield* sql`INSERT INTO relationship_repair_reviews (
          workspace_id, proposal_id, review_id, decision, rationale, actor_kind,
          person_id, agent_id, session_id, reviewed_at
        ) VALUES (
          ${request.workspaceId}, ${request.proposalId}, ${request.reviewId}, ${request.decision},
          ${request.rationale}, ${request.origin.actor._tag}, ${personId}, ${agentId},
          ${request.origin.sessionId}, ${reviewedAt}
        )`
        return yield* getDecoded(request)
      })).pipe(mapPersistenceOperation("relationship-repair-proposal.review"))
    }),
    recordApplication: Effect.fn("RelationshipRepairProposalRepository.recordApplication")(function*(input: unknown) {
      const request = yield* decodeInput(
        "record-application",
        RecordRelationshipRepairApplicationInput,
        input
      )
      const appliedAt = encodeTimestamp(request.appliedAt)
      return yield* database.transaction(Effect.gen(function*() {
        const existingRows = yield* findApplicationRows(request.workspaceId, request.proposalId)
        const existing = existingRows[0]
        if (existing !== undefined) {
          return yield* decodeApplicationRow(request.workspaceId, request.proposalId, existing)
        }
        const personId = request.origin.actor._tag === "human" ? request.origin.actor.personId : null
        const agentId = request.origin.actor._tag === "agent" ? request.origin.actor.agentId : null
        yield* sql`INSERT INTO relationship_repair_applications (
          workspace_id, proposal_id, relationship_id, applied_revision,
          actor_kind, person_id, agent_id, session_id, applied_at
        ) VALUES (
          ${request.workspaceId}, ${request.proposalId}, ${request.relationshipId},
          ${request.appliedRevision}, ${request.origin.actor._tag}, ${personId}, ${agentId},
          ${request.origin.sessionId}, ${appliedAt}
        )`
        const rows = yield* findApplicationRows(request.workspaceId, request.proposalId)
        const row = rows[0]
        if (row === undefined) {
          return yield* new PersistenceOperationError({
            operation: "relationship-repair-proposal.record-application-readback"
          })
        }
        return yield* decodeApplicationRow(request.workspaceId, request.proposalId, row)
      })).pipe(mapPersistenceOperation("relationship-repair-proposal.record-application"))
    })
  }
})

/** Workspace-scoped durable relationship-repair proposal persistence. */
export interface RelationshipRepairProposalRepositoryService
  extends Success<typeof makeRelationshipRepairProposalRepository>
{}

/** Server-only repository for relationship-repair proposals and immutable reviews. */
export class RelationshipRepairProposalRepository extends Context.Service<
  RelationshipRepairProposalRepository,
  RelationshipRepairProposalRepositoryService
>()("@knpkv/control-center/RelationshipRepairProposalRepository") {
  /** Layer binding proposal persistence to the shared database. */
  static readonly layer = Layer.effect(
    RelationshipRepairProposalRepository,
    makeRelationshipRepairProposalRepository
  )
}
