import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Result, Schema } from "effect"

import { PersonId, SessionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  type RecordTimelineExportAuditInput,
  TimelineExportAuditInputError,
  TimelineExportAuditRepository
} from "../../src/server/persistence/repositories/timelineExportAuditRepository.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000161")
const personId = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000162")
const sessionId = Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-000000000163")
const otherPersonId = Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000164")

const withRepository = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Database | TimelineExportAuditRepository>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-timeline-export-audit-")
    const database = databaseLayer(config)
    const repository = TimelineExportAuditRepository.layer.pipe(Layer.provideMerge(database))
    return yield* use.pipe(Effect.provide(repository))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedAuthority = Effect.gen(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO workspaces (workspace_id, display_name, revision, created_at, updated_at)
    VALUES (${workspaceId}, 'Payments', 1, '1969-01-01T00:00:00.000Z', '1969-01-01T00:00:00.000Z')`
  yield* sql`INSERT INTO persons (
      workspace_id, person_id, display_name, avatar_json, is_active, revision, created_at, updated_at
    ) VALUES
    (
      ${workspaceId}, ${personId}, 'Ada Owner', '{"_tag":"initials","text":"AO"}',
      1, 1, '1969-01-01T00:00:00.000Z', '1969-01-01T00:00:00.000Z'
    ), (
      ${workspaceId}, ${otherPersonId}, 'Other Person', '{"_tag":"initials","text":"OP"}',
      1, 1, '1969-01-01T00:00:00.000Z', '1969-01-01T00:00:00.000Z'
    )`
  yield* sql`INSERT INTO sessions (
      workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id, agent_id,
      permission, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
    ) VALUES (
      ${workspaceId}, ${sessionId}, ${"a".repeat(64)}, ${"b".repeat(64)}, 'human',
      ${personId}, NULL, 'workspace-owner', '1969-01-01T00:00:00.000Z',
      '1969-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z', NULL
    )`
})

describe("TimelineExportAuditRepository", () => {
  it.effect("records complete attribution and keeps audit rows immutable", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthority
      const repository = yield* TimelineExportAuditRepository
      const { sql } = yield* Database

      yield* repository.record({
        workspaceId,
        personId,
        sessionId,
        format: "csv",
        actorKind: "agent",
        from: null,
        to: null,
        requestedLimit: 25,
        returnedCount: 7,
        truncated: true
      })

      const rows = yield* sql<{
        readonly actorFilter: string | null
        readonly format: string
        readonly isTruncated: number
        readonly personId: string
        readonly requestedLimit: number
        readonly returnedCount: number
        readonly sessionId: string
      }>`SELECT actor_filter AS actorFilter, format, is_truncated AS isTruncated,
          person_id AS personId, requested_limit AS requestedLimit,
          returned_count AS returnedCount, session_id AS sessionId
        FROM timeline_export_audits`
      assert.deepStrictEqual(rows, [{
        actorFilter: "agent",
        format: "csv",
        isTruncated: 1,
        personId,
        requestedLimit: 25,
        returnedCount: 7,
        sessionId
      }])
      assert.isTrue(Result.isFailure(
        yield* sql`UPDATE timeline_export_audits
        SET returned_count = 0 WHERE workspace_id = ${workspaceId}`.pipe(Effect.result)
      ))
      assert.isTrue(Result.isFailure(
        yield* sql`DELETE FROM timeline_export_audits
        WHERE workspace_id = ${workspaceId}`.pipe(Effect.result)
      ))
    })))

  it.effect("rejects an invalid limit before persistence", () =>
    withRepository(Effect.gen(function*() {
      const repository = yield* TimelineExportAuditRepository
      const result = yield* repository.record({
        workspaceId,
        personId,
        sessionId,
        format: "json",
        actorKind: null,
        from: null,
        to: null,
        requestedLimit: 0,
        returnedCount: 0,
        truncated: false
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, TimelineExportAuditInputError)
    })))

  it.effect("rejects mismatched and underprivileged session attribution", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthority
      const repository = yield* TimelineExportAuditRepository
      const { sql } = yield* Database
      const input: RecordTimelineExportAuditInput = {
        workspaceId,
        personId,
        sessionId,
        format: "json",
        actorKind: null,
        from: null,
        to: null,
        requestedLimit: 10,
        returnedCount: 0,
        truncated: false
      }

      assert.isTrue(Result.isFailure(
        yield* repository.record({ ...input, personId: otherPersonId }).pipe(Effect.result)
      ))
      yield* sql`UPDATE sessions SET permission = 'watcher'
        WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}`
      assert.isTrue(Result.isFailure(yield* repository.record(input).pipe(Effect.result)))
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM timeline_export_audits`
      assert.deepStrictEqual(rows, [{ count: 0 }])
    })))
})
