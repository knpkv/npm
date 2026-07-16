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
  ReleaseId,
  SessionId,
  WorkspaceId
} from "../../../domain/identifiers.js"
import {
  RelationshipRepairDisposition,
  RelationshipRepairProposal,
  RelationshipRepairProposalOrigin,
  RelationshipRepairRationale
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
const encodeTimestamp = Schema.encodeSync(UtcTimestamp)

/** Raised when a relationship-repair persistence command fails boundary decoding. */
export class RelationshipRepairProposalInputError extends Schema.TaggedErrorClass<
  RelationshipRepairProposalInputError
>()("RelationshipRepairProposalInputError", {
  operation: Schema.Literals(["create", "get"])
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

const ProposalRow = Schema.Struct({
  workspaceId: WorkspaceId,
  proposalId: RelationshipRepairProposalId,
  schemaVersion: Schema.Literal(1),
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
  status: Schema.Literal("pending"),
  proposedAt: UtcTimestamp
}).check(
  Schema.makeFilter(
    ({ actorKind, agentId, personId }) =>
      actorKind === "human"
        ? personId !== null && agentId === null
        : agentId !== null && personId === null,
    { expected: "proposal actor columns to match their discriminator" }
  )
)

type ProposalRow = typeof ProposalRow.Type

const actorFromRow = (row: ProposalRow): Actor | undefined => {
  if (row.actorKind === "human" && row.personId !== null) {
    return Actor.make({ _tag: "human", personId: row.personId })
  }
  if (row.actorKind === "agent" && row.agentId !== null) {
    return Actor.make({ _tag: "agent", agentId: row.agentId })
  }
  return undefined
}

const sameActor = (left: Actor, right: Actor): boolean =>
  left._tag === right._tag &&
  (left._tag === "human"
    ? left.personId === (right._tag === "human" ? right.personId : null)
    : left.agentId === (right._tag === "agent" ? right.agentId : null))

const sameIntent = (
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

const makeRelationshipRepairProposalRepository = Effect.gen(function*() {
  const database = yield* Database
  const sql = database.sql

  const findRows = (workspaceId: WorkspaceId, proposalId: RelationshipRepairProposalId) =>
    sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId,
      proposal_id AS proposalId,
      schema_version AS schemaVersion,
      release_id AS releaseId,
      environment_id AS environmentId,
      relationship_id AS relationshipId,
      expected_revision AS expectedRevision,
      disposition,
      rationale,
      actor_kind AS actorKind,
      person_id AS personId,
      agent_id AS agentId,
      session_id AS sessionId,
      status,
      proposed_at AS proposedAt
    FROM relationship_repair_proposals
    WHERE workspace_id = ${workspaceId}
      AND proposal_id = ${proposalId}`

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
    const actor = actorFromRow(row)
    if (actor === undefined) {
      return yield* new PersistedRecordError({
        workspaceId,
        recordKind: RECORD_KIND,
        recordKey: proposalId,
        diagnosticCode: "relationship-repair-proposal-actor-invalid"
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
      proposedAt: row.proposedAt
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

  const decodeCreate = Effect.fn("RelationshipRepairProposalRepository.decodeCreate")(function*(input: unknown) {
    return yield* Schema.decodeUnknownEffect(Schema.toType(CreateRelationshipRepairProposalInput))(input).pipe(
      Effect.mapError(() => new RelationshipRepairProposalInputError({ operation: "create" }))
    )
  })

  return {
    create: Effect.fn("RelationshipRepairProposalRepository.create")(function*(input: unknown) {
      const request = yield* decodeCreate(input)
      const proposedAt = encodeTimestamp(request.proposedAt)
      return yield* database.transaction(Effect.gen(function*() {
        const existingRows = yield* findRows(request.workspaceId, request.proposalId)
        const existingRaw = existingRows[0]
        if (existingRaw !== undefined) {
          const existing = yield* decodeRow(request.workspaceId, request.proposalId, existingRaw)
          if (sameIntent(existing, request)) return existing
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
          ${request.workspaceId}, ${request.proposalId}, 1, ${request.releaseId}, ${request.environmentId},
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
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(ReadRelationshipRepairProposalInput))(input).pipe(
        Effect.mapError(() => new RelationshipRepairProposalInputError({ operation: "get" }))
      )
      return yield* getDecoded(request).pipe(mapPersistenceOperation("relationship-repair-proposal.get"))
    })
  }
})

/** Workspace-scoped durable relationship-repair proposal persistence. */
export interface RelationshipRepairProposalRepositoryService extends
  Success<
    typeof makeRelationshipRepairProposalRepository
  >
{}

/** Server-only repository for idempotent pending relationship-repair proposals. */
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
