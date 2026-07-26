import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { AgentContextFingerprint, AgentProviderId } from "@knpkv/ai-runtime"
import { DateTime, Effect, Layer, Option, Result, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { type ReviewAgentProfile, ReviewAgentProfileId } from "../../src/api/agent.js"
import {
  GovernedActionId,
  JobId,
  ReleaseId,
  ReviewSuggestionPublicationReservationId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { MAXIMUM_PR_REVIEW_REPORT_BYTES, PrReviewReport, type PrReviewSubject } from "../../src/domain/prReview.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { PersistedRecordError, RecordNotFoundError } from "../../src/server/persistence/errors.js"
import {
  AgentEventCursor,
  AgentJobInputError,
  AgentLeaseOwner,
  AgentLeaseToken,
  AgentThreadEventPageSize,
  MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE,
  ReviewSuggestionPublicationDigest
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
const SECOND_LEASE_TOKEN = AgentLeaseToken.make("2".repeat(64))
const T0 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:00:00.000Z")
const T1 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:01:00.000Z")
const T2 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:02:00.000Z")
const T3 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:03:00.000Z")
const T4 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:12:00.000Z")
const T5 = Schema.decodeSync(UtcTimestamp)("2026-07-19T09:14:00.000Z")
const PUBLICATION_ID = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-000000000043")
const RESERVATION_ID = ReviewSuggestionPublicationReservationId.make(
  "01890f6f-6d6a-7cc0-98d2-000000000044"
)
const TAKEOVER_RESERVATION_ID = ReviewSuggestionPublicationReservationId.make(
  "01890f6f-6d6a-7cc0-98d2-000000000045"
)
const CONTENT_DIGEST = ReviewSuggestionPublicationDigest.make(`sha256:${"b".repeat(64)}`)
const ALTERNATE_CONTENT_DIGEST = ReviewSuggestionPublicationDigest.make(`sha256:${"c".repeat(64)}`)

const subject = {
  providerId: "codecommit",
  repository: "control-center",
  pullRequestId: "212",
  baseRevision: "1".repeat(40),
  headRevision: "2".repeat(40)
} satisfies PrReviewSubject
const reviewProfile: ReviewAgentProfile = {
  profileId: ReviewAgentProfileId.make("deterministic-review:deterministic-review-model:sbx"),
  label: "Deterministic full-project review",
  budgetMillis: 1_200_000,
  networkAccess: "blocked",
  sandbox: "sbx"
}

const swappedSubject = {
  ...subject,
  pullRequestId: "213",
  headRevision: "3".repeat(40)
} satisfies PrReviewSubject

const advancedSubject = {
  ...subject,
  baseRevision: subject.headRevision,
  headRevision: "4".repeat(40)
} satisfies PrReviewSubject

const report = Schema.decodeUnknownSync(PrReviewReport)({
  schemaVersion: 3,
  subject,
  completion: { status: "complete" },
  suggestions: [
    {
      suggestionId: `sha256:${"1".repeat(64)}`,
      state: "draft",
      title: "Decode review output before persistence",
      severity: "P2",
      problem: "Review output must cross a typed boundary.",
      impact: "Malformed model output could otherwise enter durable state.",
      evidence: {
        path: "packages/control-center/src/server/agent/AgentJobWorker.ts",
        startLine: 42,
        endLine: 45,
        excerpt: "const report = decodeReviewOutput(output)"
      },
      recommendation: "Decode the complete report before committing model-authored output.",
      anchor: {
        _tag: "line",
        path: "packages/control-center/src/server/agent/AgentJobWorker.ts",
        line: 42,
        relativeFileVersion: "AFTER"
      },
      relatedLocations: [],
      confidence: {
        level: "high",
        reason: "The persistence boundary is directly observable."
      },
      prevention: {
        summary: "Protect active-lease review completion.",
        enforcement: "test",
        existingRuleOrConfig: "agent job repository integration suite",
        recurrenceEvidence: "Every completion and retry reuses the active-lease transaction boundary.",
        targetFile: "packages/control-center/test/persistence/agent-job-review-results.test.ts",
        sourcePaths: ["packages/control-center/src/server/persistence/repositories/agentJobRepository.ts"],
        matcherOrInvariant: "A review result and terminal state commit under the same active lease.",
        invalidFixture: "completeReview({ leaseToken: staleLease })",
        validFixture: "completeReview({ leaseToken: activeLease })",
        boundary: "Only durable PR-review jobs are covered."
      }
    }
  ],
  notes: []
})

const nearLimitReport = (): PrReviewReport => {
  const suggestion = report.suggestions[0]!
  const suggestions = Array.from({ length: 4 }, (_, index) => ({
    ...suggestion,
    suggestionId: `sha256:${String(index + 1).repeat(64)}`,
    recommendation: "r".repeat(6_000)
  }))
  const candidate = {
    ...report,
    suggestions
  }
  const encoder = new TextEncoder()
  const projectedBytes = () =>
    encoder.encode(JSON.stringify({
      ...candidate,
      suggestions: suggestions.map((item) => ({ ...item, state: "published" }))
    })).byteLength
  let remaining = MAXIMUM_PR_REVIEW_REPORT_BYTES - 1 - projectedBytes()
  for (const item of suggestions) {
    const available = 8_000 - item.recommendation.length
    const added = Math.min(available, remaining)
    item.recommendation += "r".repeat(added)
    remaining -= added
  }
  assert.strictEqual(remaining, 0)
  assert.strictEqual(projectedBytes(), MAXIMUM_PR_REVIEW_REPORT_BYTES - 1)
  return Schema.decodeUnknownSync(PrReviewReport)(candidate)
}

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
      task: { _tag: "pr-review", subject: taskSubject, reviewProfile },
      createdAt: T0
    })
  })

const enqueueReview = enqueueReviewFor(JOB_ID, subject)

const claimReview = Effect.gen(function*() {
  const jobs = yield* AgentJobRepository
  yield* TestClock.setTime(DateTime.toEpochMillis(T1))
  const claimed = yield* jobs.claimNext({
    workspaceId: WORKSPACE_ID,
    taskTags: ["pr-review"],
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
  it.effect("keeps one PR thread across heads and freezes bounded prior-run context", () =>
    withRepository(
      Effect.gen(function*() {
        const database = yield* Database
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const firstClaim = yield* claimReview
        yield* jobs.completeReview({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: firstClaim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          report,
          completedAt: T2
        })

        yield* enqueueReviewFor(SWAP_JOB_ID, advancedSubject)
        const threadRows = yield* database.sql<{
          readonly jobId: string
          readonly threadId: string
        }>`SELECT job_id AS jobId, thread_id AS threadId
          FROM agent_jobs
          WHERE workspace_id = ${WORKSPACE_ID}
          ORDER BY job_id`
        assert.strictEqual(threadRows.length, 2)
        assert.strictEqual(threadRows[0]?.threadId, threadRows[1]?.threadId)

        yield* TestClock.setTime(DateTime.toEpochMillis(T3))
        const secondClaim = yield* jobs.claimNext({
          workspaceId: WORKSPACE_ID,
          taskTags: ["pr-review"],
          leaseOwner: LEASE_OWNER,
          leaseToken: SECOND_LEASE_TOKEN,
          claimedAt: T3,
          leaseExpiresAt: T4
        })
        assert.isTrue(Option.isSome(secondClaim))
        if (Option.isNone(secondClaim)) return yield* Effect.die("advanced review claim missing")
        assert.strictEqual(secondClaim.value.context.task._tag, "pr-review")
        if (secondClaim.value.context.task._tag !== "pr-review") {
          return yield* Effect.die("advanced claim task mismatch")
        }
        assert.deepStrictEqual(secondClaim.value.context.task.context.recentRequests, [{
          jobId: JOB_ID,
          prompt: "Review the immutable pull request.",
          subjectRevision: subject.headRevision,
          requestedAt: T0
        }])
        assert.deepStrictEqual(secondClaim.value.context.task.context.priorRuns, [{
          jobId: JOB_ID,
          subject,
          state: "succeeded",
          requestedAt: T0,
          suggestionTitles: ["Decode review output before persistence"],
          suggestionsTruncated: false,
          noteTitles: [],
          notesTruncated: false,
          limitation: null
        }])
        assert.isFalse(secondClaim.value.context.task.context.historyTruncated)

        const firstPage = yield* jobs.reviewThreadAfter({
          workspaceId: WORKSPACE_ID,
          subject,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        const advancedPage = yield* jobs.reviewThreadAfter({
          workspaceId: WORKSPACE_ID,
          subject: advancedSubject,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        assert.strictEqual(firstPage.events.length, advancedPage.events.length)
        assert.deepStrictEqual(
          advancedPage.events.map(({ jobId }) => jobId),
          [JOB_ID, JOB_ID, JOB_ID, JOB_ID, SWAP_JOB_ID, SWAP_JOB_ID]
        )
      })
    ))

  it.effect("projects a published suggestion after a durable reload", () =>
    withRepository(
      Effect.gen(function*() {
        const database = yield* Database
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const claim = yield* claimReview
        yield* jobs.completeReview({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: claim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          report,
          completedAt: T2
        })
        const suggestionId = report.suggestions[0]?.suggestionId
        if (suggestionId === undefined) return yield* Effect.die("review suggestion missing")

        yield* jobs.reserveReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          reservedAt: T3
        })
        yield* jobs.recordReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          publicationId: PUBLICATION_ID,
          publishedAt: T3
        })
        const duplicateEvent = yield* database.sql`INSERT INTO agent_thread_events (
          workspace_id, thread_id, event_sequence, job_id, attempt_sequence,
          event_kind, payload_json, payload_digest, payload_byte_length, occurred_at
        )
        SELECT
          workspace_id, thread_id, event_sequence + 1000, job_id, attempt_sequence,
          event_kind, payload_json, payload_digest, payload_byte_length, occurred_at
        FROM agent_thread_events
        WHERE workspace_id = ${WORKSPACE_ID}
          AND job_id = ${JOB_ID}
          AND event_kind = 'review-suggestion-published'`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(duplicateEvent))
        yield* jobs.recordReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          publicationId: PUBLICATION_ID,
          publishedAt: T3
        })

        const reloaded = yield* jobs.reviewResult({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID
        })
        assert.strictEqual(reloaded.report.suggestions[0]?.state, "published")

        const latest = yield* jobs.latestReview({
          workspaceId: WORKSPACE_ID,
          subject
        })
        assert.isTrue(Option.isSome(latest))
        if (Option.isSome(latest)) {
          assert.strictEqual(latest.value.report?.suggestions[0]?.state, "published")
        }

        const page = yield* jobs.reviewThreadAfter({
          workspaceId: WORKSPACE_ID,
          subject,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        assert.strictEqual(
          page.events.filter(({ eventKind }) => eventKind === "review-suggestion-published").length,
          1
        )
      })
    ))

  it.effect("reserves aggregate bytes for the longest lifecycle projection", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const claim = yield* claimReview
        const bounded = nearLimitReport()
        const tooLarge = {
          ...bounded,
          suggestions: bounded.suggestions.map((suggestion, index) =>
            index === 0
              ? { ...suggestion, title: `${suggestion.title}xx` }
              : suggestion
          )
        }
        assert.isFalse(Schema.is(PrReviewReport)(tooLarge))

        yield* jobs.completeReview({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: claim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          report: bounded,
          completedAt: T2
        })
        const suggestionId = bounded.suggestions[0]?.suggestionId
        if (suggestionId === undefined) return yield* Effect.die("review suggestion missing")
        yield* jobs.reserveReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          reservedAt: T3
        })
        yield* jobs.recordReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          publicationId: PUBLICATION_ID,
          publishedAt: T3
        })

        const reloaded = yield* jobs.reviewResult({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID
        })
        assert.strictEqual(reloaded.report.suggestions[0]?.state, "published")
      })
    ))

  it.effect("atomically reserves one body and idempotently records one publication", () =>
    withRepository(
      Effect.gen(function*() {
        const database = yield* Database
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const claim = yield* claimReview
        yield* jobs.completeReview({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: claim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          report,
          completedAt: T2
        })
        const suggestionId = report.suggestions[0]?.suggestionId
        if (suggestionId === undefined) return yield* Effect.die("review suggestion missing")
        const reserve = (contentDigest: typeof ReviewSuggestionPublicationDigest.Type) =>
          jobs.reserveReviewSuggestionPublication({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            suggestionId,
            contentDigest,
            reservationId: RESERVATION_ID,
            reservedAt: T3
          })
        const reservations = yield* Effect.all([
          reserve(CONTENT_DIGEST).pipe(Effect.result),
          reserve(ALTERNATE_CONTENT_DIGEST).pipe(Effect.result)
        ], { concurrency: "unbounded" })
        assert.strictEqual(
          reservations.filter(Result.isSuccess).length,
          1
        )
        const rows = yield* database.sql<{ readonly contentDigest: string }>`SELECT
          content_digest AS contentDigest
          FROM agent_review_suggestion_publications
          WHERE workspace_id = ${WORKSPACE_ID}
            AND job_id = ${JOB_ID}
            AND suggestion_id = ${suggestionId}`
        assert.strictEqual(rows.length, 1)
        const winningDigest = Schema.decodeUnknownSync(ReviewSuggestionPublicationDigest)(
          rows[0]?.contentDigest
        )
        yield* jobs.releaseReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          contentDigest: winningDigest,
          reservationId: RESERVATION_ID
        })
        const retryDigest = winningDigest === CONTENT_DIGEST
          ? ALTERNATE_CONTENT_DIGEST
          : CONTENT_DIGEST
        yield* reserve(retryDigest)
        const record = () =>
          jobs.recordReviewSuggestionPublication({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            suggestionId,
            contentDigest: retryDigest,
            reservationId: RESERVATION_ID,
            publicationId: PUBLICATION_ID,
            publishedAt: T3
          })
        const recordings = yield* Effect.all([
          record().pipe(Effect.result),
          record().pipe(Effect.result)
        ], { concurrency: "unbounded" })
        assert.isTrue(recordings.every(Result.isSuccess))
        const replay = yield* reserve(retryDigest)
        assert.deepStrictEqual(replay, {
          _tag: "published",
          publicationId: PUBLICATION_ID,
          publishedAt: T3
        })

        const page = yield* jobs.reviewThreadAfter({
          workspaceId: WORKSPACE_ID,
          subject,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        assert.strictEqual(
          page.events.filter(({ eventKind }) => eventKind === "review-suggestion-published").length,
          1
        )
      })
    ))

  it.effect("keeps a live publication reservation exclusive and recovers it after expiry", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const claim = yield* claimReview
        yield* jobs.completeReview({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: claim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          report,
          completedAt: T2
        })
        const suggestionId = report.suggestions[0]?.suggestionId
        if (suggestionId === undefined) return yield* Effect.die("review suggestion missing")
        const reserveAt = (reservedAt: typeof UtcTimestamp.Type) =>
          jobs.reserveReviewSuggestionPublication({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            suggestionId,
            contentDigest: CONTENT_DIGEST,
            reservationId: reservedAt === T5 ? TAKEOVER_RESERVATION_ID : RESERVATION_ID,
            reservedAt
          })

        assert.deepStrictEqual(yield* reserveAt(T3), { _tag: "acquired" })
        assert.deepStrictEqual(yield* reserveAt(T4), { _tag: "in-progress" })
        assert.deepStrictEqual(yield* reserveAt(T5), { _tag: "acquired" })
        const staleOwner = yield* jobs.recordReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          publicationId: PUBLICATION_ID,
          publishedAt: T3,
          finalize: false
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(staleOwner))
        yield* jobs.recordReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: TAKEOVER_RESERVATION_ID,
          publicationId: PUBLICATION_ID,
          publishedAt: T3,
          finalize: false
        })
      })
    ))

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

        const latest = yield* jobs.latestReview({
          workspaceId: WORKSPACE_ID,
          subject
        })
        assert.isTrue(Option.isSome(latest))
        if (Option.isSome(latest)) {
          assert.strictEqual(latest.value.jobId, JOB_ID)
          assert.strictEqual(latest.value.state, "succeeded")
          assert.deepStrictEqual(latest.value.report, report)
        }

        const page = yield* jobs.reviewThreadAfter({
          workspaceId: WORKSPACE_ID,
          subject,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        assert.deepStrictEqual(
          page.events.map(({ eventKind, task }) => ({ eventKind, task })),
          [
            { eventKind: "user-message", task: { _tag: "pr-review", subject, reviewProfile } },
            { eventKind: "job-queued", task: { _tag: "pr-review", subject, reviewProfile } },
            { eventKind: "review-report", task: { _tag: "pr-review", subject, reviewProfile } },
            { eventKind: "job-completed", task: { _tag: "pr-review", subject, reviewProfile } }
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
          suggestions: [{
            ...report.suggestions[0]!,
            evidence: {
              ...report.suggestions[0]!.evidence,
              path: "../host-secret"
            }
          }]
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

  it.effect("projects the newest bounded review activity in chronological order", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const claim = yield* claimReview
        for (
          let index = 1;
          index <= MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE + 2;
          index += 1
        ) {
          yield* jobs.appendEvent({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            attemptSequence: claim.attemptSequence,
            leaseToken: LEASE_TOKEN,
            event: {
              _tag: "output",
              channel: "progress",
              text: `progress-${String(index)}`
            },
            occurredAt: T2
          })
        }

        const latest = yield* jobs.latestReview({
          workspaceId: WORKSPACE_ID,
          subject
        })
        assert.isTrue(Option.isSome(latest))
        if (Option.isSome(latest)) {
          assert.isTrue(latest.value.activity.truncated)
          assert.strictEqual(
            latest.value.activity.events.length,
            MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE
          )
          assert.strictEqual(latest.value.activity.events[0], "progress-3")
          assert.strictEqual(
            latest.value.activity.events.at(-1),
            `progress-${String(MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE + 2)}`
          )
        }
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
          suggestions: []
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
        assert.isTrue(
          persisted.report.suggestions.length === report.suggestions.length ||
            persisted.report.suggestions.length === alternate.suggestions.length
        )
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
            taskTags: ["release-chat", "pr-review"],
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
