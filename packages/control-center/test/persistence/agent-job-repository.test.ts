import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { AgentContextFingerprint, AgentProviderError, AgentProviderId, AgentSessionRef } from "@knpkv/ai-runtime"
import { Effect, Layer, Option, Result, Schema } from "effect"

import { JobId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { PersistedRecordError } from "../../src/server/persistence/errors.js"
import {
  AgentEventCursor,
  AgentJobInputError,
  AgentLeaseOwner,
  AgentLeaseToken,
  AgentThreadEventPageSize,
  MAXIMUM_AGENT_ATTEMPT_OUTPUT_BYTES
} from "../../src/server/persistence/repositories/agentJobModels.js"
import { AgentJobRepository } from "../../src/server/persistence/repositories/agentJobRepository.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000021")
const RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000031")
const SECOND_RELEASE_ID = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000032")
const JOB_ID = Schema.decodeSync(JobId)("01890f6f-6d6a-7cc0-98d2-000000000041")
const SECOND_JOB_ID = Schema.decodeSync(JobId)("01890f6f-6d6a-7cc0-98d2-000000000042")
const THIRD_JOB_ID = Schema.decodeSync(JobId)("01890f6f-6d6a-7cc0-98d2-000000000043")
const PROVIDER_ID = Schema.decodeSync(AgentProviderId)("fake")
const FINGERPRINT = Schema.decodeSync(AgentContextFingerprint)(`sha256:${"a".repeat(64)}`)
const LEASE_OWNER = Schema.decodeSync(AgentLeaseOwner)("worker-one")
const FIRST_TOKEN = Schema.decodeSync(AgentLeaseToken)("1".repeat(64))
const SECOND_TOKEN = Schema.decodeSync(AgentLeaseToken)("2".repeat(64))
const THIRD_TOKEN = Schema.decodeSync(AgentLeaseToken)("3".repeat(64))
const FOURTH_TOKEN = Schema.decodeSync(AgentLeaseToken)("4".repeat(64))
const SESSION_REF = Schema.decodeSync(AgentSessionRef)("session-one")
const CURSOR_ZERO = Schema.decodeSync(AgentEventCursor)(0)
const PAGE_SIZE = Schema.decodeSync(AgentThreadEventPageSize)(128)
const PAGE_TWO = Schema.decodeSync(AgentThreadEventPageSize)(2)
const T0 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:00:00.000Z")
const T1 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:01:00.000Z")
const T2 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:02:00.000Z")
const T3 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:03:00.000Z")
const T4 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:04:00.000Z")
const T5 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:05:00.000Z")
const T6 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:06:00.000Z")
const READ_ONLY: "read-only" = "read-only"

const enqueueInput = (jobId: typeof JobId.Type, releaseId = RELEASE_ID) => ({
  workspaceId: WORKSPACE_ID,
  releaseId,
  jobId,
  providerId: PROVIDER_ID,
  model: "fake-model",
  access: READ_ONLY,
  prompt: `Explain ${jobId}`,
  contextFingerprint: FINGERPRINT,
  subjectRevision: "release-revision-7",
  createdAt: T0
})

const claimInput = (
  leaseToken: typeof AgentLeaseToken.Type,
  claimedAt = T1,
  leaseExpiresAt = T2
) => ({
  workspaceId: WORKSPACE_ID,
  leaseOwner: LEASE_OWNER,
  leaseToken,
  claimedAt,
  leaseExpiresAt
})

const setupFoundation = Effect.gen(function*() {
  const database = yield* Database
  yield* database.sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, 'Agent jobs', 1, '2026-07-19T09:00:00.000Z',
    '2026-07-19T09:00:00.000Z'
  )`
  yield* database.sql`INSERT INTO releases (
    workspace_id, release_id, current_revision, created_at, updated_at
  ) VALUES
    (${WORKSPACE_ID}, ${RELEASE_ID}, 1, '2026-07-19T09:00:00.000Z',
      '2026-07-19T09:00:00.000Z'),
    (${WORKSPACE_ID}, ${SECOND_RELEASE_ID}, 1, '2026-07-19T09:00:00.000Z',
      '2026-07-19T09:00:00.000Z')`
})

const withRepositoryConfig = <Success, Failure>(
  config: {
    readonly blobRoot: string
    readonly busyTimeoutMilliseconds: number
    readonly databaseUrl: string
    readonly maxConnections: number
  },
  use: Effect.Effect<Success, Failure, AgentJobRepository | Database>
) => {
  const database = databaseLayer(config)
  const repository = AgentJobRepository.layer.pipe(Layer.provideMerge(database))
  return use.pipe(Effect.provide(repository), Effect.scoped)
}

const withRepository = <Success, Failure>(
  use: Effect.Effect<Success, Failure, AgentJobRepository | Database>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-agent-job-")
    return yield* withRepositoryConfig(config, use)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const replay = Effect.gen(function*() {
  const repository = yield* AgentJobRepository
  return yield* repository.threadAfter({
    workspaceId: WORKSPACE_ID,
    releaseId: RELEASE_ID,
    after: CURSOR_ZERO,
    limit: PAGE_SIZE
  })
})

describe("agent job repository", () => {
  it.effect("enqueues job and message events atomically into one workspace/release thread", () =>
    withRepository(Effect.gen(function*() {
      const repository = yield* AgentJobRepository
      yield* setupFoundation

      const firstThread = yield* repository.enqueue(enqueueInput(JOB_ID))
      const secondThread = yield* repository.enqueue(enqueueInput(SECOND_JOB_ID))
      const otherThread = yield* repository.enqueue(enqueueInput(THIRD_JOB_ID, SECOND_RELEASE_ID))
      assert.strictEqual(firstThread, secondThread)
      assert.notStrictEqual(firstThread, otherThread)

      const page = yield* replay
      assert.deepStrictEqual(
        page.events.map(({ eventKind, eventSequence, jobId }) => ({ eventKind, eventSequence, jobId })),
        [
          { eventKind: "user-message", eventSequence: 1, jobId: JOB_ID },
          { eventKind: "job-queued", eventSequence: 2, jobId: JOB_ID },
          { eventKind: "user-message", eventSequence: 3, jobId: SECOND_JOB_ID },
          { eventKind: "job-queued", eventSequence: 4, jobId: SECOND_JOB_ID }
        ]
      )
      assert.strictEqual(page.nextCursor, 4)

      const firstPage = yield* repository.threadAfter({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        after: CURSOR_ZERO,
        limit: PAGE_TWO
      })
      const secondPage = yield* repository.threadAfter({
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        after: firstPage.nextCursor,
        limit: PAGE_TWO
      })
      assert.deepStrictEqual(firstPage.events.map(({ eventSequence }) => eventSequence), [1, 2])
      assert.deepStrictEqual(secondPage.events.map(({ eventSequence }) => eventSequence), [3, 4])
    })))

  it.effect("cancels queued work terminally before any worker can claim it", () =>
    withRepository(Effect.gen(function*() {
      const database = yield* Database
      const repository = yield* AgentJobRepository
      yield* setupFoundation
      yield* repository.enqueue(enqueueInput(JOB_ID))
      yield* repository.requestCancellation({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        requestedAt: T1
      })
      const claim = yield* repository.claimNext(claimInput(FIRST_TOKEN, T1, T2))
      assert.isTrue(Option.isNone(claim))
      const rows = yield* database.sql<{
        readonly state: string
        readonly terminalAt: string
      }>`SELECT state, terminal_at AS terminalAt FROM agent_jobs
        WHERE workspace_id = ${WORKSPACE_ID} AND job_id = ${JOB_ID}`
      assert.deepStrictEqual(rows, [{ state: "cancelled", terminalAt: "2026-07-19T09:01:00.000Z" }])
      const page = yield* replay
      assert.strictEqual(page.events.at(-1)?.eventKind, "cancel-requested")
    })))

  it.effect("claims once, snapshots exact context, and reclaims an expired cancelled attempt", () =>
    withRepository(Effect.gen(function*() {
      const database = yield* Database
      const repository = yield* AgentJobRepository
      yield* setupFoundation
      yield* repository.enqueue(enqueueInput(JOB_ID))

      const claims = yield* Effect.all([
        repository.claimNext(claimInput(FIRST_TOKEN)),
        repository.claimNext(claimInput(SECOND_TOKEN))
      ], { concurrency: "unbounded" })
      const claimed = claims.find(Option.isSome)
      assert.isDefined(claimed)
      assert.strictEqual(claims.filter(Option.isSome).length, 1)
      if (claimed === undefined || Option.isNone(claimed)) return yield* Effect.die("claim missing")
      assert.strictEqual(claimed.value.attemptSequence, 1)
      assert.deepStrictEqual(claimed.value.context, {
        workspaceId: WORKSPACE_ID,
        releaseId: RELEASE_ID,
        subjectRevision: "release-revision-7",
        fingerprint: FINGERPRINT
      })

      const activeClaim = yield* repository.claimNext(claimInput(THIRD_TOKEN))
      assert.isTrue(Option.isNone(activeClaim))
      yield* repository.appendEvent({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        attemptSequence: claimed.value.attemptSequence,
        leaseToken: claimed.value.leaseToken,
        event: { _tag: "started", providerRunRef: "provider-run-one", sessionRef: SESSION_REF },
        occurredAt: T1
      })
      yield* repository.requestCancellation({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        requestedAt: T1
      })

      const reclaimed = yield* repository.claimNext(claimInput(THIRD_TOKEN, T3, T4))
      assert.isTrue(Option.isSome(reclaimed))
      if (Option.isNone(reclaimed)) return yield* Effect.die("reclaim missing")
      assert.strictEqual(reclaimed.value.attemptSequence, 2)
      assert.strictEqual(reclaimed.value.sessionRef, SESSION_REF)
      assert.isTrue(reclaimed.value.cancellationRequested)
      yield* repository.appendEvent({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        attemptSequence: reclaimed.value.attemptSequence,
        leaseToken: THIRD_TOKEN,
        event: { _tag: "started", providerRunRef: "provider-run-two", sessionRef: null },
        occurredAt: T3
      })
      const reclaimedAgain = yield* repository.claimNext(claimInput(FOURTH_TOKEN, T5, T6))
      assert.isTrue(Option.isSome(reclaimedAgain))
      if (Option.isNone(reclaimedAgain)) return yield* Effect.die("second reclaim missing")
      assert.strictEqual(reclaimedAgain.value.attemptSequence, 3)
      assert.strictEqual(reclaimedAgain.value.sessionRef, SESSION_REF)

      const attemptRows = yield* database.sql<{
        readonly attemptSequence: number
        readonly contextSnapshotDigest: string
        readonly contextSnapshotJson: string
      }>`SELECT attempt_sequence AS attemptSequence,
        context_snapshot_digest AS contextSnapshotDigest,
        context_snapshot_json AS contextSnapshotJson
        FROM agent_job_attempts
        WHERE workspace_id = ${WORKSPACE_ID} AND job_id = ${JOB_ID}
        ORDER BY attempt_sequence`
      assert.strictEqual(attemptRows.length, 3)
      assert.strictEqual(attemptRows[0]?.contextSnapshotDigest, attemptRows[1]?.contextSnapshotDigest)
      assert.strictEqual(attemptRows[1]?.contextSnapshotDigest, attemptRows[2]?.contextSnapshotDigest)
      assert.strictEqual(attemptRows[0]?.contextSnapshotJson, attemptRows[1]?.contextSnapshotJson)
      assert.strictEqual(attemptRows[1]?.contextSnapshotJson, attemptRows[2]?.contextSnapshotJson)
    })))

  it.effect("bounds cumulative provider output and commits a terminal event with attempt and job", () =>
    withRepository(Effect.gen(function*() {
      const database = yield* Database
      const repository = yield* AgentJobRepository
      yield* setupFoundation
      yield* repository.enqueue(enqueueInput(JOB_ID))
      const claimed = yield* repository.claimNext(claimInput(FIRST_TOKEN, T1, T5))
      if (Option.isNone(claimed)) return yield* Effect.die("claim missing")

      const wrongLease = yield* repository.appendEvent({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        attemptSequence: claimed.value.attemptSequence,
        leaseToken: SECOND_TOKEN,
        event: { _tag: "usage", inputTokens: 1, outputTokens: 1 },
        occurredAt: T2
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(wrongLease))
      if (Result.isFailure(wrongLease)) {
        const decodedFailure = Schema.decodeUnknownResult(Schema.toType(AgentJobInputError))(
          wrongLease.failure
        )
        assert.isTrue(Result.isSuccess(decodedFailure))
        if (Result.isSuccess(decodedFailure)) {
          assert.strictEqual(decodedFailure.success.reason, "lease-lost")
        }
      }

      yield* database.sql`UPDATE agent_job_attempts
        SET output_bytes = ${MAXIMUM_AGENT_ATTEMPT_OUTPUT_BYTES - 1}
        WHERE workspace_id = ${WORKSPACE_ID} AND job_id = ${JOB_ID}
          AND attempt_sequence = ${claimed.value.attemptSequence}`
      const overflow = yield* repository.appendEvent({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        attemptSequence: claimed.value.attemptSequence,
        leaseToken: FIRST_TOKEN,
        event: { _tag: "output", channel: "assistant", text: "xx" },
        occurredAt: T2
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(overflow))
      if (Result.isFailure(overflow)) {
        assert.instanceOf(overflow.failure, AgentJobInputError)
        if (overflow.failure._tag === "AgentJobInputError") {
          assert.strictEqual(overflow.failure.reason, "output-limit-exceeded")
        }
      }

      const terminal = yield* repository.appendEvent({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        attemptSequence: claimed.value.attemptSequence,
        leaseToken: FIRST_TOKEN,
        event: { _tag: "completed", outcome: "success", sessionRef: SESSION_REF },
        occurredAt: T3
      })
      assert.strictEqual(terminal.eventKind, "job-completed")
      const rows = yield* database.sql<{
        readonly attemptOutcome: string
        readonly jobState: string
        readonly leaseCount: number
      }>`SELECT
        attempt.outcome AS attemptOutcome,
        job.state AS jobState,
        (SELECT COUNT(*) FROM agent_job_leases lease
          WHERE lease.workspace_id = job.workspace_id AND lease.job_id = job.job_id) AS leaseCount
        FROM agent_jobs job
        JOIN agent_job_attempts attempt
          ON attempt.workspace_id = job.workspace_id AND attempt.job_id = job.job_id
        WHERE job.workspace_id = ${WORKSPACE_ID} AND job.job_id = ${JOB_ID}`
      assert.deepStrictEqual(rows, [{ attemptOutcome: "success", jobState: "succeeded", leaseCount: 0 }])
      const replayed = yield* replay
      assert.deepStrictEqual(
        replayed.events.map(({ eventKind }) => eventKind),
        ["user-message", "job-queued", "job-completed"]
      )
    })))

  it.effect("persists provider failure as one typed failed terminal boundary", () =>
    withRepository(Effect.gen(function*() {
      const database = yield* Database
      const repository = yield* AgentJobRepository
      yield* setupFoundation
      yield* repository.enqueue(enqueueInput(JOB_ID))
      const claimed = yield* repository.claimNext(claimInput(FIRST_TOKEN, T1, T5))
      if (Option.isNone(claimed)) return yield* Effect.die("claim missing")
      const providerError = new AgentProviderError({
        providerId: PROVIDER_ID,
        phase: "execution",
        message: "Deterministic provider failure",
        retryable: true
      })
      const failed = yield* repository.failAttempt({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        attemptSequence: claimed.value.attemptSequence,
        leaseToken: FIRST_TOKEN,
        error: providerError,
        failedAt: T2
      })
      assert.strictEqual(failed.eventKind, "job-failed")
      const rows = yield* database.sql<{
        readonly errorJson: string
        readonly outcome: string
        readonly state: string
      }>`SELECT attempt.error_json AS errorJson, attempt.outcome, job.state
        FROM agent_jobs job
        JOIN agent_job_attempts attempt
          ON attempt.workspace_id = job.workspace_id AND attempt.job_id = job.job_id
        WHERE job.workspace_id = ${WORKSPACE_ID} AND job.job_id = ${JOB_ID}`
      assert.strictEqual(rows[0]?.outcome, "failed")
      assert.strictEqual(rows[0]?.state, "failed")
      assert.include(rows[0]?.errorJson ?? "", "Deterministic provider failure")
      const replayed = yield* replay
      assert.strictEqual(replayed.events.at(-1)?.eventKind, "job-failed")
    })))

  it.effect("keeps a cancellation request durable across database restart and recovery claim", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-agent-job-restart-")
      yield* withRepositoryConfig(
        config,
        Effect.gen(function*() {
          const repository = yield* AgentJobRepository
          yield* setupFoundation
          yield* repository.enqueue(enqueueInput(JOB_ID))
          const claimed = yield* repository.claimNext(claimInput(FIRST_TOKEN))
          assert.isTrue(Option.isSome(claimed))
          yield* repository.requestCancellation({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            requestedAt: T1
          })
        })
      )

      yield* withRepositoryConfig(
        config,
        Effect.gen(function*() {
          const repository = yield* AgentJobRepository
          const recovered = yield* repository.claimNext(claimInput(SECOND_TOKEN, T3, T4))
          assert.isTrue(Option.isSome(recovered))
          if (Option.isNone(recovered)) return yield* Effect.die("recovery claim missing")
          assert.isTrue(recovered.value.cancellationRequested)
          const page = yield* replay
          assert.deepStrictEqual(
            page.events.map(({ eventKind }) => eventKind),
            ["user-message", "job-queued", "cancel-requested"]
          )
        })
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects replay when a persisted payload digest no longer matches", () =>
    withRepository(Effect.gen(function*() {
      const database = yield* Database
      const repository = yield* AgentJobRepository
      yield* setupFoundation
      yield* repository.enqueue(enqueueInput(JOB_ID))
      yield* database.sql`UPDATE agent_thread_events
        SET payload_digest = ${`sha256:${"b".repeat(64)}`}
        WHERE workspace_id = ${WORKSPACE_ID} AND job_id = ${JOB_ID}
          AND event_sequence = 1`
      const result = yield* replay.pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PersistedRecordError)

      yield* database.sql`UPDATE agent_thread_events
        SET payload_json = '{}',
            payload_digest = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
            payload_byte_length = 2
        WHERE workspace_id = ${WORKSPACE_ID} AND job_id = ${JOB_ID}
          AND event_sequence = 1`
      const invalidPayload = yield* replay.pipe(Effect.result)
      assert.isTrue(Result.isFailure(invalidPayload))
      if (Result.isFailure(invalidPayload)) {
        assert.instanceOf(invalidPayload.failure, PersistedRecordError)
      }
    })))
})
