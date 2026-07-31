import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Logger, Option, Ref, Result, Schema, Tracer } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { AgentThreadId, JobId, ReviewCommandArtifactId } from "../../src/domain/identifiers.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  Persistence,
  persistenceLayerFromDatabase,
  type PersistenceService
} from "../../src/server/persistence/Persistence.js"
import { AgentAttemptSequence } from "../../src/server/persistence/repositories/agentJobModels.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import {
  ReviewCommandArtifactMetadata,
  ReviewCommandArtifactRepository
} from "../../src/server/persistence/repositories/reviewCommandArtifactRepository.js"
import { WorkspaceSettingsRepository } from "../../src/server/persistence/repositories/workspaceSettingsRepository.js"
import { fixtureWorkspaceIds, makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_ID = fixtureWorkspaceIds.alpha
const THREAD_ID = AgentThreadId.make("01890f6f-6d6a-7cc0-98d2-000000000451")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000452")
const ATTEMPT_SEQUENCE = AgentAttemptSequence.make(1)
const CREATED_AT = DateTime.makeUnsafe("2026-07-31T10:00:00.000Z")
const BEFORE_EXPIRY = DateTime.makeUnsafe("2026-08-07T09:59:59.999Z")
const AT_EXPIRY = DateTime.makeUnsafe("2026-08-07T10:00:00.000Z")
const AFTER_EXPIRY = DateTime.makeUnsafe("2026-08-08T10:00:00.000Z")
const DIGEST = `sha256:${"a".repeat(64)}`
const PROMPT_CANARY = "prompt-canary-4c6fe70d"
const SOURCE_CANARY = "source-canary-55f99c93"
const MODEL_OUTPUT_CANARY = "model-output-canary-72337521"
const CREDENTIAL_CANARY = "credential-canary-8442aa1b"
const PATCH_CANARY = "replacement-patch-canary-e75ab784"
const SEARCH_QUERY_CANARY = "search-query-canary-f88d5d70"
const PERSISTENCE_EXCLUDES_PRIVATE_ARTIFACTS: "reviewCommandArtifacts" extends keyof PersistenceService ? true
  : false = false

const runWithPersistence = <Success, Failure>(
  config: unknown,
  use: Effect.Effect<Success, Failure, Database | Persistence | ReviewCommandArtifactRepository>
) => {
  const database = databaseLayer(config)
  const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
  const workspaceSettings = WorkspaceSettingsRepository.layer.pipe(
    Layer.provide(QuarantineRepository.layer.pipe(Layer.provide(database))),
    Layer.provide(database)
  )
  const reviewCommandArtifacts = ReviewCommandArtifactRepository.layer.pipe(
    Layer.provide(workspaceSettings),
    Layer.provide(database)
  )
  return use.pipe(
    Effect.provide(Layer.mergeAll(database, persistence, reviewCommandArtifacts)),
    Effect.scoped
  )
}

const withPersistence = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Database | Persistence | ReviewCommandArtifactRepository>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-review-artifact-")
    return yield* runWithPersistence(config, use)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedActiveReviewAttempt = Effect.gen(function*() {
  const database = yield* Database
  const persistence = yield* Persistence
  yield* persistence.workspaces.create(WORKSPACE_ID, {
    displayName: WorkspaceName.make("Review artifact fixture"),
    createdAt: CREATED_AT
  })
  yield* persistence.workspaceSettings.get(WORKSPACE_ID)
  yield* database.sql`INSERT INTO releases (
      workspace_id, release_id, current_revision, created_at, updated_at
    ) VALUES (
      ${WORKSPACE_ID}, 'review-artifact-release', 1,
      '2026-07-31T10:00:00.000Z', '2026-07-31T10:00:00.000Z'
    )`
  yield* database.sql`INSERT INTO agent_threads (
      workspace_id, thread_id, thread_kind, subject_key, release_id,
      next_event_sequence, created_at
    ) VALUES (
      ${WORKSPACE_ID}, ${THREAD_ID}, 'pr-review', 'review-artifact-subject',
      'review-artifact-release', 1, '2026-07-31T10:00:00.000Z'
    )`
  yield* database.sql`INSERT INTO agent_jobs (
      workspace_id, job_id, thread_id, release_id, provider_id, model, access,
      prompt, context_fingerprint, subject_revision, task_context_json,
      task_context_digest, state, created_at, cancel_requested_at, terminal_at
    ) VALUES (
      ${WORKSPACE_ID}, ${JOB_ID}, ${THREAD_ID}, 'review-artifact-release',
      'fake', NULL, 'read-only', ${PROMPT_CANARY}, ${DIGEST},
      'review-artifact-head', '{}', ${DIGEST}, 'running',
      '2026-07-31T10:00:00.000Z', NULL, NULL
    )`
  yield* database.sql`INSERT INTO agent_job_attempts (
      workspace_id, job_id, attempt_sequence, context_snapshot_json,
      context_snapshot_digest, output_bytes, provider_run_ref, session_ref,
      started_at, completed_at, outcome, error_json
    ) VALUES (
      ${WORKSPACE_ID}, ${JOB_ID}, ${ATTEMPT_SEQUENCE}, '{}', ${DIGEST},
      0, NULL, NULL, '2026-07-31T10:00:00.000Z', NULL, NULL, NULL
    )`
})

describe("ReviewCommandArtifactRepository", () => {
  it("stays behind the private repository seam", () => {
    assert.isFalse(PERSISTENCE_EXCLUDES_PRIVATE_ARTIFACTS)
  })

  it.effect("reads artifacts after the SQLite persistence layer is reopened", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-review-artifact-reopen-")
      yield* runWithPersistence(
        config,
        Effect.gen(function*() {
          yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
          yield* seedActiveReviewAttempt
          const artifacts = yield* ReviewCommandArtifactRepository
          const [metadata] = yield* artifacts.createCommand({
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            jobId: JOB_ID,
            attemptSequence: ATTEMPT_SEQUENCE,
            commandSequence: 1,
            artifacts: [{ stream: "stdout", content: "durable output" }]
          })
          if (metadata === undefined) return yield* Effect.die("expected artifact metadata")
        })
      )

      const page = yield* runWithPersistence(
        config,
        Effect.gen(function*() {
          const artifacts = yield* ReviewCommandArtifactRepository
          const [metadata] = yield* artifacts.list({
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            jobId: JOB_ID,
            limit: 1
          })
          if (metadata === undefined) return yield* Effect.die("expected discoverable artifact")
          return yield* artifacts.page({
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            jobId: JOB_ID,
            attemptSequence: metadata.attemptSequence,
            commandSequence: metadata.commandSequence,
            stream: metadata.stream,
            artifactId: metadata.artifactId,
            offset: 0,
            limit: 14
          })
        })
      )

      assert.deepStrictEqual(page, { complete: true, nextOffset: 14, text: "durable output" })
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("persists scoped raw output, exposes redacted metadata, and expires it without semantic cascades", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
        yield* seedActiveReviewAttempt
        const persistence = yield* Persistence
        const artifacts = yield* ReviewCommandArtifactRepository
        const database = yield* Database
        const content = `🙂${SOURCE_CANARY}\n${MODEL_OUTPUT_CANARY}\n${CREDENTIAL_CANARY}\n${PATCH_CANARY}\n` +
          `${SOURCE_CANARY}\n${SEARCH_QUERY_CANARY}\n\u0000tail`
        const logs = yield* Ref.make<Array<unknown>>([])
        const spans = new Array<Tracer.NativeSpan>()
        const logger = Logger.make<unknown, void>((entry) => {
          Effect.runSync(Ref.update(logs, (current) => [...current, entry.message]))
        })
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options)
            spans.push(span)
            return span
          }
        })
        const observe = <Success, Failure, Requirements>(
          effect: Effect.Effect<Success, Failure, Requirements>
        ) =>
          effect.pipe(
            Effect.withLogger(logger),
            Effect.provideService(Tracer.Tracer, tracer)
          )

        const [metadata] = yield* observe(artifacts.createCommand({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          artifacts: [{ stream: "stdout", content }]
        }))
        if (metadata === undefined) return yield* Effect.die("expected artifact metadata")
        assert.strictEqual(metadata.byteLength, new TextEncoder().encode(content).byteLength)

        const discovered = yield* observe(artifacts.list({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          limit: 10
        }))
        const page = yield* observe(artifacts.page({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: metadata.artifactId,
          offset: 4,
          limit: 22
        }))
        const unicodePage = yield* artifacts.page({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: metadata.artifactId,
          offset: 0,
          limit: 4
        })
        const matches = yield* observe(artifacts.search({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: metadata.artifactId,
          query: SOURCE_CANARY
        }))
        const queryMatches = yield* observe(artifacts.search({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: metadata.artifactId,
          query: SEARCH_QUERY_CANARY
        }))
        const exposed = JSON.stringify(
          {
            browserVisibleMetadata: discovered.map((artifact) =>
              Schema.encodeSync(ReviewCommandArtifactMetadata)(artifact)
            ),
            logs: yield* Ref.get(logs),
            spans: spans.map((span) => ({
              attributes: Array.from(span.attributes),
              events: span.events,
              name: span.name,
              status: span.status
            }))
          },
          (_key, value) => typeof value === "bigint" ? value.toString() : value
        )
        for (
          const canary of [
            PROMPT_CANARY,
            SOURCE_CANARY,
            MODEL_OUTPUT_CANARY,
            CREDENTIAL_CANARY,
            PATCH_CANARY,
            SEARCH_QUERY_CANARY
          ]
        ) {
          assert.notInclude(exposed, canary)
        }
        assert.include(exposed, metadata.artifactId)
        assert.include(exposed, String(metadata.byteLength))
        const nulPage = yield* artifacts.page({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: metadata.artifactId,
          offset: 169,
          limit: 5
        })
        const undersizedUnicodePage = yield* artifacts.page({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: metadata.artifactId,
          offset: 0,
          limit: 1
        }).pipe(Effect.result)
        const continuationOffset = yield* artifacts.page({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: metadata.artifactId,
          offset: 1,
          limit: 4
        }).pipe(Effect.result)
        assert.deepStrictEqual(unicodePage, { complete: false, nextOffset: 4, text: "🙂" })
        assert.deepStrictEqual(page, { complete: false, nextOffset: 26, text: SOURCE_CANARY })
        assert.deepStrictEqual(nulPage, { complete: true, nextOffset: 174, text: "\u0000tail" })
        assert.deepStrictEqual(matches, [4, 117])
        assert.deepStrictEqual(queryMatches, [140])
        assert.isTrue(Result.isFailure(undersizedUnicodePage))
        assert.isTrue(Result.isFailure(continuationOffset))

        const foreignScope = yield* artifacts.page({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JobId.make("01890f6f-6d6a-7cc0-98d2-000000000453"),
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: metadata.artifactId,
          offset: 0,
          limit: 10
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(foreignScope))

        const directMutation = yield* database.sql`UPDATE agent_review_command_artifacts
          SET content_blob = ${new TextEncoder().encode("changed")}
          WHERE workspace_id = ${WORKSPACE_ID}
            AND artifact_id = ${metadata.artifactId}`.pipe(Effect.result)
        const directDelete = yield* database.sql`DELETE FROM agent_review_command_artifacts
          WHERE workspace_id = ${WORKSPACE_ID}
            AND artifact_id = ${metadata.artifactId}`.pipe(Effect.result)
        const replacePrimaryKey = yield* database.sql`INSERT OR REPLACE INTO agent_review_command_artifacts (
            workspace_id, thread_id, job_id, attempt_sequence, command_sequence,
            artifact_id, stream, byte_length, content_blob, created_at, expires_at
          ) VALUES (
            ${WORKSPACE_ID}, ${THREAD_ID}, ${JOB_ID}, ${ATTEMPT_SEQUENCE}, 1,
            ${metadata.artifactId}, 'stdout', 7, CAST('changed' AS BLOB),
            '2026-07-31T10:00:00.000Z', '2026-08-07T10:00:00.000Z'
          )`.pipe(Effect.result)
        const replaceCommandIdentity = yield* database.sql`INSERT OR REPLACE INTO agent_review_command_artifacts (
              workspace_id, thread_id, job_id, attempt_sequence, command_sequence,
              artifact_id, stream, byte_length, content_blob, created_at, expires_at
            ) VALUES (
              ${WORKSPACE_ID}, ${THREAD_ID}, ${JOB_ID}, ${ATTEMPT_SEQUENCE}, 1,
              '01890f6f-6d6a-7cc0-98d2-000000000990', 'stdout', 7, CAST('changed' AS BLOB),
              '2026-07-31T10:00:00.000Z', '2026-08-07T10:00:00.000Z'
            )`.pipe(Effect.result)
        yield* database.sql`INSERT INTO agent_review_command_artifacts (
            workspace_id, thread_id, job_id, attempt_sequence, command_sequence,
            artifact_id, stream, byte_length, content_blob, created_at, expires_at
          ) VALUES (
            ${WORKSPACE_ID}, ${THREAD_ID}, ${JOB_ID}, ${ATTEMPT_SEQUENCE}, 2,
            '01890f6f-6d6a-7cc0-98d2-000000000989', 'stdout', 1, CAST('y' AS BLOB),
            '2026-07-31T10:00:00.000Z', '2026-08-07T10:00:00.000Z'
          )`
        assert.isTrue(Result.isFailure(directMutation))
        assert.isTrue(Result.isFailure(directDelete))
        assert.isTrue(Result.isFailure(replacePrimaryKey))
        assert.isTrue(Result.isFailure(replaceCommandIdentity))

        yield* TestClock.setTime(DateTime.toEpochMillis(BEFORE_EXPIRY))
        const beforeExpiry = yield* artifacts.page({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: metadata.artifactId,
          offset: 0,
          limit: 4
        })
        assert.strictEqual(beforeExpiry.text, "🙂")

        yield* TestClock.setTime(DateTime.toEpochMillis(AT_EXPIRY))
        const pageAtExpiry = yield* artifacts.page({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: metadata.artifactId,
          offset: 0,
          limit: 4
        }).pipe(Effect.result)
        const searchAtExpiry = yield* artifacts.search({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: metadata.artifactId,
          query: SOURCE_CANARY
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(pageAtExpiry))
        assert.isTrue(Result.isFailure(searchAtExpiry))

        yield* TestClock.setTime(DateTime.toEpochMillis(AFTER_EXPIRY))
        const runs = yield* persistence.retention.sweepWorkspace(WORKSPACE_ID)
        const artifactRun = runs.find(({ retentionClass }) => retentionClass === "sandbox-artifact")
        const retainedMetadata = yield* artifacts.metadata({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 1,
          stream: "stdout",
          artifactId: ReviewCommandArtifactId.make(metadata.artifactId)
        })
        const semanticJobs = yield* database.sql`SELECT job_id
          FROM agent_jobs
          WHERE workspace_id = ${WORKSPACE_ID}
            AND job_id = ${JOB_ID}`
        const semanticAttempts = yield* database.sql`SELECT attempt_sequence
          FROM agent_job_attempts
          WHERE workspace_id = ${WORKSPACE_ID}
            AND job_id = ${JOB_ID}`

        assert.strictEqual(artifactRun?.selectedCount, 2)
        assert.strictEqual(artifactRun?.deletedCount, 2)
        assert.isTrue(Option.isNone(retainedMetadata))
        assert.lengthOf(semanticJobs, 1)
        assert.lengthOf(semanticAttempts, 1)
      })
    ))

  it.effect("rejects a sixty-fifth artifact for one attempt at the schema boundary", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
        yield* seedActiveReviewAttempt
        const database = yield* Database
        yield* database.sql`WITH RECURSIVE sequences(value) AS (
            SELECT 1
            UNION ALL
            SELECT value + 1 FROM sequences WHERE value < 64
          )
          INSERT INTO agent_review_command_artifacts (
            workspace_id, thread_id, job_id, attempt_sequence, command_sequence,
            artifact_id, stream, byte_length, content_blob, created_at, expires_at
          )
          SELECT
            ${WORKSPACE_ID}, ${THREAD_ID}, ${JOB_ID}, ${ATTEMPT_SEQUENCE}, value,
            printf('01890f6f-6d6a-7cc0-98d2-%012d', value), 'stdout', 1, CAST('x' AS BLOB),
            '2026-07-31T10:00:00.000Z', '2026-08-07T10:00:00.000Z'
          FROM sequences`
        const overflow = yield* database.sql`INSERT INTO agent_review_command_artifacts (
            workspace_id, thread_id, job_id, attempt_sequence, command_sequence,
            artifact_id, stream, byte_length, content_blob, created_at, expires_at
          ) VALUES (
            ${WORKSPACE_ID}, ${THREAD_ID}, ${JOB_ID}, ${ATTEMPT_SEQUENCE}, 65,
            '01890f6f-6d6a-7cc0-98d2-000000000999', 'stdout', 1, CAST('x' AS BLOB),
            '2026-07-31T10:00:00.000Z', '2026-08-07T10:00:00.000Z'
          )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(overflow))
      })
    ))

  it.effect("atomically commits both retained streams when the attempt has room", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
        yield* seedActiveReviewAttempt
        const database = yield* Database
        const artifacts = yield* ReviewCommandArtifactRepository
        yield* database.sql`WITH RECURSIVE sequences(value) AS (
            SELECT 1
            UNION ALL
            SELECT value + 1 FROM sequences WHERE value < 62
          )
          INSERT INTO agent_review_command_artifacts (
            workspace_id, thread_id, job_id, attempt_sequence, command_sequence,
            artifact_id, stream, byte_length, content_blob, created_at, expires_at
          )
          SELECT
            ${WORKSPACE_ID}, ${THREAD_ID}, ${JOB_ID}, ${ATTEMPT_SEQUENCE}, value,
            printf('01890f6f-6d6a-7cc0-98d2-%012d', value), 'stdout', 1, CAST('x' AS BLOB),
            '2026-07-31T10:00:00.000Z', '2026-08-07T10:00:00.000Z'
          FROM sequences`
        const created = yield* artifacts.createCommand({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 63,
          artifacts: [
            { stream: "stderr", content: "stderr" },
            { stream: "stdout", content: "stdout" }
          ]
        })
        const rows = yield* database.sql`SELECT artifact_id
          FROM agent_review_command_artifacts
          WHERE workspace_id = ${WORKSPACE_ID}
            AND job_id = ${JOB_ID}`
        assert.lengthOf(created, 2)
        assert.lengthOf(rows, 64)
      })
    ))

  it.effect("rolls back both retained streams when one would exceed attempt capacity", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
        yield* seedActiveReviewAttempt
        const database = yield* Database
        const artifacts = yield* ReviewCommandArtifactRepository
        yield* database.sql`WITH RECURSIVE sequences(value) AS (
            SELECT 1
            UNION ALL
            SELECT value + 1 FROM sequences WHERE value < 63
          )
          INSERT INTO agent_review_command_artifacts (
            workspace_id, thread_id, job_id, attempt_sequence, command_sequence,
            artifact_id, stream, byte_length, content_blob, created_at, expires_at
          )
          SELECT
            ${WORKSPACE_ID}, ${THREAD_ID}, ${JOB_ID}, ${ATTEMPT_SEQUENCE}, value,
            printf('01890f6f-6d6a-7cc0-98d2-%012d', value), 'stdout', 1, CAST('x' AS BLOB),
            '2026-07-31T10:00:00.000Z', '2026-08-07T10:00:00.000Z'
          FROM sequences`
        const rejected = yield* artifacts.createCommand({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          jobId: JOB_ID,
          attemptSequence: ATTEMPT_SEQUENCE,
          commandSequence: 64,
          artifacts: [
            { stream: "stderr", content: "stderr" },
            { stream: "stdout", content: "stdout" }
          ]
        }).pipe(Effect.result)
        const rows = yield* database.sql`SELECT artifact_id
          FROM agent_review_command_artifacts
          WHERE workspace_id = ${WORKSPACE_ID}
            AND job_id = ${JOB_ID}`
        const partial = yield* database.sql`SELECT artifact_id
          FROM agent_review_command_artifacts
          WHERE workspace_id = ${WORKSPACE_ID}
            AND job_id = ${JOB_ID}
            AND command_sequence = 64`
        assert.isTrue(Result.isFailure(rejected))
        assert.lengthOf(rows, 63)
        assert.lengthOf(partial, 0)
      })
    ))

  it.effect("enforces per-artifact and aggregate byte budgets at the schema boundary", () =>
    withPersistence(
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
        yield* seedActiveReviewAttempt
        const database = yield* Database
        const oversized = yield* database.sql`INSERT INTO agent_review_command_artifacts (
            workspace_id, thread_id, job_id, attempt_sequence, command_sequence,
            artifact_id, stream, byte_length, content_blob, created_at, expires_at
          ) VALUES (
            ${WORKSPACE_ID}, ${THREAD_ID}, ${JOB_ID}, ${ATTEMPT_SEQUENCE}, 1,
            '01890f6f-6d6a-7cc0-98d2-000000000991', 'stdout', 16777217,
            zeroblob(16777217), '2026-07-31T10:00:00.000Z', '2026-08-07T10:00:00.000Z'
          )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(oversized))

        yield* database.sql`WITH RECURSIVE sequences(value) AS (
            SELECT 1
            UNION ALL
            SELECT value + 1 FROM sequences WHERE value < 4
          )
          INSERT INTO agent_review_command_artifacts (
            workspace_id, thread_id, job_id, attempt_sequence, command_sequence,
            artifact_id, stream, byte_length, content_blob, created_at, expires_at
          )
          SELECT
            ${WORKSPACE_ID}, ${THREAD_ID}, ${JOB_ID}, ${ATTEMPT_SEQUENCE}, value,
            printf('01890f6f-6d6a-7cc0-98d2-%012d', value), 'stdout', 16777216,
            zeroblob(16777216), '2026-07-31T10:00:00.000Z', '2026-08-07T10:00:00.000Z'
          FROM sequences`
        const aggregateOverflow = yield* database.sql`INSERT INTO agent_review_command_artifacts (
            workspace_id, thread_id, job_id, attempt_sequence, command_sequence,
            artifact_id, stream, byte_length, content_blob, created_at, expires_at
          ) VALUES (
            ${WORKSPACE_ID}, ${THREAD_ID}, ${JOB_ID}, ${ATTEMPT_SEQUENCE}, 5,
            '01890f6f-6d6a-7cc0-98d2-000000000992', 'stdout', 1, zeroblob(1),
            '2026-07-31T10:00:00.000Z', '2026-08-07T10:00:00.000Z'
          )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(aggregateOverflow))
      })
    ))
})
