import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { AgentId, PersonId, SessionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { makeGovernedActionCurrentSessionReader } from "../../src/server/governance/internal/execution-store/current-session.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeUnknownSync(WorkspaceId)(
  "01890f6f-6d6a-7cc0-98d2-310000000001"
)
const MISSING_WORKSPACE_ID = Schema.decodeUnknownSync(WorkspaceId)(
  "01890f6f-6d6a-7cc0-98d2-310000000002"
)
const SESSION_ID = Schema.decodeUnknownSync(SessionId)(
  "01890f6f-6d6a-7cc0-98d2-310000000003"
)
const PERSON_ID = Schema.decodeUnknownSync(PersonId)(
  "01890f6f-6d6a-7cc0-98d2-310000000004"
)
const AGENT_ID = Schema.decodeUnknownSync(AgentId)(
  "01890f6f-6d6a-7cc0-98d2-310000000005"
)

const reference = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID }

const withDatabase = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Database>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-current-session-")
    return yield* use.pipe(Effect.provide(databaseLayer(config)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedWorkspace = Effect.fn("GovernedActionCurrentSessionTest.seedWorkspace")(function*(
  workspaceId = WORKSPACE_ID
) {
  const { sql } = yield* Database
  yield* sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (
    ${workspaceId}, 'Governance', 1,
    '2026-07-15T09:00:00.000Z', '2026-07-15T09:00:00.000Z'
  )`
})

const seedHumanSession = Effect.fn(
  "GovernedActionCurrentSessionTest.seedHumanSession"
)(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO sessions (
    workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id, agent_id,
    permission, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
  ) VALUES (
    ${WORKSPACE_ID}, ${SESSION_ID}, ${"1".repeat(64)}, ${"2".repeat(64)},
    'human', ${PERSON_ID}, NULL, 'workspace-approver',
    '2026-07-15T09:00:00.000Z', '2026-07-15T09:30:00.000Z',
    '2026-07-15T12:00:00.000Z', '2026-08-15T09:00:00.000Z', NULL
  )`
})

const seedAgentSession = Effect.fn(
  "GovernedActionCurrentSessionTest.seedAgentSession"
)(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO sessions (
    workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id, agent_id,
    permission, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
  ) VALUES (
    ${WORKSPACE_ID}, ${SESSION_ID}, ${"3".repeat(64)}, ${"4".repeat(64)},
    'agent', NULL, ${AGENT_ID}, 'operator',
    '2026-07-15T09:00:00.000Z', '2026-07-15T09:30:00.000Z',
    '2026-07-15T12:00:00.000Z', '2026-08-15T09:00:00.000Z', NULL
  )`
})

describe("governed action current-session authority", () => {
  it.effect("reads one secret-free summary without refreshing session activity", () =>
    withDatabase(Effect.gen(function*() {
      yield* seedWorkspace()
      yield* seedHumanSession()
      const reader = yield* makeGovernedActionCurrentSessionReader

      const session = yield* reader.read(reference)

      assert.strictEqual(session.workspaceId, WORKSPACE_ID)
      assert.strictEqual(session.sessionId, SESSION_ID)
      assert.deepStrictEqual(session.actor, { _tag: "human", personId: PERSON_ID })
      assert.strictEqual(session.permission, "workspace-approver")
      const { sql } = yield* Database
      const rows = yield* sql<{
        readonly lastSeenAt: string
        readonly tokenHash: string
      }>`SELECT last_seen_at AS lastSeenAt, token_hash AS tokenHash
        FROM sessions WHERE workspace_id = ${WORKSPACE_ID} AND session_id = ${SESSION_ID}`
      assert.deepStrictEqual(rows, [{
        lastSeenAt: "2026-07-15T09:30:00.000Z",
        tokenHash: "1".repeat(64)
      }])
    })))

  it.effect("does not cross workspace scope and reports the bounded missing identity", () =>
    withDatabase(Effect.gen(function*() {
      yield* seedWorkspace()
      yield* seedWorkspace(MISSING_WORKSPACE_ID)
      yield* seedHumanSession()
      const reader = yield* makeGovernedActionCurrentSessionReader

      const result = yield* reader.read({
        workspaceId: MISSING_WORKSPACE_ID,
        sessionId: SESSION_ID
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "RecordNotFoundError")
        if (result.failure._tag !== "RecordNotFoundError") return
        assert.strictEqual(result.failure.recordKind, "governed-action-session")
        assert.strictEqual(result.failure.recordKey, SESSION_ID)
        assert.strictEqual(result.failure.workspaceId, MISSING_WORKSPACE_ID)
      }
    })))

  it.effect("decodes a valid agent actor without exposing session credentials", () =>
    withDatabase(Effect.gen(function*() {
      yield* seedWorkspace()
      yield* seedAgentSession()
      const reader = yield* makeGovernedActionCurrentSessionReader

      const session = yield* reader.read(reference)

      assert.deepStrictEqual(session.actor, { _tag: "agent", agentId: AGENT_ID })
      assert.strictEqual(session.permission, "operator")
      assert.notProperty(session, "tokenHash")
      assert.notProperty(session, "csrfHash")
    })))

  it.effect("rejects incoherent persisted actor columns with a stable diagnostic", () =>
    withDatabase(Effect.gen(function*() {
      yield* seedWorkspace()
      yield* seedHumanSession()
      const { sql } = yield* Database
      yield* sql`PRAGMA ignore_check_constraints = ON`
      yield* sql`UPDATE sessions SET agent_id = ${AGENT_ID}
        WHERE workspace_id = ${WORKSPACE_ID} AND session_id = ${SESSION_ID}`
      yield* sql`PRAGMA ignore_check_constraints = OFF`
      const reader = yield* makeGovernedActionCurrentSessionReader

      const result = yield* reader.read(reference).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "PersistedRecordError")
        if (result.failure._tag !== "PersistedRecordError") return
        assert.strictEqual(
          result.failure.diagnosticCode,
          "governed-action-session-schema-invalid"
        )
        assert.strictEqual(result.failure.recordKind, "governed-action-session")
      }
    })))

  it.effect("rejects malformed persisted session chronology", () =>
    withDatabase(Effect.gen(function*() {
      yield* seedWorkspace()
      yield* seedHumanSession()
      const { sql } = yield* Database
      yield* sql`PRAGMA ignore_check_constraints = ON`
      yield* sql`UPDATE sessions SET last_seen_at = '2026-07-15T13:00:00.000Z'
        WHERE workspace_id = ${WORKSPACE_ID} AND session_id = ${SESSION_ID}`
      yield* sql`PRAGMA ignore_check_constraints = OFF`
      const reader = yield* makeGovernedActionCurrentSessionReader

      const result = yield* reader.read(reference).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "PersistedRecordError")
        if (result.failure._tag !== "PersistedRecordError") return
        assert.strictEqual(
          result.failure.diagnosticCode,
          "governed-action-session-schema-invalid"
        )
      }
    })))

  it.effect("rejects multiple matching persisted rows with a stable diagnostic", () =>
    withDatabase(Effect.gen(function*() {
      const { sql } = yield* Database
      yield* sql`ALTER TABLE sessions RENAME TO constrained_sessions`
      yield* sql`CREATE TABLE sessions (
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        person_id TEXT,
        agent_id TEXT,
        permission TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        idle_expires_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        revoked_at TEXT
      )`
      yield* sql`INSERT INTO sessions (
        workspace_id, session_id, actor_kind, person_id, agent_id, permission,
        created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
      ) VALUES
        (${WORKSPACE_ID}, ${SESSION_ID}, 'human', ${PERSON_ID}, NULL, 'reviewer',
          '2026-07-15T09:00:00.000Z', '2026-07-15T09:30:00.000Z',
          '2026-07-15T12:00:00.000Z', '2026-08-15T09:00:00.000Z', NULL),
        (${WORKSPACE_ID}, ${SESSION_ID}, 'human', ${PERSON_ID}, NULL, 'reviewer',
          '2026-07-15T09:00:00.000Z', '2026-07-15T09:30:00.000Z',
          '2026-07-15T12:00:00.000Z', '2026-08-15T09:00:00.000Z', NULL)`
      const reader = yield* makeGovernedActionCurrentSessionReader

      const result = yield* reader.read(reference).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "PersistedRecordError")
        if (result.failure._tag !== "PersistedRecordError") return
        assert.strictEqual(
          result.failure.diagnosticCode,
          "governed-action-session-cardinality-invalid"
        )
        assert.strictEqual(result.failure.recordKind, "governed-action-session")
      }
    })))
})
