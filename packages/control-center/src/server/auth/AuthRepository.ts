import { Context, Crypto, DateTime, Effect, Layer, Result, Schema } from "effect"

import { Actor, Role } from "../../domain/actors.js"
import { WorkspaceId } from "../../domain/identifiers.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { Database } from "../persistence/Database.js"
import { makePersistedRowQuarantine } from "../persistence/repositories/persistedRowQuarantine.js"
import { QuarantineRepository } from "../persistence/repositories/quarantineRepository.js"
import { AuthPersistenceError, CredentialRejectedError, FirstRunPairingAlreadyIssuedError } from "./errors.js"
import type { SessionSummary } from "./models.js"
import { PairingCodeId, PairingCodeSummary, PairingPurpose, SessionId } from "./models.js"

const Hash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
)

const SessionRow = Schema.Struct({
  sessionId: SessionId,
  workspaceId: WorkspaceId,
  tokenHash: Hash,
  csrfHash: Hash,
  actor: Schema.fromJsonString(Actor),
  permission: Role,
  createdAt: UtcTimestamp,
  lastSeenAt: UtcTimestamp,
  idleExpiresAt: UtcTimestamp,
  absoluteExpiresAt: UtcTimestamp,
  revokedAt: Schema.NullOr(UtcTimestamp)
})

const PairingCodeRow = Schema.Struct({
  pairingCodeId: PairingCodeId,
  workspaceId: WorkspaceId,
  codeHash: Hash,
  purpose: PairingPurpose,
  actor: Schema.fromJsonString(Actor),
  permission: Role,
  issuedBySessionId: Schema.NullOr(SessionId),
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  consumedAt: Schema.NullOr(UtcTimestamp),
  consumedBySessionId: Schema.NullOr(SessionId),
  revokedAt: Schema.NullOr(UtcTimestamp)
})

const SessionIdentity = Schema.Struct({ workspaceId: WorkspaceId, sessionId: SessionId })
const PairingCodeIdentity = Schema.Struct({ workspaceId: WorkspaceId, pairingCodeId: PairingCodeId })
const PersistedWorkspaceIdentity = Schema.Struct({ workspaceId: WorkspaceId })

type SessionRow = typeof SessionRow.Type
type PairingCodeRow = typeof PairingCodeRow.Type

interface NewPairingCode {
  readonly pairingCodeId: PairingCodeId
  readonly workspaceId: WorkspaceId
  readonly codeHash: string
  readonly purpose: PairingPurpose
  readonly actor: Actor
  readonly permission: Role
  readonly issuedBySessionId: SessionId | null
  readonly createdAt: typeof UtcTimestamp.Type
  readonly expiresAt: typeof UtcTimestamp.Type
}

interface NewSession {
  readonly sessionId: SessionId
  readonly tokenHash: string
  readonly csrfHash: string
  readonly createdAt: typeof UtcTimestamp.Type
  readonly idleExpiresAt: typeof UtcTimestamp.Type
  readonly absoluteExpiresAt: typeof UtcTimestamp.Type
}

export interface AuthenticatedSessionRecord {
  readonly csrfHash: string
  readonly summary: SessionSummary
}

interface ActorColumns {
  readonly actorKind: "human" | "agent"
  readonly personId: string | null
  readonly agentId: string | null
}

const actorColumns = (actor: Actor): ActorColumns =>
  actor._tag === "human"
    ? { actorKind: "human", personId: actor.personId, agentId: null }
    : { actorKind: "agent", personId: null, agentId: actor.agentId }

const sessionSummary = (row: SessionRow): SessionSummary => ({
  sessionId: row.sessionId,
  workspaceId: row.workspaceId,
  actor: row.actor,
  permission: row.permission,
  createdAt: row.createdAt,
  lastSeenAt: row.lastSeenAt,
  idleExpiresAt: row.idleExpiresAt,
  absoluteExpiresAt: row.absoluteExpiresAt,
  revokedAt: row.revokedAt
})

const pairingSummary = (row: PairingCodeRow): PairingCodeSummary => ({
  pairingCodeId: row.pairingCodeId,
  workspaceId: row.workspaceId,
  actor: row.actor,
  permission: row.permission,
  purpose: row.purpose,
  issuedBySessionId: row.issuedBySessionId,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  consumedAt: row.consumedAt,
  consumedBySessionId: row.consumedBySessionId,
  revokedAt: row.revokedAt
})

type CredentialLookup<Value> =
  | { readonly _tag: "missing" }
  | { readonly _tag: "malformed"; readonly row: unknown }
  | { readonly _tag: "valid"; readonly value: Value }

const missingCredential = <Value>(): CredentialLookup<Value> => ({ _tag: "missing" })

const malformedCredential = <Value>(row: unknown): CredentialLookup<Value> => ({
  _tag: "malformed",
  row
})

const validCredential = <Value>(value: Value): CredentialLookup<Value> => ({
  _tag: "valid",
  value
})

const timestamp = DateTime.formatIso

const sessionSelection = `
  workspace_id AS workspaceId,
  session_id AS sessionId,
  token_hash AS tokenHash,
  csrf_hash AS csrfHash,
  CASE actor_kind
    WHEN 'human' THEN json_object('_tag', 'human', 'personId', person_id)
    ELSE json_object('_tag', 'agent', 'agentId', agent_id)
  END AS actor,
  permission,
  created_at AS createdAt,
  last_seen_at AS lastSeenAt,
  idle_expires_at AS idleExpiresAt,
  absolute_expires_at AS absoluteExpiresAt,
  revoked_at AS revokedAt`

const pairingSelection = `
  workspace_id AS workspaceId,
  pairing_code_id AS pairingCodeId,
  code_hash AS codeHash,
  purpose,
  CASE actor_kind
    WHEN 'human' THEN json_object('_tag', 'human', 'personId', person_id)
    ELSE json_object('_tag', 'agent', 'agentId', agent_id)
  END AS actor,
  permission,
  issued_by_session_id AS issuedBySessionId,
  created_at AS createdAt,
  expires_at AS expiresAt,
  consumed_at AS consumedAt,
  consumed_by_session_id AS consumedBySessionId,
  revoked_at AS revokedAt`

const makeAuthRepository = Effect.gen(function*() {
  const database = yield* Database
  const cryptoService = yield* Crypto.Crypto
  const quarantine = yield* QuarantineRepository
  const quarantineRow = makePersistedRowQuarantine(cryptoService, quarantine)
  const sql = database.sql

  const quarantineSession = Effect.fn("AuthRepository.quarantineSession")(function*(
    rawRow: unknown,
    fallbackWorkspaceId: WorkspaceId | null,
    observedAt: typeof UtcTimestamp.Type
  ) {
    const identity = Schema.decodeUnknownResult(SessionIdentity)(rawRow)
    const persistedWorkspace = Schema.decodeUnknownResult(PersistedWorkspaceIdentity)(rawRow)
    const workspaceId = Result.isSuccess(identity)
      ? identity.success.workspaceId
      : Result.isSuccess(persistedWorkspace)
      ? persistedWorkspace.success.workspaceId
      : fallbackWorkspaceId
    if (workspaceId === null) return
    yield* quarantineRow({
      workspaceId,
      recordKind: "session",
      recordKey: Result.isSuccess(identity) ? identity.success.sessionId : workspaceId,
      diagnosticCode: "session-schema-invalid",
      diagnosticSummary: "Stored session failed schema validation.",
      observedAt,
      row: rawRow
    })
  })

  const quarantinePairingCode = Effect.fn("AuthRepository.quarantinePairingCode")(function*(
    rawRow: unknown,
    fallbackWorkspaceId: WorkspaceId | null,
    observedAt: typeof UtcTimestamp.Type
  ) {
    const identity = Schema.decodeUnknownResult(PairingCodeIdentity)(rawRow)
    const persistedWorkspace = Schema.decodeUnknownResult(PersistedWorkspaceIdentity)(rawRow)
    const workspaceId = Result.isSuccess(identity)
      ? identity.success.workspaceId
      : Result.isSuccess(persistedWorkspace)
      ? persistedWorkspace.success.workspaceId
      : fallbackWorkspaceId
    if (workspaceId === null) return
    yield* quarantineRow({
      workspaceId,
      recordKind: "pairing-code",
      recordKey: Result.isSuccess(identity) ? identity.success.pairingCodeId : workspaceId,
      diagnosticCode: "pairing-code-schema-invalid",
      diagnosticSummary: "Stored pairing code failed schema validation.",
      observedAt,
      row: rawRow
    })
  })

  const mapStorage = (operation: AuthPersistenceError["operation"]) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(() => new AuthPersistenceError({ operation })))

  const insertPairing = (input: NewPairingCode) => {
    const actor = actorColumns(input.actor)
    return sql`INSERT INTO pairing_codes (
      workspace_id, pairing_code_id, code_hash, purpose,
      actor_kind, person_id, agent_id, permission, issued_by_session_id,
      created_at, expires_at
    ) VALUES (
      ${input.workspaceId}, ${input.pairingCodeId}, ${input.codeHash}, ${input.purpose},
      ${actor.actorKind}, ${actor.personId}, ${actor.agentId}, ${input.permission},
      ${input.issuedBySessionId}, ${timestamp(input.createdAt)}, ${timestamp(input.expiresAt)}
    )`
  }

  const insertSession = (input: NewSession, pairing: PairingCodeRow) => {
    const actor = actorColumns(pairing.actor)
    return sql`INSERT INTO sessions (
      workspace_id, session_id, token_hash, csrf_hash,
      actor_kind, person_id, agent_id, permission,
      created_at, last_seen_at, idle_expires_at, absolute_expires_at
    ) VALUES (
      ${pairing.workspaceId}, ${input.sessionId}, ${input.tokenHash}, ${input.csrfHash},
      ${actor.actorKind}, ${actor.personId}, ${actor.agentId}, ${pairing.permission},
      ${timestamp(input.createdAt)}, ${timestamp(input.createdAt)},
      ${timestamp(input.idleExpiresAt)}, ${timestamp(input.absoluteExpiresAt)}
    )`
  }

  const readChanges = Effect.gen(function*() {
    const rows = yield* sql<{ readonly changes: number }>`SELECT changes() AS changes`
    return rows[0]?.changes ?? 0
  })

  const authenticate = Effect.fn("AuthRepository.authenticate")(function*(input: {
    readonly tokenHash: string
    readonly now: typeof UtcTimestamp.Type
    readonly idleExpiresAt: typeof UtcTimestamp.Type
  }) {
    const outcome = yield* database.transaction(
      Effect.gen(function*() {
        const candidateRows = yield* sql.unsafe(
          `SELECT ${sessionSelection} FROM sessions
           WHERE token_hash = ? AND revoked_at IS NULL
             AND idle_expires_at > ? AND absolute_expires_at > ?`,
          [
            input.tokenHash,
            timestamp(input.now),
            timestamp(input.now)
          ]
        )
        const candidate = candidateRows[0]
        if (candidate === undefined) return missingCredential<AuthenticatedSessionRecord>()
        const decodedCandidate = Schema.decodeUnknownResult(SessionRow)(candidate)
        if (Result.isFailure(decodedCandidate)) {
          return malformedCredential<AuthenticatedSessionRecord>(candidate)
        }
        const session = decodedCandidate.success
        const updatedRows = yield* sql.unsafe(
          `UPDATE sessions
           SET last_seen_at = ?, idle_expires_at = MIN(?, absolute_expires_at)
           WHERE workspace_id = ? AND session_id = ? AND revoked_at IS NULL
             AND idle_expires_at > ? AND absolute_expires_at > ?
           RETURNING ${sessionSelection}`,
          [
            timestamp(input.now),
            timestamp(input.idleExpiresAt),
            session.workspaceId,
            session.sessionId,
            timestamp(input.now),
            timestamp(input.now)
          ]
        )
        const updated = updatedRows[0]
        if (updated === undefined) return missingCredential<AuthenticatedSessionRecord>()
        const decodedUpdated = Schema.decodeUnknownResult(SessionRow)(updated)
        if (Result.isFailure(decodedUpdated)) {
          return malformedCredential<AuthenticatedSessionRecord>(updated)
        }
        return validCredential<AuthenticatedSessionRecord>({
          csrfHash: session.csrfHash,
          summary: sessionSummary(decodedUpdated.success)
        })
      })
    ).pipe(
      Effect.catchTag("SqlError", () => Effect.fail(new AuthPersistenceError({ operation: "authenticate-session" })))
    )
    if (outcome._tag === "missing") return yield* new CredentialRejectedError()
    if (outcome._tag === "malformed") {
      yield* quarantineSession(outcome.row, null, input.now).pipe(
        Effect.mapError(() => new CredentialRejectedError())
      )
      return yield* new CredentialRejectedError()
    }
    return outcome.value
  })

  return {
    issueFirstRun: Effect.fn("AuthRepository.issueFirstRun")(function*(input: NewPairingCode) {
      yield* database.transaction(
        Effect.gen(function*() {
          const existing = yield* sql<{ readonly pairingCodeId: string }>`SELECT pairing_code_id AS pairingCodeId
            FROM pairing_codes
            WHERE workspace_id = ${input.workspaceId} AND purpose = 'first-run'`
          if (existing.length > 0) return yield* new FirstRunPairingAlreadyIssuedError()
          yield* insertPairing(input).pipe(mapStorage("issue-pairing-code"))
        })
      ).pipe(
        Effect.catchTag("SqlError", () => Effect.fail(new AuthPersistenceError({ operation: "issue-pairing-code" }))),
        Effect.catchTag(
          "AuthPersistenceError",
          (error) =>
            sql<{ readonly pairingCodeId: string }>`SELECT pairing_code_id AS pairingCodeId
            FROM pairing_codes
            WHERE workspace_id = ${input.workspaceId} AND purpose = 'first-run'`.pipe(
              Effect.flatMap((rows) =>
                Effect.gen(function*() {
                  if (rows.length > 0) return yield* new FirstRunPairingAlreadyIssuedError()
                  return yield* error
                })
              ),
              Effect.catchTag("SqlError", () => Effect.fail(error))
            )
        )
      )
      return PairingCodeSummary.make({
        ...input,
        consumedAt: null,
        consumedBySessionId: null,
        revokedAt: null
      })
    }),

    issue: Effect.fn("AuthRepository.issue")(function*(input: NewPairingCode) {
      yield* insertPairing(input).pipe(mapStorage("issue-pairing-code"))
      return PairingCodeSummary.make({
        ...input,
        consumedAt: null,
        consumedBySessionId: null,
        revokedAt: null
      })
    }),

    consume: Effect.fn("AuthRepository.consume")(function*(input: {
      readonly codeHash: string
      readonly now: typeof UtcTimestamp.Type
      readonly session: NewSession
    }) {
      const outcome = yield* database.transaction(
        Effect.gen(function*() {
          const pairingRows = yield* sql.unsafe(
            `SELECT ${pairingSelection} FROM pairing_codes
             WHERE code_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
            [input.codeHash, timestamp(input.now)]
          )
          const rawPairing = pairingRows[0]
          if (rawPairing === undefined) return missingCredential<SessionSummary>()
          const decodedPairing = Schema.decodeUnknownResult(PairingCodeRow)(rawPairing)
          if (Result.isFailure(decodedPairing)) {
            return malformedCredential<SessionSummary>(rawPairing)
          }
          const pairing = decodedPairing.success
          yield* insertSession(input.session, pairing).pipe(mapStorage("consume-pairing-code"))
          yield* sql`UPDATE pairing_codes
            SET consumed_at = ${timestamp(input.now)}, consumed_by_session_id = ${input.session.sessionId}
            WHERE workspace_id = ${pairing.workspaceId}
              AND pairing_code_id = ${pairing.pairingCodeId}
              AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${timestamp(input.now)}`.pipe(
            mapStorage("consume-pairing-code")
          )
          if ((yield* readChanges) !== 1) return yield* new CredentialRejectedError()
          const rows = yield* sql.unsafe(
            `SELECT ${sessionSelection} FROM sessions
             WHERE workspace_id = ? AND session_id = ?`,
            [pairing.workspaceId, input.session.sessionId]
          )
          const rawSession = rows[0]
          if (rawSession === undefined) {
            return yield* new AuthPersistenceError({ operation: "consume-pairing-code" })
          }
          const decodedSession = Schema.decodeUnknownResult(SessionRow)(rawSession)
          if (Result.isFailure(decodedSession)) {
            return yield* new AuthPersistenceError({ operation: "consume-pairing-code" })
          }
          return validCredential(sessionSummary(decodedSession.success))
        })
      ).pipe(
        Effect.catchTag("SqlError", () => Effect.fail(new AuthPersistenceError({ operation: "consume-pairing-code" })))
      )
      if (outcome._tag === "missing") return yield* new CredentialRejectedError()
      if (outcome._tag === "malformed") {
        yield* quarantinePairingCode(outcome.row, null, input.now).pipe(
          Effect.mapError(() => new CredentialRejectedError())
        )
        return yield* new CredentialRejectedError()
      }
      return outcome.value
    }),

    authenticate,

    listSessions: Effect.fn("AuthRepository.listSessions")(function*(workspaceId: WorkspaceId) {
      const rows = yield* sql.unsafe(
        `SELECT ${sessionSelection} FROM sessions
         WHERE workspace_id = ? ORDER BY created_at DESC, session_id DESC`,
        [workspaceId]
      ).pipe(mapStorage("list-sessions"))
      const summaries: Array<SessionSummary> = []
      for (const row of rows) {
        const decoded = Schema.decodeUnknownResult(SessionRow)(row)
        if (Result.isSuccess(decoded)) {
          summaries.push(sessionSummary(decoded.success))
        } else {
          yield* quarantineSession(row, workspaceId, yield* DateTime.now).pipe(
            Effect.mapError(() => new AuthPersistenceError({ operation: "list-sessions" }))
          )
        }
      }
      return summaries
    }),

    revokeSession: Effect.fn("AuthRepository.revokeSession")(function*(input: {
      readonly workspaceId: WorkspaceId
      readonly sessionId: SessionId
      readonly now: typeof UtcTimestamp.Type
    }) {
      yield* sql`UPDATE sessions SET revoked_at = COALESCE(revoked_at, ${timestamp(input.now)})
        WHERE workspace_id = ${input.workspaceId} AND session_id = ${input.sessionId}`.pipe(
        mapStorage("revoke-session")
      )
    }),

    logout: Effect.fn("AuthRepository.logout")(function*(tokenHash: string, now: typeof UtcTimestamp.Type) {
      yield* sql`UPDATE sessions SET revoked_at = COALESCE(revoked_at, ${timestamp(now)})
        WHERE token_hash = ${tokenHash}`.pipe(mapStorage("revoke-session"))
    }),

    listPairingCodes: Effect.fn("AuthRepository.listPairingCodes")(function*(workspaceId: WorkspaceId) {
      const rows = yield* sql.unsafe(
        `SELECT ${pairingSelection} FROM pairing_codes
         WHERE workspace_id = ? ORDER BY created_at DESC, pairing_code_id DESC`,
        [workspaceId]
      ).pipe(mapStorage("list-pairing-codes"))
      const summaries: Array<PairingCodeSummary> = []
      for (const row of rows) {
        const decoded = Schema.decodeUnknownResult(PairingCodeRow)(row)
        if (Result.isSuccess(decoded)) {
          summaries.push(pairingSummary(decoded.success))
        } else {
          yield* quarantinePairingCode(row, workspaceId, yield* DateTime.now).pipe(
            Effect.mapError(() => new AuthPersistenceError({ operation: "list-pairing-codes" }))
          )
        }
      }
      return summaries
    }),

    revokePairingCode: Effect.fn("AuthRepository.revokePairingCode")(function*(input: {
      readonly workspaceId: WorkspaceId
      readonly pairingCodeId: PairingCodeId
      readonly now: typeof UtcTimestamp.Type
    }) {
      yield* sql`UPDATE pairing_codes SET revoked_at = ${timestamp(input.now)}
        WHERE workspace_id = ${input.workspaceId}
          AND pairing_code_id = ${input.pairingCodeId}
          AND consumed_at IS NULL AND revoked_at IS NULL`.pipe(mapStorage("revoke-pairing-code"))
    }),

    recoverOwner: Effect.fn("AuthRepository.recoverOwner")(function*(
      input: NewPairingCode,
      revokeExistingOwnerSessions: boolean
    ) {
      yield* database.transaction(
        Effect.gen(function*() {
          yield* sql`UPDATE pairing_codes
            SET revoked_at = COALESCE(revoked_at, ${timestamp(input.createdAt)})
            WHERE workspace_id = ${input.workspaceId}
              AND consumed_at IS NULL
              AND revoked_at IS NULL`.pipe(mapStorage("recover-owner"))
          if (revokeExistingOwnerSessions) {
            yield* sql`UPDATE sessions SET revoked_at = COALESCE(revoked_at, ${timestamp(input.createdAt)})
              WHERE workspace_id = ${input.workspaceId}
                AND permission = 'workspace-owner'`.pipe(mapStorage("recover-owner"))
          }
          yield* insertPairing(input).pipe(mapStorage("recover-owner"))
          yield* sql`INSERT INTO recovery_audit_events (
            workspace_id, pairing_code_id, event_kind, revoked_owner_sessions, created_at
          ) VALUES (
            ${input.workspaceId}, ${input.pairingCodeId}, 'owner-recovery-issued',
            ${revokeExistingOwnerSessions ? 1 : 0}, ${timestamp(input.createdAt)}
          )`.pipe(mapStorage("recover-owner"))
        })
      ).pipe(
        Effect.catchTag("SqlError", () => Effect.fail(new AuthPersistenceError({ operation: "recover-owner" })))
      )
      return PairingCodeSummary.make({
        ...input,
        consumedAt: null,
        consumedBySessionId: null,
        revokedAt: null
      })
    })
  }
})

export interface AuthRepositoryService extends Effect.Success<typeof makeAuthRepository> {}

export class AuthRepository extends Context.Service<AuthRepository, AuthRepositoryService>()(
  "@knpkv/control-center/server/auth/AuthRepository"
) {
  static readonly layer = Layer.effect(AuthRepository, makeAuthRepository)
}
