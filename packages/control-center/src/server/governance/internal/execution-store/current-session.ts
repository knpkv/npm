import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { Role } from "../../../../domain/actors.js"
import { AgentId, PersonId, SessionId, WorkspaceId } from "../../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { SessionSummary } from "../../../auth/models.js"
import { Database } from "../../../persistence/Database.js"
import { PersistedRecordError, RecordNotFoundError } from "../../../persistence/errors.js"

const RECORD_KIND = "governed-action-session"

const CurrentSessionAuthorityRow = Schema.Struct({
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  actorKind: Schema.Literals(["human", "agent"]),
  personId: Schema.NullOr(PersonId),
  agentId: Schema.NullOr(AgentId),
  permission: Role,
  createdAt: UtcTimestamp,
  lastSeenAt: UtcTimestamp,
  idleExpiresAt: UtcTimestamp,
  absoluteExpiresAt: UtcTimestamp,
  revokedAt: Schema.NullOr(UtcTimestamp)
}).check(
  Schema.makeFilter(
    ({ actorKind, agentId, personId }) =>
      actorKind === "human"
        ? personId !== null && agentId === null
        : agentId !== null && personId === null,
    { expected: "exactly one actor identifier matching actorKind" }
  ),
  Schema.makeFilter(
    ({ absoluteExpiresAt, createdAt, idleExpiresAt, lastSeenAt, revokedAt }) =>
      DateTime.Order(createdAt, lastSeenAt) <= 0 &&
      DateTime.Order(lastSeenAt, idleExpiresAt) <= 0 &&
      DateTime.Order(idleExpiresAt, absoluteExpiresAt) <= 0 &&
      (revokedAt === null || DateTime.Order(createdAt, revokedAt) <= 0),
    { expected: "chronologically coherent session authority" }
  )
)

/** Workspace-scoped identity of the session whose current authority is required. */
export interface CurrentSessionAuthorityReference {
  readonly workspaceId: WorkspaceId
  readonly sessionId: SessionId
}

const invalidRecord = (
  reference: CurrentSessionAuthorityReference,
  diagnosticCode: string
): PersistedRecordError =>
  new PersistedRecordError({
    diagnosticCode,
    recordKey: reference.sessionId,
    recordKind: RECORD_KIND,
    workspaceId: reference.workspaceId
  })

/** Build a bounded, secret-free reader for the authority of an existing session. */
export const makeGovernedActionCurrentSessionReader = Effect.gen(function*() {
  const { sql } = yield* Database

  const read = Effect.fn("GovernedActionCurrentSessionReader.read")(function*(
    reference: CurrentSessionAuthorityReference
  ) {
    const rows = yield* sql`SELECT
      workspace_id AS workspaceId,
      session_id AS sessionId,
      actor_kind AS actorKind,
      person_id AS personId,
      agent_id AS agentId,
      permission,
      created_at AS createdAt,
      last_seen_at AS lastSeenAt,
      idle_expires_at AS idleExpiresAt,
      absolute_expires_at AS absoluteExpiresAt,
      revoked_at AS revokedAt
    FROM sessions
    WHERE workspace_id = ${reference.workspaceId}
      AND session_id = ${reference.sessionId}
    LIMIT 2`

    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        recordKey: reference.sessionId,
        recordKind: RECORD_KIND,
        workspaceId: reference.workspaceId
      })
    }
    if (rows.length !== 1) {
      return yield* invalidRecord(reference, "governed-action-session-cardinality-invalid")
    }

    const decodedRow = Schema.decodeUnknownResult(CurrentSessionAuthorityRow)(rows[0])
    if (Result.isFailure(decodedRow)) {
      return yield* invalidRecord(reference, "governed-action-session-schema-invalid")
    }

    const row = decodedRow.success
    const actor: unknown = row.actorKind === "human"
      ? { _tag: "human", personId: row.personId }
      : { _tag: "agent", agentId: row.agentId }
    const summary = Schema.decodeUnknownResult(Schema.toType(SessionSummary))({
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      actor,
      permission: row.permission,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      idleExpiresAt: row.idleExpiresAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
      revokedAt: row.revokedAt
    })
    if (Result.isFailure(summary)) {
      return yield* invalidRecord(reference, "governed-action-session-schema-invalid")
    }
    return summary.success
  })

  return { read }
})
