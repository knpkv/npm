import * as NodeServices from "@effect/platform-node/NodeServices"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import { assert, describe, it } from "@effect/vitest"
import type { FileSystem, Scope } from "effect"
import { Effect, Result } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { migration0019RelationshipRepairProposals } from "../../src/server/persistence/migrations/0019_relationship_repair_proposals.js"
import { migration0020RelationshipRepairReviews } from "../../src/server/persistence/migrations/0020_relationship_repair_reviews.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_ID = "01890f6f-6d6a-7cc0-98d2-450000000001"
const RELEASE_ID = "01890f6f-6d6a-7cc0-98d2-450000000002"
const RELATIONSHIP_ID = "01890f6f-6d6a-7cc0-98d2-450000000003"
const PROPOSAL_ID = "01890f6f-6d6a-7cc0-98d2-450000000004"
const FINAL_INSERT_ID = "01890f6f-6d6a-7cc0-98d2-450000000005"
const OWNER_SESSION_ID = "01890f6f-6d6a-7cc0-98d2-450000000006"
const OWNER_PERSON_ID = "01890f6f-6d6a-7cc0-98d2-450000000007"
const APPROVER_SESSION_ID = "01890f6f-6d6a-7cc0-98d2-450000000008"
const APPROVER_PERSON_ID = "01890f6f-6d6a-7cc0-98d2-450000000009"
const REVIEW_ID = "01890f6f-6d6a-7cc0-98d2-45000000000a"
const ENVIRONMENT_ID = "01890f6f-6d6a-7cc0-98d2-45000000000b"
const AGENT_RELATIONSHIP_ID = "01890f6f-6d6a-7cc0-98d2-45000000000c"
const AGENT_PROPOSAL_ID = "01890f6f-6d6a-7cc0-98d2-45000000000d"
const AGENT_SESSION_ID = "01890f6f-6d6a-7cc0-98d2-45000000000e"
const AGENT_ID = "01890f6f-6d6a-7cc0-98d2-45000000000f"
const AGENT_REVIEW_ID = "01890f6f-6d6a-7cc0-98d2-450000000010"
const PROPOSED_AT = "2026-07-16T10:00:00.000Z"
const AGENT_PROPOSED_AT = "2026-07-16T10:00:30.000Z"
const REVIEWED_AT = "2026-07-16T10:01:00.000Z"

const createVersionNineteenParents = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`CREATE TABLE releases (
      workspace_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, release_id)
    )`
    yield* sql`CREATE TABLE release_targets (
      workspace_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      environment_id TEXT,
      PRIMARY KEY (workspace_id, release_id, environment_id)
    )`
    yield* sql`CREATE TABLE relationship_revisions (
      workspace_id TEXT NOT NULL,
      relationship_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      release_id TEXT NOT NULL,
      environment_id TEXT,
      lifecycle TEXT NOT NULL,
      PRIMARY KEY (workspace_id, relationship_id, revision)
    )`
    yield* sql`CREATE TABLE relationship_heads (
      workspace_id TEXT NOT NULL,
      relationship_id TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, relationship_id)
    )`
    yield* sql`CREATE TABLE sessions (
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      person_id TEXT,
      agent_id TEXT,
      permission TEXT NOT NULL,
      created_at TEXT NOT NULL,
      idle_expires_at TEXT NOT NULL,
      absolute_expires_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY (workspace_id, session_id)
    )`

    yield* sql`INSERT INTO releases (workspace_id, release_id)
      VALUES (${WORKSPACE_ID}, ${RELEASE_ID})`
    yield* sql`INSERT INTO release_targets (workspace_id, release_id, environment_id)
      VALUES (${WORKSPACE_ID}, ${RELEASE_ID}, ${ENVIRONMENT_ID})`
    yield* sql`INSERT INTO relationship_revisions (
      workspace_id, relationship_id, revision, release_id, environment_id, lifecycle
    ) VALUES
      (${WORKSPACE_ID}, ${RELATIONSHIP_ID}, 1, ${RELEASE_ID}, NULL, 'missing'),
      (${WORKSPACE_ID}, ${AGENT_RELATIONSHIP_ID}, 1, ${RELEASE_ID}, ${ENVIRONMENT_ID}, 'missing')`
    yield* sql`INSERT INTO relationship_heads (
      workspace_id, relationship_id, current_revision
    ) VALUES
      (${WORKSPACE_ID}, ${RELATIONSHIP_ID}, 1),
      (${WORKSPACE_ID}, ${AGENT_RELATIONSHIP_ID}, 1)`
    yield* sql`INSERT INTO sessions (
      workspace_id, session_id, actor_kind, person_id, agent_id, permission,
      created_at, idle_expires_at, absolute_expires_at, revoked_at
    ) VALUES (
      ${WORKSPACE_ID}, ${OWNER_SESSION_ID}, 'human', ${OWNER_PERSON_ID}, NULL,
      'workspace-owner', '2026-07-16T09:00:00.000Z', '2026-07-16T12:00:00.000Z',
      '2026-08-16T09:00:00.000Z', NULL
    ), (
      ${WORKSPACE_ID}, ${APPROVER_SESSION_ID}, 'human', ${APPROVER_PERSON_ID}, NULL,
      'workspace-approver', '2026-07-16T09:00:00.000Z', '2026-07-16T12:00:00.000Z',
      '2026-08-16T09:00:00.000Z', NULL
    ), (
      ${WORKSPACE_ID}, ${AGENT_SESSION_ID}, 'agent', NULL, ${AGENT_ID},
      'workspace-owner', '2026-07-16T09:00:00.000Z', '2026-07-16T12:00:00.000Z',
      '2026-08-16T09:00:00.000Z', NULL
    )`
  })

const withFixture = <Success, Failure>(
  use: Effect.Effect<Success, Failure, FileSystem.FileSystem | Scope.Scope | SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-repair-review-migration-")
    return yield* use.pipe(
      Effect.provide(LibsqlClient.layer({ url: config.databaseUrl })),
      Effect.scoped
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("relationship repair review migration", () => {
  it.effect("preserves v19 intent and couples each review to its final proposal head", () =>
    withFixture(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* createVersionNineteenParents(sql)
      yield* migration0019RelationshipRepairProposals
      yield* sql`INSERT INTO relationship_repair_proposals (
        workspace_id, proposal_id, schema_version, release_id, environment_id,
        relationship_id, expected_revision, disposition, rationale, actor_kind,
        person_id, agent_id, session_id, status, proposed_at
      ) VALUES (
        ${WORKSPACE_ID}, ${PROPOSAL_ID}, 1, ${RELEASE_ID}, NULL,
        ${RELATIONSHIP_ID}, 1, 'verify', 'Verify the inferred relationship.', 'human',
        ${OWNER_PERSON_ID}, NULL, ${OWNER_SESSION_ID}, 'pending', ${PROPOSED_AT}
      ), (
        ${WORKSPACE_ID}, ${AGENT_PROPOSAL_ID}, 1, ${RELEASE_ID}, ${ENVIRONMENT_ID},
        ${AGENT_RELATIONSHIP_ID}, 1, 'reject', 'Dismiss the environment inference.', 'agent',
        NULL, ${AGENT_ID}, ${AGENT_SESSION_ID}, 'pending', ${AGENT_PROPOSED_AT}
      )`

      yield* migration0020RelationshipRepairReviews

      const migrated = yield* sql<{
        readonly agent_id: string | null
        readonly actor_kind: string
        readonly disposition: string
        readonly environment_id: string | null
        readonly expected_revision: number
        readonly person_id: string | null
        readonly proposal_id: string
        readonly proposed_at: string
        readonly rationale: string
        readonly relationship_id: string
        readonly release_id: string
        readonly schema_version: number
        readonly session_id: string
        readonly status: string
        readonly workspace_id: string
      }>`SELECT
        workspace_id, proposal_id, schema_version, release_id, environment_id, relationship_id,
        expected_revision, disposition, rationale, actor_kind, person_id,
        agent_id, session_id, status, proposed_at
      FROM relationship_repair_proposals
      ORDER BY proposal_id`
      assert.deepStrictEqual(migrated, [
        {
          workspace_id: WORKSPACE_ID,
          proposal_id: PROPOSAL_ID,
          schema_version: 2,
          release_id: RELEASE_ID,
          environment_id: null,
          relationship_id: RELATIONSHIP_ID,
          expected_revision: 1,
          disposition: "verify",
          rationale: "Verify the inferred relationship.",
          actor_kind: "human",
          person_id: OWNER_PERSON_ID,
          agent_id: null,
          session_id: OWNER_SESSION_ID,
          status: "pending",
          proposed_at: PROPOSED_AT
        },
        {
          workspace_id: WORKSPACE_ID,
          proposal_id: AGENT_PROPOSAL_ID,
          schema_version: 2,
          release_id: RELEASE_ID,
          environment_id: ENVIRONMENT_ID,
          relationship_id: AGENT_RELATIONSHIP_ID,
          expected_revision: 1,
          disposition: "reject",
          rationale: "Dismiss the environment inference.",
          actor_kind: "agent",
          person_id: null,
          agent_id: AGENT_ID,
          session_id: AGENT_SESSION_ID,
          status: "pending",
          proposed_at: AGENT_PROPOSED_AT
        }
      ])
      assert.isEmpty(yield* sql`SELECT * FROM relationship_repair_reviews`)

      const invalidFinalInsert = yield* sql`INSERT INTO relationship_repair_proposals (
        workspace_id, proposal_id, schema_version, release_id, environment_id,
        relationship_id, expected_revision, disposition, rationale, actor_kind,
        person_id, agent_id, session_id, status, proposed_at
      ) VALUES (
        ${WORKSPACE_ID}, ${FINAL_INSERT_ID}, 2, ${RELEASE_ID}, NULL,
        ${RELATIONSHIP_ID}, 1, 'verify', 'Bypass the review.', 'human',
        ${OWNER_PERSON_ID}, NULL, ${OWNER_SESSION_ID}, 'approved', ${PROPOSED_AT}
      )`.pipe(Effect.result)
      assert.isTrue(Result.isFailure(invalidFinalInsert))

      yield* sql`INSERT INTO relationship_repair_reviews (
        workspace_id, proposal_id, review_id, decision, rationale, actor_kind,
        person_id, agent_id, session_id, reviewed_at
      ) VALUES (
        ${WORKSPACE_ID}, ${PROPOSAL_ID}, ${REVIEW_ID}, 'approved',
        'The evidence is sufficient.', 'human', ${APPROVER_PERSON_ID}, NULL,
        ${APPROVER_SESSION_ID}, ${REVIEWED_AT}
      ), (
        ${WORKSPACE_ID}, ${AGENT_PROPOSAL_ID}, ${AGENT_REVIEW_ID}, 'rejected',
        'The environment evidence is incomplete.', 'human', ${APPROVER_PERSON_ID}, NULL,
        ${APPROVER_SESSION_ID}, ${REVIEWED_AT}
      )`

      const coupled = yield* sql<{
        readonly decision: string
        readonly review_id: string
        readonly status: string
      }>`SELECT proposal.status, review.review_id, review.decision
        FROM relationship_repair_proposals proposal
        JOIN relationship_repair_reviews review
          ON review.workspace_id = proposal.workspace_id
          AND review.proposal_id = proposal.proposal_id
        WHERE proposal.workspace_id = ${WORKSPACE_ID}
        ORDER BY proposal.proposal_id`
      assert.deepStrictEqual(coupled, [
        {
          status: "approved",
          review_id: REVIEW_ID,
          decision: "approved"
        },
        {
          status: "rejected",
          review_id: AGENT_REVIEW_ID,
          decision: "rejected"
        }
      ])

      const changedFinalState = yield* sql`UPDATE relationship_repair_proposals
        SET status = 'rejected'
        WHERE workspace_id = ${WORKSPACE_ID} AND proposal_id = ${PROPOSAL_ID}`.pipe(Effect.result)
      assert.isTrue(Result.isFailure(changedFinalState))
      assert.isEmpty(yield* sql`PRAGMA foreign_key_check`)
    })))
})
