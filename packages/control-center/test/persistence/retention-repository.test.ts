import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Result } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  completeDeferredCleanupBestEffort,
  Persistence,
  persistenceLayerFromDatabase
} from "../../src/server/persistence/Persistence.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { fixtureWorkspaceIds, makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_ID = fixtureWorkspaceIds.alpha
const CREATED_AT = DateTime.makeUnsafe("2024-01-01T00:00:00.000Z")
const NOW = DateTime.makeUnsafe("2026-07-30T12:00:00.000Z")
const OLD_EVENT_AT = "2024-12-31T23:59:59.000Z"
const CURRENT_EVENT_AT = "2026-07-01T00:00:00.000Z"
const EXPIRED_AT = "2026-07-01T00:00:00.000Z"
const DIGEST = "a".repeat(64)
const PREFIXED_DIGEST = `sha256:${DIGEST}`

const withPersistence = <Success, Failure>(use: Effect.Effect<Success, Failure, Database | Persistence>) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-retention-")
    const database = databaseLayer(config)
    const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
    return yield* use.pipe(Effect.provide(Layer.merge(database, persistence)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedRetentionFixtures = Effect.gen(function*() {
  const database = yield* Database
  const persistence = yield* Persistence
  yield* persistence.workspaces.create(WORKSPACE_ID, {
    displayName: WorkspaceName.make("Retention fixture"),
    createdAt: CREATED_AT
  })
  yield* persistence.workspaceSettings.get(WORKSPACE_ID)

  yield* database.sql`INSERT INTO plugin_connections (
      workspace_id, plugin_connection_id, provider_account_id, followed_resource_id,
      provider_id, display_name, revision, is_enabled, created_at, updated_at
    ) VALUES (
      ${WORKSPACE_ID}, '01890f6f-6d6a-7cc0-98d2-000000000300', NULL, NULL,
      'codecommit', 'Retention cache', 1, 1,
      '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'
    )`
  const cached = yield* persistence.content.put(WORKSPACE_ID, {
    bytes: new TextEncoder().encode("reproducible retention fixture"),
    classification: "reproducible-cache",
    mimeType: "text/plain",
    createdAt: CREATED_AT
  })
  const durable = yield* persistence.content.put(WORKSPACE_ID, {
    bytes: new TextEncoder().encode("durable retention fixture"),
    classification: "durable",
    mimeType: "text/plain",
    createdAt: CREATED_AT
  })
  yield* database.sql`INSERT INTO diff_content_cache_entries (
      workspace_id, plugin_connection_id, vendor_immutable_id, source_revision,
      file_anchor, file_status, side, content_digest, cached_at
    ) VALUES
      (
        ${WORKSPACE_ID}, '01890f6f-6d6a-7cc0-98d2-000000000300',
        'pull-request:retention', 'revision:old', ${PREFIXED_DIGEST},
        'modified', 'after', ${cached.metadata.digest}, '2024-01-01T00:00:00.000Z'
      ),
      (
        ${WORKSPACE_ID}, '01890f6f-6d6a-7cc0-98d2-000000000300',
        'pull-request:durable-retention', 'revision:old', ${`sha256:${"b".repeat(64)}`},
        'modified', 'after', ${durable.metadata.digest}, '2024-01-01T00:00:01.000Z'
      )`

  yield* database.sql`INSERT INTO domain_event_streams (
      workspace_id, next_cursor, pruned_through_cursor, updated_at
    ) VALUES (${WORKSPACE_ID}, 3, 0, ${CURRENT_EVENT_AT})`
  yield* database.sql`INSERT INTO domain_events (
      workspace_id, event_cursor, event_id, schema_version, event_type, dedupe_key,
      release_id, plugin_connection_id, entity_id, job_id, occurred_at, ingested_at,
      causation_id, correlation_id, payload_json, payload_digest
    ) VALUES
      (
        ${WORKSPACE_ID}, 1, '01890f6f-6d6a-7cc0-98d2-000000000301', 1,
        'retention-fixture', 'retention:old', NULL, NULL, NULL, NULL,
        ${OLD_EVENT_AT}, ${OLD_EVENT_AT}, NULL, NULL, '{}', ${DIGEST}
      ),
      (
        ${WORKSPACE_ID}, 2, '01890f6f-6d6a-7cc0-98d2-000000000302', 1,
        'retention-fixture', 'retention:current', NULL, NULL, NULL, NULL,
        ${CURRENT_EVENT_AT}, ${CURRENT_EVENT_AT}, NULL, NULL, '{}', ${DIGEST.replaceAll("a", "b")}
      )`

  const insertEvidence = (
    evidenceId: string,
    legalHold: number,
    retainUntil: string | null,
    evidenceDigestByte: string,
    freshnessDigestByte: string
  ) =>
    database.sql`INSERT INTO evidence_items (
        workspace_id, evidence_id, schema_version, evidence_digest, origin_kind,
        plugin_connection_id, source_entity_id, source_entity_revision, person_id,
        agent_id, system_component, verifier_kind, verifier_person_id,
        verifier_agent_id, verifier_component, observed_at, recorded_at, valid_until,
        freshness_json, freshness_digest, retention_class, retain_until, legal_hold
      ) VALUES (
        ${WORKSPACE_ID}, ${evidenceId}, 1, ${evidenceDigestByte.repeat(64)},
        'system', NULL, NULL, NULL, NULL, NULL, 'retention-test',
        'system', NULL, NULL, 'retention-test', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', NULL, '{}',
        ${freshnessDigestByte.repeat(64)},
        'evidence', ${retainUntil}, ${legalHold}
      )`
  yield* insertEvidence("evidence-expired-1", 0, EXPIRED_AT, "c", "d")
  yield* insertEvidence("evidence-held-2", 1, EXPIRED_AT, "e", "f")
  yield* insertEvidence("evidence-referenced-3", 0, EXPIRED_AT, "1", "2")
  yield* database.sql`INSERT INTO delivery_nodes (
      workspace_id, node_id, node_key_digest, node_kind, endpoint_kind,
      resolution_state, entity_id, release_id, environment_id,
      expected_entity_kind, missing_key, created_at
    ) VALUES (
      ${WORKSPACE_ID}, 'retention-missing-issue', ${"3".repeat(64)}, 'entity', 'issue',
      'missing', NULL, NULL, NULL, 'issue', 'retention-missing-issue',
      '2026-01-01T00:00:00.000Z'
    )`
  yield* database.sql`INSERT INTO evidence_claims (
      workspace_id, evidence_claim_id, evidence_id, subject_node_id, predicate,
      value_schema_version, value_json, value_digest, supersedes_claim_id, recorded_at
    ) VALUES (
      ${WORKSPACE_ID}, 'retention-evidence-claim', 'evidence-referenced-3',
      'retention-missing-issue', 'relationship-observed', 1, '{}', ${"4".repeat(64)},
      NULL, '2026-01-01T00:00:00.000Z'
    )`

  yield* database.sql`INSERT INTO releases (
      workspace_id, release_id, current_revision, created_at, updated_at
    ) VALUES (
      ${WORKSPACE_ID}, 'release-retention', 1,
      '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'
    )`
  yield* database.sql`INSERT INTO agent_threads (
      workspace_id, thread_id, thread_kind, subject_key, release_id,
      next_event_sequence, created_at
    ) VALUES (
      ${WORKSPACE_ID}, '01890f6f-6d6a-7cc0-98d2-000000000303',
      'release-chat', 'release-retention', 'release-retention', 2,
      '2024-01-01T00:00:00.000Z'
    )`
  yield* database.sql`INSERT INTO agent_jobs (
      workspace_id, job_id, thread_id, release_id, provider_id, model, access,
      prompt, context_fingerprint, subject_revision, task_context_json,
      task_context_digest, state, created_at, cancel_requested_at, terminal_at
    ) VALUES (
      ${WORKSPACE_ID}, '01890f6f-6d6a-7cc0-98d2-000000000304',
      '01890f6f-6d6a-7cc0-98d2-000000000303', 'release-retention',
      'fake', NULL, 'read-only', 'old prompt', ${PREFIXED_DIGEST},
      'release-revision:1', '{}', ${PREFIXED_DIGEST}, 'failed',
      '2024-01-01T00:00:00.000Z', NULL, '2024-01-01T01:00:00.000Z'
    )`
  const payload = "{\"prompt\":\"old prompt\"}"
  yield* database.sql`INSERT INTO agent_thread_events (
      workspace_id, thread_id, event_sequence, job_id, attempt_sequence,
      event_kind, payload_json, payload_digest, payload_byte_length, occurred_at
    ) VALUES (
      ${WORKSPACE_ID}, '01890f6f-6d6a-7cc0-98d2-000000000303', 1,
      '01890f6f-6d6a-7cc0-98d2-000000000304', NULL, 'user-message',
      ${payload}, ${PREFIXED_DIGEST}, length(CAST(${payload} AS BLOB)),
      '2024-01-01T00:00:00.000Z'
    )`
})

describe("RetentionRepository", () => {
  it.effect("does not replace a committed result with a deferred cleanup failure", () =>
    Effect.gen(function*() {
      const result = yield* completeDeferredCleanupBestEffort(
        Effect.fail("injected-deferred-cleanup-failure")
      ).pipe(Effect.result)
      assert.isTrue(Result.isSuccess(result))
    }))

  it.effect("bounds cleanup, protects held/current records, and attributes every class", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedRetentionFixtures
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
        const persistence = yield* Persistence
        const database = yield* Database

        const runs = yield* persistence.retention.sweepWorkspace(WORKSPACE_ID)
        assert.deepStrictEqual(
          runs.map(({ deletedCount, retentionClass, selectedCount }) => ({
            deletedCount,
            retentionClass,
            selectedCount
          })),
          [
            { deletedCount: 1, retentionClass: "audit-replay", selectedCount: 1 },
            { deletedCount: 2, retentionClass: "reproducible-content", selectedCount: 2 },
            { deletedCount: 1, retentionClass: "evidence", selectedCount: 1 },
            { deletedCount: 1, retentionClass: "agent-content", selectedCount: 1 }
          ]
        )

        const events = yield* database.sql<{ readonly eventCursor: number }>`SELECT event_cursor AS eventCursor
        FROM domain_events ORDER BY event_cursor`
        assert.deepStrictEqual(
          events.map(({ eventCursor }) => eventCursor),
          [2]
        )
        const streams = yield* database.sql<{ readonly prunedThroughCursor: number }>`SELECT
          pruned_through_cursor AS prunedThroughCursor
        FROM domain_event_streams WHERE workspace_id = ${WORKSPACE_ID}`
        assert.strictEqual(streams[0]?.prunedThroughCursor, 1)
        const cacheEntries = yield* database.sql`SELECT content_digest FROM diff_content_cache_entries
        WHERE workspace_id = ${WORKSPACE_ID}`
        const cacheBlobs = yield* database.sql`SELECT digest FROM content_blobs
        WHERE workspace_id = ${WORKSPACE_ID}
          AND storage_class = 'reproducible-cache'`
        const durableBlobs = yield* database.sql`SELECT digest FROM content_blobs
        WHERE workspace_id = ${WORKSPACE_ID}
          AND storage_class = 'durable'`
        const cleanupIntents = yield* database.sql`SELECT content_digest
        FROM diff_content_cache_cleanup
        WHERE workspace_id = ${WORKSPACE_ID}`
        assert.lengthOf(cacheEntries, 0)
        assert.lengthOf(cacheBlobs, 0)
        assert.lengthOf(durableBlobs, 1)
        assert.lengthOf(cleanupIntents, 0)

        const evidence = yield* database.sql<{ readonly evidenceId: string }>`SELECT evidence_id AS evidenceId
        FROM evidence_items ORDER BY evidence_id`
        assert.deepStrictEqual(
          evidence.map(({ evidenceId }) => evidenceId),
          ["evidence-held-2", "evidence-referenced-3"]
        )
        const jobs = yield* database.sql`SELECT job_id FROM agent_jobs WHERE workspace_id = ${WORKSPACE_ID}`
        const agentEvents = yield* database.sql`SELECT event_sequence FROM agent_thread_events
        WHERE workspace_id = ${WORKSPACE_ID}`
        assert.lengthOf(jobs, 0)
        assert.lengthOf(agentEvents, 0)

        const persistedRuns = yield* persistence.retention.listRuns(WORKSPACE_ID)
        assert.lengthOf(persistedRuns, 4)
        assert.isTrue(persistedRuns.every(({ policyRevision }) => policyRevision === 1))
        const residualClaims = yield* database.sql`SELECT record_key
        FROM retention_cleanup_claims
        WHERE workspace_id = ${WORKSPACE_ID}`
        assert.lengthOf(residualClaims, 0)
        const evidenceRun = persistedRuns.find(
          ({ retentionClass }) => retentionClass === "evidence"
        )
        assert.isDefined(evidenceRun)
        if (evidenceRun !== undefined) {
          const mismatchedClaim = yield* database.sql`INSERT INTO retention_cleanup_claims (
            workspace_id, run_id, retention_class, record_key
          ) VALUES (
            ${WORKSPACE_ID}, ${evidenceRun.runId}, 'agent-content', 'mismatched-class'
          )`.pipe(Effect.result)
          assert.isTrue(Result.isFailure(mismatchedClaim))
        }
        const mutation = yield* database.sql`UPDATE retention_cleanup_runs
        SET deleted_count = 0
        WHERE workspace_id = ${WORKSPACE_ID}`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(mutation))
        yield* database.sql`INSERT INTO evidence_items (
          workspace_id, evidence_id, schema_version, evidence_digest, origin_kind,
          plugin_connection_id, source_entity_id, source_entity_revision, person_id,
          agent_id, system_component, verifier_kind, verifier_person_id,
          verifier_agent_id, verifier_component, observed_at, recorded_at, valid_until,
          freshness_json, freshness_digest, retention_class, retain_until, legal_hold
        ) VALUES (
          ${WORKSPACE_ID}, 'evidence-expired-after-run', 1, ${"5".repeat(64)},
          'system', NULL, NULL, NULL, NULL, NULL, 'retention-test',
          'system', NULL, NULL, 'retention-test', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', NULL, '{}', ${"6".repeat(64)},
          'evidence', ${EXPIRED_AT}, 0
        )`
        const postRunDelete = yield* database.sql`DELETE FROM evidence_items
        WHERE workspace_id = ${WORKSPACE_ID}
          AND evidence_id = 'evidence-expired-after-run'`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(postRunDelete))
      })
    ))

  it.effect("skips mixed-age agent history without starving an eligible job", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedRetentionFixtures
        const persistence = yield* Persistence
        const database = yield* Database
        const protectedJobId = "01890f6f-6d6a-7cc0-98d2-000000000304"
        const eligibleThreadId = "01890f6f-6d6a-7cc0-98d2-000000000305"
        const eligibleJobId = "01890f6f-6d6a-7cc0-98d2-000000000306"
        const currentPayload = "{\"prompt\":\"current edit\"}"
        yield* database.sql`UPDATE agent_threads
          SET next_event_sequence = 3
          WHERE workspace_id = ${WORKSPACE_ID}
            AND thread_id = '01890f6f-6d6a-7cc0-98d2-000000000303'`
        yield* database.sql`INSERT INTO agent_thread_events (
          workspace_id, thread_id, event_sequence, job_id, attempt_sequence,
          event_kind, payload_json, payload_digest, payload_byte_length, occurred_at
        ) VALUES (
          ${WORKSPACE_ID}, '01890f6f-6d6a-7cc0-98d2-000000000303', 2,
          ${protectedJobId}, NULL, 'user-message',
          ${currentPayload}, ${`sha256:${"7".repeat(64)}`},
          length(CAST(${currentPayload} AS BLOB)), ${CURRENT_EVENT_AT}
        )`
        yield* database.sql`INSERT INTO agent_review_suggestion_revisions (
          workspace_id, source_job_id, suggestion_id, revision_sequence,
          revision_id, predecessor_revision_id, revision_json, revision_digest,
          created_at
        ) VALUES (
          ${WORKSPACE_ID}, ${protectedJobId}, ${`sha256:${"8".repeat(64)}`}, 2,
          ${`sha256:${"9".repeat(64)}`}, ${`sha256:${"a".repeat(64)}`},
          '{}', ${`sha256:${"b".repeat(64)}`}, ${CURRENT_EVENT_AT}
        )`
        yield* database.sql`INSERT INTO agent_threads (
          workspace_id, thread_id, thread_kind, subject_key, release_id,
          next_event_sequence, created_at
        ) VALUES (
          ${WORKSPACE_ID}, ${eligibleThreadId}, 'release-chat',
          'release-retention-eligible', 'release-retention', 2, ${OLD_EVENT_AT}
        )`
        yield* database.sql`INSERT INTO agent_jobs (
          workspace_id, job_id, thread_id, release_id, provider_id, model, access,
          prompt, context_fingerprint, subject_revision, task_context_json,
          task_context_digest, state, created_at, cancel_requested_at, terminal_at
        ) VALUES (
          ${WORKSPACE_ID}, ${eligibleJobId}, ${eligibleThreadId}, 'release-retention',
          'fake', NULL, 'read-only', 'eligible old prompt', ${PREFIXED_DIGEST},
          'release-revision:1', '{}', ${PREFIXED_DIGEST}, 'failed',
          ${OLD_EVENT_AT}, NULL, '2025-01-01T00:00:00.000Z'
        )`
        const oldPayload = "{\"prompt\":\"eligible old prompt\"}"
        yield* database.sql`INSERT INTO agent_thread_events (
          workspace_id, thread_id, event_sequence, job_id, attempt_sequence,
          event_kind, payload_json, payload_digest, payload_byte_length, occurred_at
        ) VALUES (
          ${WORKSPACE_ID}, ${eligibleThreadId}, 1, ${eligibleJobId}, NULL,
          'user-message', ${oldPayload}, ${`sha256:${"c".repeat(64)}`},
          length(CAST(${oldPayload} AS BLOB)), ${OLD_EVENT_AT}
        )`
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW))

        const runs = yield* persistence.retention.sweepWorkspace(WORKSPACE_ID)
        const remainingJobs = yield* database.sql<{ readonly jobId: string }>`SELECT
          job_id AS jobId
          FROM agent_jobs
          WHERE workspace_id = ${WORKSPACE_ID}
          ORDER BY job_id`
        const remainingRevisions = yield* database.sql`SELECT revision_id
          FROM agent_review_suggestion_revisions
          WHERE workspace_id = ${WORKSPACE_ID}
            AND source_job_id = ${protectedJobId}`
        const agentRun = runs.find(
          ({ retentionClass }) => retentionClass === "agent-content"
        )

        assert.deepStrictEqual(
          remainingJobs.map(({ jobId }) => jobId),
          [protectedJobId]
        )
        assert.lengthOf(remainingRevisions, 1)
        assert.strictEqual(agentRun?.selectedCount, 1)
        assert.strictEqual(agentRun?.deletedCount, 1)
      })
    ))

  it.effect("keeps immutable evidence and agent events protected without a cleanup run", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* seedRetentionFixtures
        const database = yield* Database
        const evidenceDelete = yield* database.sql`DELETE FROM evidence_items
        WHERE workspace_id = ${WORKSPACE_ID}
          AND evidence_id = 'evidence-expired-1'`.pipe(Effect.result)
        const eventDelete = yield* database.sql`DELETE FROM agent_thread_events
        WHERE workspace_id = ${WORKSPACE_ID}`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(evidenceDelete))
        assert.isTrue(Result.isFailure(eventDelete))
      })
    ))

  it.effect("prunes only the bounded contiguous replay prefix", () =>
    withPersistence(
      Effect.gen(function*() {
        const persistence = yield* Persistence
        const database = yield* Database
        yield* persistence.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Bounded replay retention"),
          createdAt: CREATED_AT
        })
        yield* persistence.workspaceSettings.get(WORKSPACE_ID)
        yield* database.sql`INSERT INTO domain_event_streams (
          workspace_id, next_cursor, pruned_through_cursor, updated_at
        ) VALUES (${WORKSPACE_ID}, 514, 0, ${OLD_EVENT_AT})`
        yield* database.sql`WITH RECURSIVE cursors(event_cursor) AS (
          SELECT 1
          UNION ALL
          SELECT event_cursor + 1 FROM cursors WHERE event_cursor < 513
        )
        INSERT INTO domain_events (
          workspace_id, event_cursor, event_id, schema_version, event_type, dedupe_key,
          release_id, plugin_connection_id, entity_id, job_id, occurred_at, ingested_at,
          causation_id, correlation_id, payload_json, payload_digest
        )
        SELECT
          ${WORKSPACE_ID}, event_cursor, printf('retention-event-%04d', event_cursor), 1,
          'retention-fixture', printf('retention:bounded:%04d', event_cursor),
          NULL, NULL, NULL, NULL, ${OLD_EVENT_AT}, ${OLD_EVENT_AT},
          NULL, NULL, '{}', ${DIGEST}
        FROM cursors`
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW))

        const runs = yield* persistence.retention.sweepWorkspace(WORKSPACE_ID)
        const remaining = yield* database.sql<{ readonly eventCursor: number }>`SELECT
          event_cursor AS eventCursor
        FROM domain_events
        WHERE workspace_id = ${WORKSPACE_ID}
        ORDER BY event_cursor`
        const stream = yield* database.sql<{ readonly prunedThroughCursor: number }>`SELECT
          pruned_through_cursor AS prunedThroughCursor
        FROM domain_event_streams
        WHERE workspace_id = ${WORKSPACE_ID}`

        assert.deepStrictEqual(
          runs.slice(0, 1).map(({ deletedCount, selectedCount }) => ({
            deletedCount,
            selectedCount
          })),
          [{ deletedCount: 512, selectedCount: 512 }]
        )
        assert.deepStrictEqual(
          remaining.map(({ eventCursor }) => eventCursor),
          [513]
        )
        assert.strictEqual(stream[0]?.prunedThroughCursor, 512)
      })
    ))

  it.effect("does not advance replay pruning across a current lower cursor", () =>
    withPersistence(
      Effect.gen(function*() {
        const persistence = yield* Persistence
        const database = yield* Database
        yield* persistence.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Contiguous replay retention"),
          createdAt: CREATED_AT
        })
        yield* persistence.workspaceSettings.get(WORKSPACE_ID)
        yield* database.sql`INSERT INTO domain_event_streams (
          workspace_id, next_cursor, pruned_through_cursor, updated_at
        ) VALUES (${WORKSPACE_ID}, 3, 0, ${CURRENT_EVENT_AT})`
        yield* database.sql`INSERT INTO domain_events (
          workspace_id, event_cursor, event_id, schema_version, event_type, dedupe_key,
          release_id, plugin_connection_id, entity_id, job_id, occurred_at, ingested_at,
          causation_id, correlation_id, payload_json, payload_digest
        ) VALUES
          (
            ${WORKSPACE_ID}, 1, 'retention-current-first', 1, 'retention-fixture',
            'retention:current-first', NULL, NULL, NULL, NULL,
            ${CURRENT_EVENT_AT}, ${CURRENT_EVENT_AT}, NULL, NULL, '{}', ${DIGEST}
          ),
          (
            ${WORKSPACE_ID}, 2, 'retention-old-second', 1, 'retention-fixture',
            'retention:old-second', NULL, NULL, NULL, NULL,
            ${OLD_EVENT_AT}, ${OLD_EVENT_AT}, NULL, NULL, '{}', ${"b".repeat(64)}
          )`
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW))

        const runs = yield* persistence.retention.sweepWorkspace(WORKSPACE_ID)
        const remaining = yield* database.sql<{ readonly eventCursor: number }>`SELECT
          event_cursor AS eventCursor
        FROM domain_events
        WHERE workspace_id = ${WORKSPACE_ID}
        ORDER BY event_cursor`
        const stream = yield* database.sql<{ readonly prunedThroughCursor: number }>`SELECT
          pruned_through_cursor AS prunedThroughCursor
        FROM domain_event_streams
        WHERE workspace_id = ${WORKSPACE_ID}`

        assert.strictEqual(runs[0]?.selectedCount, 0)
        assert.deepStrictEqual(
          remaining.map(({ eventCursor }) => eventCursor),
          [1, 2]
        )
        assert.strictEqual(stream[0]?.prunedThroughCursor, 0)
      })
    ))

  it.effect("audits large sandbox reconciliation results in bounded chunks", () =>
    withPersistence(
      Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* persistence.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Sandbox retention fixture"),
          createdAt: CREATED_AT
        })
        yield* persistence.workspaceSettings.get(WORKSPACE_ID)
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW))

        const runs = yield* persistence.retention.recordSandboxReconciliation(WORKSPACE_ID, 513)
        assert.deepStrictEqual(
          runs.map(({ deletedCount, selectedCount }) => ({
            deletedCount,
            selectedCount
          })),
          [
            { deletedCount: 512, selectedCount: 512 },
            { deletedCount: 1, selectedCount: 1 }
          ]
        )
        assert.isTrue(
          runs.every(({ batchLimit, retentionClass }) => batchLimit === 512 && retentionClass === "sandbox-artifact")
        )
      })
    ))
})
