import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { AgentContextFingerprint, AgentProviderId } from "@knpkv/ai-runtime"
import { DateTime, Effect, Layer, Option, Result, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { JobId, ReleaseId, WorkspaceId } from "../../src/domain/identifiers.js"
import { PrReviewReport, type PrReviewSubject } from "../../src/domain/prReview.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { PersistedRecordError, RecordNotFoundError } from "../../src/server/persistence/errors.js"
import {
  AgentEventCursor,
  AgentJobInputError,
  AgentLeaseOwner,
  AgentLeaseToken,
  AgentThreadEventPageSize
} from "../../src/server/persistence/repositories/agentJobModels.js"
import { AgentJobRepository } from "../../src/server/persistence/repositories/agentJobRepository.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000021")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000031")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000041")
const SWAP_JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000042")
const PROVIDER_ID = AgentProviderId.make("deterministic-review")
const FINGERPRINT = AgentContextFingerprint.make(`sha256:${"a".repeat(64)}`)
const LEASE_OWNER = AgentLeaseOwner.make("review-worker")
const LEASE_TOKEN = AgentLeaseToken.make("1".repeat(64))
const T0 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:00:00.000Z")
const T1 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:01:00.000Z")
const T2 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:02:00.000Z")
const T3 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:03:00.000Z")

const subject = {
  providerId: "codecommit",
  repository: "control-center",
  pullRequestId: "212",
  baseRevision: "1".repeat(40),
  headRevision: "2".repeat(40)
} satisfies PrReviewSubject

const swappedSubject = {
  ...subject,
  pullRequestId: "213",
  headRevision: "3".repeat(40)
} satisfies PrReviewSubject

const report = Schema.decodeUnknownSync(PrReviewReport)({
  schemaVersion: 1,
  subject,
  recommendation: "changes-recommended",
  summary: "One durable review finding.",
  findings: [
    {
      findingId: "finding-1",
      severity: "high",
      path: "packages/control-center/src/server/agent/AgentJobWorker.ts",
      startLine: 42,
      endLine: 45,
      title: "Review output must cross a typed boundary",
      detail: "Decode the complete report before committing model-authored output.",
      prevention: {
        summary: "Protect active-lease review completion.",
        enforcement: "test",
        existingRuleOrConfig: "agent job repository integration suite",
        targetFile: "packages/control-center/test/persistence/agent-job-review-results.test.ts",
        sourcePaths: ["packages/control-center/src/server/persistence/repositories/agentJobRepository.ts"],
        matcherOrInvariant: "A review result and terminal state commit under the same active lease.",
        invalidFixture: "completeReview({ leaseToken: staleLease })",
        validFixture: "completeReview({ leaseToken: activeLease })",
        boundary: "Only durable PR-review jobs are covered."
      }
    }
  ]
})

const setupFoundation = Effect.gen(function*() {
  const database = yield* Database
  yield* database.sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, 'Review results', 1, '2026-07-19T09:00:00.000Z',
    '2026-07-19T09:00:00.000Z'
  )`
  yield* database.sql`INSERT INTO releases (
    workspace_id, release_id, current_revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, ${RELEASE_ID}, 1, '2026-07-19T09:00:00.000Z',
    '2026-07-19T09:00:00.000Z'
  )`
})

const enqueueReviewFor = (jobId: typeof JobId.Type, taskSubject: PrReviewSubject) =>
  Effect.gen(function*() {
    const jobs = yield* AgentJobRepository
    yield* jobs.enqueue({
      workspaceId: WORKSPACE_ID,
      releaseId: RELEASE_ID,
      jobId,
      providerId: PROVIDER_ID,
      model: "deterministic-review-model",
      access: "read-only",
      userPrompt: "Review the immutable pull request.",
      prompt: "Review the immutable pull request.",
      contextFingerprint: FINGERPRINT,
      subjectRevision: taskSubject.headRevision,
      task: { _tag: "pr-review", subject: taskSubject },
      createdAt: T0
    })
  })

const enqueueReview = enqueueReviewFor(JOB_ID, subject)

const claimReview = Effect.gen(function*() {
  const jobs = yield* AgentJobRepository
  yield* TestClock.setTime(DateTime.toEpochMillis(T1))
  const claimed = yield* jobs.claimNext({
    workspaceId: WORKSPACE_ID,
    leaseOwner: LEASE_OWNER,
    leaseToken: LEASE_TOKEN,
    claimedAt: T1,
    leaseExpiresAt: T3
  })
  if (Option.isNone(claimed)) return yield* Effect.die("review claim missing")
  return claimed.value
})

const withRepository = <Success, Failure>(use: Effect.Effect<Success, Failure, AgentJobRepository | Database>) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-agent-review-result-")
    const database = databaseLayer(config)
    const repository = AgentJobRepository.layer.pipe(Layer.provideMerge(database))
    return yield* use.pipe(Effect.provide(repository), Effect.scoped)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("agent job review results", () => {
  it.effect("atomically persists one sanitized report and terminal state under the active lease", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const claim = yield* claimReview

        const staleLease = yield* jobs
          .completeReview({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            attemptSequence: claim.attemptSequence,
            leaseToken: AgentLeaseToken.make("2".repeat(64)),
            report,
            completedAt: T2
          })
          .pipe(Effect.result)
        assert.isTrue(Result.isFailure(staleLease))
        if (Result.isFailure(staleLease)) {
          const failure = Schema.decodeUnknownSync(AgentJobInputError)(staleLease.failure)
          assert.strictEqual(failure.reason, "lease-lost")
        }

        yield* jobs.completeReview({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: claim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          report,
          completedAt: T2
        })

        const persisted = yield* jobs.reviewResult({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID
        })
        assert.strictEqual(persisted.attemptSequence, claim.attemptSequence)
        assert.deepStrictEqual(persisted.report, report)
        assert.isTrue(DateTime.Equivalence(persisted.completedAt, T2))

        const page = yield* jobs.threadAfter({
          workspaceId: WORKSPACE_ID,
          releaseId: RELEASE_ID,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        assert.deepStrictEqual(
          page.events.map(({ eventKind, task }) => ({ eventKind, task })),
          [
            { eventKind: "user-message", task: { _tag: "pr-review", subject } },
            { eventKind: "job-queued", task: { _tag: "pr-review", subject } },
            { eventKind: "review-report", task: { _tag: "pr-review", subject } },
            { eventKind: "job-completed", task: { _tag: "pr-review", subject } }
          ]
        )
      })
    ))

  it.effect("rejects malformed output without partially terminalizing the active attempt", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const claim = yield* claimReview
        const malformed = {
          ...report,
          findings: [{ ...report.findings[0]!, path: "../host-secret" }]
        }

        const rejected = yield* jobs
          .completeReview({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            attemptSequence: claim.attemptSequence,
            leaseToken: LEASE_TOKEN,
            report: malformed,
            completedAt: T2
          })
          .pipe(Effect.result)
        assert.isTrue(Result.isFailure(rejected))
        if (Result.isFailure(rejected)) {
          assert.instanceOf(rejected.failure, AgentJobInputError)
          if (rejected.failure._tag === "AgentJobInputError") {
            assert.strictEqual(rejected.failure.reason, "invalid-result")
          }
        }
        assert.instanceOf(
          yield* jobs.reviewResult({ workspaceId: WORKSPACE_ID, jobId: JOB_ID }).pipe(Effect.flip),
          RecordNotFoundError
        )

        yield* jobs.completeReview({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: claim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          report,
          completedAt: T2
        })
        assert.deepStrictEqual((yield* jobs.reviewResult({ workspaceId: WORKSPACE_ID, jobId: JOB_ID })).report, report)
      })
    ))

  it.effect("requires the review completion boundary except for requested cancellation", () =>
    withRepository(
      Effect.gen(function*() {
        const database = yield* Database
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const claim = yield* claimReview

        const runtimeOutput = yield* jobs.appendEvent({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: claim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          event: { _tag: "output", channel: "assistant", text: "unstructured review" },
          occurredAt: T2
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(runtimeOutput))
        if (Result.isFailure(runtimeOutput)) {
          assert.instanceOf(runtimeOutput.failure, AgentJobInputError)
          if (runtimeOutput.failure._tag === "AgentJobInputError") {
            assert.strictEqual(runtimeOutput.failure.reason, "invalid-transition")
          }
        }

        const runtimeCompletion = yield* jobs.appendEvent({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: claim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          event: { _tag: "completed", outcome: "success", sessionRef: null },
          occurredAt: T2
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(runtimeCompletion))
        if (Result.isFailure(runtimeCompletion)) {
          assert.instanceOf(runtimeCompletion.failure, AgentJobInputError)
          if (runtimeCompletion.failure._tag === "AgentJobInputError") {
            assert.strictEqual(runtimeCompletion.failure.reason, "invalid-transition")
          }
        }

        const beforeCancellation = yield* database.sql<{
          readonly completedAttemptCount: number
          readonly state: string
        }>`SELECT
          state,
          (SELECT COUNT(*) FROM agent_job_attempts
            WHERE workspace_id = ${WORKSPACE_ID}
              AND job_id = ${JOB_ID}
              AND completed_at IS NOT NULL) AS completedAttemptCount
          FROM agent_jobs
          WHERE workspace_id = ${WORKSPACE_ID} AND job_id = ${JOB_ID}`
        assert.deepStrictEqual(beforeCancellation, [{ state: "running", completedAttemptCount: 0 }])
        assert.instanceOf(
          yield* jobs.reviewResult({ workspaceId: WORKSPACE_ID, jobId: JOB_ID }).pipe(Effect.flip),
          RecordNotFoundError
        )

        yield* jobs.requestCancellation({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          requestedAt: T2
        })
        yield* jobs.appendEvent({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: claim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          event: { _tag: "completed", outcome: "cancelled", sessionRef: null },
          occurredAt: T2
        })

        const afterCancellation = yield* database.sql<{ readonly state: string }>`SELECT state
          FROM agent_jobs
          WHERE workspace_id = ${WORKSPACE_ID} AND job_id = ${JOB_ID}`
        assert.deepStrictEqual(afterCancellation, [{ state: "cancelled" }])
      })
    ))

  it.effect("allows only one concurrent terminal review result for a leased job", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const claim = yield* claimReview
        const alternate: PrReviewReport = {
          ...report,
          recommendation: "no-material-findings",
          summary: "No durable findings.",
          findings: []
        }

        const attempts = yield* Effect.all(
          [
            jobs
              .completeReview({
                workspaceId: WORKSPACE_ID,
                jobId: JOB_ID,
                attemptSequence: claim.attemptSequence,
                leaseToken: LEASE_TOKEN,
                report,
                completedAt: T2
              })
              .pipe(Effect.result),
            jobs
              .completeReview({
                workspaceId: WORKSPACE_ID,
                jobId: JOB_ID,
                attemptSequence: claim.attemptSequence,
                leaseToken: LEASE_TOKEN,
                report: alternate,
                completedAt: T2
              })
              .pipe(Effect.result)
          ],
          { concurrency: "unbounded" }
        )

        assert.strictEqual(attempts.filter(Result.isSuccess).length, 1)
        assert.strictEqual(attempts.filter(Result.isFailure).length, 1)
        const persisted = yield* jobs.reviewResult({ workspaceId: WORKSPACE_ID, jobId: JOB_ID })
        assert.isTrue(persisted.report.summary === report.summary || persisted.report.summary === alternate.summary)
      })
    ))

  it.effect("rejects structurally valid task contexts swapped without their persisted digests before claiming", () =>
    withRepository(
      Effect.gen(function*() {
        const database = yield* Database
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* enqueueReviewFor(SWAP_JOB_ID, swappedSubject)

        const contexts = yield* database.sql<
          {
            readonly jobId: string
            readonly taskContextDigest: string
            readonly taskContextJson: string
          }
        >`SELECT
          job_id AS jobId,
          task_context_json AS taskContextJson,
          task_context_digest AS taskContextDigest
          FROM agent_jobs
          WHERE workspace_id = ${WORKSPACE_ID}
            AND job_id IN (${JOB_ID}, ${SWAP_JOB_ID})
          ORDER BY job_id`
        const first = contexts[0]
        const second = contexts[1]
        if (first === undefined || second === undefined) {
          return yield* Effect.die("review task contexts missing")
        }
        assert.notStrictEqual(first.taskContextJson, second.taskContextJson)
        assert.notStrictEqual(first.taskContextDigest, second.taskContextDigest)

        yield* database.sql`UPDATE agent_jobs
          SET task_context_json = CASE job_id
            WHEN ${JOB_ID} THEN ${second.taskContextJson}
            WHEN ${SWAP_JOB_ID} THEN ${first.taskContextJson}
          END
          WHERE workspace_id = ${WORKSPACE_ID}
            AND job_id IN (${JOB_ID}, ${SWAP_JOB_ID})`

        yield* TestClock.setTime(DateTime.toEpochMillis(T1))
        const claim = yield* jobs
          .claimNext({
            workspaceId: WORKSPACE_ID,
            leaseOwner: LEASE_OWNER,
            leaseToken: LEASE_TOKEN,
            claimedAt: T1,
            leaseExpiresAt: T3
          })
          .pipe(Effect.result)
        assert.isTrue(Result.isFailure(claim))
        if (Result.isFailure(claim)) {
          assert.instanceOf(claim.failure, PersistedRecordError)
          if (claim.failure._tag === "PersistedRecordError") {
            assert.strictEqual(claim.failure.recordKind, "agent-job")
            assert.strictEqual(claim.failure.recordKey, JOB_ID)
            assert.strictEqual(claim.failure.diagnosticCode, "agent-job-task-context-integrity-invalid")
          }
        }

        const durableState = yield* database.sql<
          {
            readonly attemptCount: number
            readonly leaseCount: number
            readonly state: string
          }
        >`SELECT
          state,
          (SELECT COUNT(*) FROM agent_job_attempts
            WHERE workspace_id = ${WORKSPACE_ID} AND job_id = ${JOB_ID}) AS attemptCount,
          (SELECT COUNT(*) FROM agent_job_leases
            WHERE workspace_id = ${WORKSPACE_ID} AND job_id = ${JOB_ID}) AS leaseCount
          FROM agent_jobs
          WHERE workspace_id = ${WORKSPACE_ID} AND job_id = ${JOB_ID}`
        assert.deepStrictEqual(durableState, [{ state: "queued", attemptCount: 0, leaseCount: 0 }])
      })
    ))
})
