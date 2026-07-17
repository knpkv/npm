import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { renderTimelineQueries } from "@knpkv/control-center-sql"
import { Effect, Layer, Schema } from "effect"

import { WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { TimelineRepository } from "../../src/server/persistence/repositories/timelineRepository.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000141")
const newestAt = Schema.decodeSync(UtcTimestamp)("2026-07-17T12:00:00.000Z")
const olderAt = Schema.decodeSync(UtcTimestamp)("2026-07-17T11:00:00.000Z")
const newestEventId = "01890f6f-6d6a-7cc0-98d2-000000000142"
const olderEventId = "01890f6f-6d6a-7cc0-98d2-000000000143"
const ExplainQueryPlanRow = Schema.Struct({ detail: Schema.String })

const withRepository = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Database | TimelineRepository>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-timeline-repository-")
    const database = databaseLayer(config)
    return yield* use.pipe(Effect.provide(TimelineRepository.layer.pipe(Layer.provideMerge(database))))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedSystemEvents = Effect.gen(function*() {
  const { sql } = yield* Database
  const newest = Schema.encodeSync(UtcTimestamp)(newestAt)
  const older = Schema.encodeSync(UtcTimestamp)(olderAt)
  yield* sql`INSERT INTO workspaces (workspace_id, display_name, revision, created_at, updated_at)
    VALUES (${workspaceId}, 'Payments', 1, ${older}, ${newest})`
  yield* sql`INSERT INTO domain_events (
      workspace_id, event_cursor, event_id, schema_version, event_type, dedupe_key,
      job_id, occurred_at, ingested_at, payload_json, payload_digest
    ) VALUES
      (${workspaceId}, 1, ${olderEventId}, 1, 'release-indexed', 'older',
        NULL, ${older}, ${older}, '{}', ${"a".repeat(64)}),
      (${workspaceId}, 2, ${newestEventId}, 1, 'release-evaluated', 'newest',
        'agent-job-42', ${newest}, ${newest}, '{}', ${"b".repeat(64)})`
})

const seedCollidingLegacyPluginPageKeys = Effect.gen(function*() {
  const { sql } = yield* Database
  const committedAt = Schema.encodeSync(UtcTimestamp)(newestAt)
  const connectionId = "connection-source-id"
  yield* sql`INSERT INTO plugin_connections (
      workspace_id, plugin_connection_id, provider_id, display_name, revision,
      is_enabled, created_at, updated_at
    ) VALUES (
      ${workspaceId}, ${connectionId}, 'jira', 'Jira production', 1,
      1, ${committedAt}, ${committedAt}
    )`
  yield* sql`INSERT INTO plugin_sync_streams (
      workspace_id, plugin_connection_id, provider_id, stream_key, revision
    ) VALUES
      (${workspaceId}, ${connectionId}, 'jira', 'a:b', 0),
      (${workspaceId}, ${connectionId}, 'jira', 'a', 0)`
  yield* sql`INSERT INTO plugin_sync_pages (
      workspace_id, plugin_connection_id, stream_key, page_id, expected_revision,
      page_digest, checkpoint_digest, timeline_event_digest, event_count, committed_at
    ) VALUES
      (${workspaceId}, ${connectionId}, 'a:b', 'c', 0,
        ${"c".repeat(64)}, ${"d".repeat(64)}, ${"1".repeat(64)}, 0, ${committedAt}),
      (${workspaceId}, ${connectionId}, 'a', 'b:c', 0,
        ${"e".repeat(64)}, ${"f".repeat(64)}, ${"2".repeat(64)}, 0, ${committedAt})`
})

describe("TimelineRepository", () => {
  it.effect("merges newest-first rows and applies actor and stable cursor filters", () =>
    withRepository(Effect.gen(function*() {
      yield* seedSystemEvents
      const repository = yield* TimelineRepository
      const first = yield* repository.page({
        actorKind: "system",
        before: null,
        from: null,
        limit: 1,
        to: null,
        workspaceId
      })
      assert.deepStrictEqual(first.map(({ eventKey }) => eventKey), [
        `domain:${newestEventId}`,
        `domain:${olderEventId}`
      ])
      const firstEvent = first[0]
      if (firstEvent === undefined) return yield* Effect.die("Timeline fixture did not return its newest event")

      const second = yield* repository.page({
        actorKind: "system",
        before: { eventKey: firstEvent.eventKey, occurredAt: newestAt },
        from: null,
        limit: 1,
        to: null,
        workspaceId
      })
      assert.deepStrictEqual(second.map(({ eventKey }) => eventKey), [`domain:${olderEventId}`])

      const human = yield* repository.page({
        actorKind: "human",
        before: null,
        from: null,
        limit: 10,
        to: null,
        workspaceId
      })
      assert.deepStrictEqual(human, [])
    })))

  it.effect("paginates delimiter-ambiguous plugin pages with distinct redacted keys", () =>
    withRepository(Effect.gen(function*() {
      yield* seedSystemEvents
      yield* seedCollidingLegacyPluginPageKeys
      const repository = yield* TimelineRepository
      const first = yield* repository.page({
        actorKind: "plugin",
        before: null,
        from: null,
        limit: 1,
        to: null,
        workspaceId
      })
      assert.deepStrictEqual(first.map(({ eventKey }) => eventKey), [
        `sync:${"2".repeat(64)}`,
        `sync:${"1".repeat(64)}`
      ])
      assert.isFalse(
        first.some(({ eventKey }) =>
          eventKey.includes("connection-source-id") || eventKey.includes("a:b") || eventKey.includes("b:c")
        )
      )
      const firstEvent = first[0]
      if (firstEvent === undefined) return yield* Effect.die("Timeline fixture did not return its first plugin event")

      const second = yield* repository.page({
        actorKind: "plugin",
        before: { eventKey: firstEvent.eventKey, occurredAt: newestAt },
        from: null,
        limit: 1,
        to: null,
        workspaceId
      })
      assert.deepStrictEqual(second.map(({ eventKey }) => eventKey), [`sync:${"1".repeat(64)}`])
    })))

  it.effect("resolves one exact workspace event with owner-visible attribution", () =>
    withRepository(Effect.gen(function*() {
      yield* seedSystemEvents
      const repository = yield* TimelineRepository

      const detail = yield* repository.detail({
        eventKey: `domain:${newestEventId}`,
        workspaceId
      })
      assert.strictEqual(detail?.agentJobId, "agent-job-42")
      assert.strictEqual(detail?.eventType, "release-evaluated")

      const missing = yield* repository.detail({
        eventKey: "domain:missing",
        workspaceId
      })
      assert.isNull(missing)

      const otherWorkspace = yield* repository.detail({
        eventKey: `domain:${newestEventId}`,
        workspaceId: Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000199")
      })
      assert.isNull(otherWorkspace)
    })))

  it.effect("uses source-specific workspace-time indexes without temporary Timeline sorts", () =>
    withRepository(Effect.gen(function*() {
      const { sql } = yield* Database
      const plans = renderTimelineQueries({
        actorKind: null,
        before: null,
        from: "2026-07-01T00:00:00.000Z",
        limit: 25,
        to: "2026-07-31T23:59:59.999Z",
        workspaceId
      })
      const expectedIndexes: Readonly<Record<"action" | "plugin-sync" | "relationship" | "system", string>> = {
        action: "governed_action_audit_timeline_idx",
        "plugin-sync": "plugin_sync_pages_timeline_idx",
        relationship: "relationship_revision_timeline_idx",
        system: "domain_events_timeline_idx"
      }

      for (const plan of plans) {
        const rows = yield* sql.unsafe(`EXPLAIN QUERY PLAN ${plan.sql}`, [...plan.params]).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ExplainQueryPlanRow)))
        )
        const details = rows.map(({ detail }) => detail).join("\n")
        assert.include(details, expectedIndexes[plan.sourceKind])
        assert.notInclude(details, "USE TEMP B-TREE FOR ORDER BY")
      }

      const rowsWithoutIndex = yield* sql.unsafe(
        `EXPLAIN QUERY PLAN
          SELECT event_id
          FROM domain_events NOT INDEXED
          WHERE workspace_id = ?
          ORDER BY occurred_at DESC, event_id DESC
          LIMIT ?`,
        [workspaceId, 25]
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ExplainQueryPlanRow))))
      assert.include(
        rowsWithoutIndex.map(({ detail }) => detail).join("\n"),
        "USE TEMP B-TREE FOR ORDER BY"
      )
    })))
})
