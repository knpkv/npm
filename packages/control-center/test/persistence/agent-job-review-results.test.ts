import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { AgentContextFingerprint, AgentProviderId, MAXIMUM_AGENT_RUNTIME_EVENT_BYTES } from "@knpkv/ai-runtime"
import { DateTime, Effect, Layer, Option, Result, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"

import {
  MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH,
  type ReviewAgentProfile,
  ReviewAgentProfileId
} from "../../src/api/agent.js"
import {
  AgentThreadId,
  GovernedActionId,
  JobId,
  PersonId,
  PluginConnectionId,
  PrReviewSuggestionRevisionId,
  ReleaseId,
  ReviewSuggestionPublicationReservationId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { MAXIMUM_PR_REVIEW_REPORT_BYTES, PrReviewReport, PrReviewSubject } from "../../src/domain/prReview.js"
import {
  MAXIMUM_PR_REVIEW_SUGGESTION_REVISION_BYTES,
  PrReviewSuggestionAgentAuthor,
  PrReviewSuggestionEdit,
  PrReviewSuggestionOperatorAuthor,
  PrReviewSuggestionRevisionPageSize
} from "../../src/domain/prReviewRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  PrReviewThreadHistory,
  prReviewThreadHistoryLayer
} from "../../src/server/agent/internal/PrReviewThreadHistory.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  PersistedRecordError,
  RecordNotFoundError,
  RevisionConflictError
} from "../../src/server/persistence/errors.js"
import {
  AgentAttemptSequence,
  AgentEventCursor,
  AgentJobInputError,
  AgentLeaseOwner,
  AgentLeaseToken,
  AgentThreadEventPageSize,
  EMPTY_PR_REVIEW_THREAD_CONTEXT,
  MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE,
  ReviewSuggestionPublicationDigest
} from "../../src/server/persistence/repositories/agentJobModels.js"
import { AgentJobRepository } from "../../src/server/persistence/repositories/agentJobRepository.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000021")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000031")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000041")
const PERSON_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000047")
const PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000046")
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

const denseContextReport = (taskSubject: PrReviewSubject): PrReviewReport => {
  const suggestion = report.suggestions[0]!
  return Schema.decodeUnknownSync(PrReviewReport)({
    ...report,
    subject: taskSubject,
    suggestions: Array.from({ length: 8 }, (_, index) => ({
      ...suggestion,
      suggestionId: `sha256:${String(index + 1).repeat(64)}`,
      title: `${String(index)}${"s".repeat(499)}`
    })),
    notes: Array.from({ length: 8 }, (_, index) => ({
      noteId: `sha256:${String(index + 1).repeat(64)}`,
      reason: "pre-existing",
      title: `${String(index)}${"n".repeat(499)}`,
      observation: "This issue predates the reviewed pull request.",
      confidence: {
        level: "medium",
        reason: "The base revision contains the same behavior."
      }
    }))
  })
}

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

const enqueueReviewFor = (
  jobId: typeof JobId.Type,
  taskSubject: PrReviewSubject,
  prompt = "Review the immutable pull request."
) =>
  Effect.gen(function*() {
    const jobs = yield* AgentJobRepository
    yield* jobs.enqueue({
      workspaceId: WORKSPACE_ID,
      releaseId: RELEASE_ID,
      jobId,
      providerId: PROVIDER_ID,
      model: "deterministic-review-model",
      access: "read-only",
      userPrompt: prompt,
      prompt,
      contextFingerprint: FINGERPRINT,
      subjectRevision: taskSubject.headRevision,
      task: {
        _tag: "pr-review",
        pluginConnectionId: PLUGIN_CONNECTION_ID,
        subject: taskSubject,
        reviewProfile
      },
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

const completeReview = Effect.gen(function*() {
  const jobs = yield* AgentJobRepository
  const claim = yield* claimReview
  return yield* jobs.completeReview({
    workspaceId: WORKSPACE_ID,
    jobId: JOB_ID,
    attemptSequence: claim.attemptSequence,
    leaseToken: LEASE_TOKEN,
    report,
    completedAt: T2
  })
})

const incompleteReport = Schema.decodeUnknownSync(PrReviewReport)({
  ...report,
  completion: {
    status: "unable-to-conclude",
    reason: "The review stopped before the complete project was examined."
  },
  suggestions: [],
  notes: []
})

const currentSuggestionRevision = (suggestionId: typeof report.suggestions[number]["suggestionId"]) =>
  Effect.gen(function*() {
    const jobs = yield* AgentJobRepository
    return (yield* jobs.reviewSuggestionRevisions({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      suggestionId,
      beforeSequence: null,
      limit: PrReviewSuggestionRevisionPageSize.make(1)
    })).current
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

const withRepository = <Success, Failure>(use: Effect.Effect<Success, Failure, AgentJobRepository | Database>) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-agent-review-result-")
    return yield* withRepositoryConfig(config, use)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("agent job review results", () => {
  it.effect("persists one budget extension and exposes the effective value to the claim", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const claim = yield* claimReview

        const extended = yield* jobs.extendReviewBudget({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          extendedAt: T2
        })
        assert.deepStrictEqual(extended, {
          reviewBudgetMillis: 2_400_000,
          reviewBudgetExtensionCount: 1
        })
        assert.deepStrictEqual(
          yield* jobs.reviewBudget({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            task: claim.context.task
          }),
          extended
        )

        const secondExtension = yield* jobs.extendReviewBudget({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          extendedAt: T3
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(secondExtension))
        if (Result.isFailure(secondExtension)) {
          assert.isTrue(Schema.is(AgentJobInputError)(secondExtension.failure))
        }
      })
    ))

  it.effect("keeps the newest validated partial report across multiple progress checkpoints", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const claim = yield* claimReview

        yield* jobs.recordReviewProgress({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: claim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          report: incompleteReport,
          occurredAt: T1
        })
        yield* jobs.recordReviewProgress({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: claim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          report,
          occurredAt: T2
        })

        const persisted = yield* jobs.reviewResult({ workspaceId: WORKSPACE_ID, jobId: JOB_ID })
        assert.deepStrictEqual(persisted.report, report)
      })
    ))

  it.effect("projects the immutable report suggestion as validated revision one", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview

        const page = yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: report.suggestions[0]!.suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(10)
        })

        assert.strictEqual(page.current.sequence, 1)
        assert.isNull(page.current.predecessorRevisionId)
        assert.strictEqual(page.current.author._tag, "agent")
        assert.strictEqual(page.current.validation._tag, "validated")
        assert.deepStrictEqual(page.revisions, [])
        assert.isFalse(page.hasMore)
      })
    ))

  it.effect("records dismissal as an immutable operator revision and blocks later edits", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview
        const suggestion = report.suggestions[0]!
        const original = yield* currentSuggestionRevision(suggestion.suggestionId)
        const edit = Schema.decodeUnknownSync(PrReviewSuggestionEdit)(suggestion)

        const dismissed = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: original.revisionId,
          expectedSequence: original.sequence,
          edit,
          state: "dismissed",
          author: PrReviewSuggestionOperatorAuthor.make({
            personId: PERSON_ID
          }),
          createdAt: T3
        })

        assert.strictEqual(dismissed.sequence, 2)
        assert.strictEqual(dismissed.suggestion.state, "dismissed")
        assert.strictEqual(dismissed.author._tag, "operator")
        const reloaded = yield* currentSuggestionRevision(suggestion.suggestionId)
        assert.strictEqual(reloaded.revisionId, dismissed.revisionId)
        assert.strictEqual(reloaded.suggestion.state, "dismissed")
        const projectedReport = yield* jobs.reviewResult({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID
        })
        assert.strictEqual(
          projectedReport.report.suggestions[0]?.state,
          "dismissed"
        )

        const laterEdit = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: dismissed.revisionId,
          expectedSequence: dismissed.sequence,
          edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
            ...suggestion,
            title: "This edit must remain blocked"
          }),
          author: PrReviewSuggestionOperatorAuthor.make({
            personId: PERSON_ID
          }),
          createdAt: T4
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(laterEdit))
        if (Result.isFailure(laterEdit)) {
          assert.instanceOf(laterEdit.failure, AgentJobInputError)
          assert.strictEqual(laterEdit.failure.reason, "invalid-transition")
        }

        const thread = yield* jobs.reviewThreadTail({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          subject,
          limit: AgentThreadEventPageSize.make(128)
        })
        const dismissalEvent = thread.events.find(
          ({ eventKind }) => eventKind === "review-suggestion-revised"
        )
        assert.deepInclude(dismissalEvent?.payload, {
          suggestionId: suggestion.suggestionId,
          suggestionState: "dismissed"
        })
      })
    ))

  it.effect("appends edits immutably and pages prior revisions newest first", () =>
    withRepository(
      Effect.gen(function*() {
        const database = yield* Database
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview
        const suggestion = report.suggestions[0]!
        const original = (yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(10)
        })).current
        const author = PrReviewSuggestionOperatorAuthor.make({
          personId: PERSON_ID
        })
        const titleEdit = Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
          ...suggestion,
          title: "Decode every review result before persistence"
        })
        const renamed = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: original.revisionId,
          expectedSequence: original.sequence,
          edit: titleEdit,
          author,
          createdAt: T3
        })
        assert.strictEqual(renamed.sequence, 2)
        assert.strictEqual(renamed.validation._tag, "validated")

        const noOp = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: renamed.revisionId,
          expectedSequence: renamed.sequence,
          edit: titleEdit,
          author,
          createdAt: T4
        })
        assert.strictEqual(noOp.revisionId, renamed.revisionId)

        const technicalEdit = Schema.decodeUnknownSync(
          PrReviewSuggestionEdit
        )({
          ...titleEdit,
          problem: "Untrusted agent output can reach durable state."
        })
        const technical = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: renamed.revisionId,
          expectedSequence: renamed.sequence,
          edit: technicalEdit,
          author,
          createdAt: T4
        })
        assert.strictEqual(technical.sequence, 3)
        assert.strictEqual(
          technical.validation._tag,
          "requires-revalidation"
        )

        const humanValidationAttempt = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: technical.revisionId,
          expectedSequence: technical.sequence,
          edit: technicalEdit,
          validation: "validated",
          author,
          createdAt: T4
        })
        assert.strictEqual(humanValidationAttempt.sequence, 4)
        assert.strictEqual(humanValidationAttempt.validation._tag, "requires-revalidation")

        const revalidated = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: humanValidationAttempt.revisionId,
          expectedSequence: humanValidationAttempt.sequence,
          edit: technicalEdit,
          validation: "validated",
          author: PrReviewSuggestionAgentAuthor.make({
            jobId: JOB_ID,
            providerId: PROVIDER_ID,
            model: "test-model",
            runtimeMetadata: null
          }),
          createdAt: T4
        })
        assert.strictEqual(revalidated.sequence, 5)
        assert.strictEqual(revalidated.validation._tag, "validated")
        if (revalidated.validation._tag !== "validated") {
          return yield* Effect.die("expected agent revalidation metadata")
        }
        assert.strictEqual(revalidated.validation.validatingJobId, JOB_ID)
        assert.strictEqual(revalidated.validation.sourceRevisionId, humanValidationAttempt.revisionId)
        assert.strictEqual(revalidated.validation.reviewedHead, technical.subject.headRevision)

        const firstPage = yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(1)
        })
        assert.strictEqual(firstPage.current.revisionId, revalidated.revisionId)
        assert.deepStrictEqual(
          firstPage.revisions.map(({ sequence }) => sequence),
          [4]
        )
        assert.isTrue(firstPage.hasMore)
        assert.strictEqual(firstPage.nextBeforeSequence, 4)

        const secondPage = yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: firstPage.nextBeforeSequence,
          limit: PrReviewSuggestionRevisionPageSize.make(1)
        })
        assert.deepStrictEqual(
          secondPage.revisions.map(({ sequence }) => sequence),
          [3]
        )
        assert.isTrue(secondPage.hasMore)

        const thirdPage = yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: secondPage.nextBeforeSequence,
          limit: PrReviewSuggestionRevisionPageSize.make(1)
        })
        assert.deepStrictEqual(thirdPage.revisions.map(({ sequence }) => sequence), [2])
        assert.isTrue(thirdPage.hasMore)

        const fourthPage = yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: thirdPage.nextBeforeSequence,
          limit: PrReviewSuggestionRevisionPageSize.make(1)
        })
        assert.deepStrictEqual(fourthPage.revisions.map(({ sequence }) => sequence), [1])
        assert.isFalse(fourthPage.hasMore)

        const thread = yield* jobs.reviewThreadTail({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          subject,
          limit: AgentThreadEventPageSize.make(128)
        })
        assert.strictEqual(
          thread.events.filter(
            ({ eventKind }) => eventKind === "review-suggestion-revised"
          ).length,
          4
        )

        const update = yield* database.sql`UPDATE agent_review_suggestion_revisions
          SET revision_digest = ${`sha256:${"f".repeat(64)}`}
          WHERE workspace_id = ${WORKSPACE_ID}
            AND source_job_id = ${JOB_ID}`.pipe(Effect.result)
        const deletion = yield* database.sql`DELETE FROM agent_review_suggestion_revisions
          WHERE workspace_id = ${WORKSPACE_ID}
            AND source_job_id = ${JOB_ID}`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(update))
        assert.isTrue(Result.isFailure(deletion))
      })
    ))

  it.effect("rolls back targeted completion when the source revision is stale", () =>
    withRepository(
      Effect.gen(function*() {
        const database = yield* Database
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview
        const suggestion = report.suggestions[0]!
        const original = (yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(10)
        })).current
        const targetPage = yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(10)
        })
        const operator = PrReviewSuggestionOperatorAuthor.make({ personId: PERSON_ID })
        const edited = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: original.revisionId,
          expectedSequence: original.sequence,
          edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
            ...suggestion,
            title: "The source changed while the agent was running"
          }),
          author: operator,
          createdAt: T3
        })
        const targetJobId = SWAP_JOB_ID
        yield* jobs.enqueue({
          workspaceId: WORKSPACE_ID,
          releaseId: RELEASE_ID,
          jobId: targetJobId,
          providerId: PROVIDER_ID,
          model: "deterministic-review-model",
          access: "read-only",
          userPrompt: "Revalidate the selected suggestion.",
          prompt: "Revalidate the selected suggestion.",
          contextFingerprint: FINGERPRINT,
          subjectRevision: subject.headRevision,
          task: {
            _tag: "pr-review",
            pluginConnectionId: PLUGIN_CONNECTION_ID,
            subject,
            reviewProfile,
            intent: "suggestion-revalidation",
            target: {
              sourceJobId: JOB_ID,
              suggestionId: suggestion.suggestionId,
              selectedRevisionId: original.revisionId,
              history: targetPage
            }
          },
          createdAt: T3
        })
        yield* TestClock.setTime(DateTime.toEpochMillis(T4))
        const claimed = yield* jobs.claimNext({
          workspaceId: WORKSPACE_ID,
          taskTags: ["pr-review"],
          leaseOwner: LEASE_OWNER,
          leaseToken: SECOND_LEASE_TOKEN,
          claimedAt: T4,
          leaseExpiresAt: T5
        })
        if (Option.isNone(claimed)) return yield* Effect.die("targeted claim missing")
        const result = yield* jobs.completeTargetedReview({
          source: {
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            suggestionId: suggestion.suggestionId,
            expectedRevisionId: original.revisionId,
            expectedSequence: original.sequence,
            edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)(edited.suggestion),
            validation: "validated",
            author: PrReviewSuggestionAgentAuthor.make({
              jobId: targetJobId,
              providerId: PROVIDER_ID,
              model: "deterministic-review-model",
              runtimeMetadata: null
            }),
            createdAt: T4,
            leaseFence: {
              jobId: targetJobId,
              attemptSequence: claimed.value.attemptSequence,
              leaseToken: SECOND_LEASE_TOKEN
            }
          },
          target: {
            workspaceId: WORKSPACE_ID,
            jobId: targetJobId,
            attemptSequence: claimed.value.attemptSequence,
            leaseToken: SECOND_LEASE_TOKEN,
            report,
            completedAt: T4
          }
        }).pipe(Effect.result)
        if (Result.isSuccess(result)) return yield* Effect.die("expected stale targeted completion")
        if (!Schema.is(RevisionConflictError)(result.failure)) {
          return yield* Effect.die("expected stale targeted completion")
        }
        assert.strictEqual(
          (yield* jobs.reviewSuggestionRevisions({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            suggestionId: suggestion.suggestionId,
            beforeSequence: null,
            limit: PrReviewSuggestionRevisionPageSize.make(1)
          })).current.sequence,
          edited.sequence
        )
        const targetState = yield* database.sql`SELECT state, terminal_at AS terminalAt
          FROM agent_jobs WHERE workspace_id = ${WORKSPACE_ID} AND job_id = ${targetJobId}`
        assert.deepStrictEqual(targetState, [{ state: "running", terminalAt: null }])
      })
    ))

  it.effect("allows an agent validation to correct the technical claim", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview
        const suggestion = report.suggestions[0]!
        const original = (yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(10)
        })).current
        const operator = PrReviewSuggestionOperatorAuthor.make({ personId: PERSON_ID })
        const technicalEdit = Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
          ...suggestion,
          problem: "The first technical claim was incomplete."
        })
        const edited = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: original.revisionId,
          expectedSequence: original.sequence,
          edit: technicalEdit,
          author: operator,
          createdAt: T3
        })
        const humanValidation = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: edited.revisionId,
          expectedSequence: edited.sequence,
          edit: technicalEdit,
          validation: "validated",
          author: operator,
          createdAt: T4
        })
        const corrected = Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
          ...technicalEdit,
          problem: "The corrected technical claim is now complete."
        })
        const agentValidation = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: humanValidation.revisionId,
          expectedSequence: humanValidation.sequence,
          edit: corrected,
          validation: "validated",
          author: PrReviewSuggestionAgentAuthor.make({
            jobId: JOB_ID,
            providerId: PROVIDER_ID,
            model: "test-model",
            runtimeMetadata: null
          }),
          createdAt: T4
        })
        assert.strictEqual(agentValidation.validation._tag, "validated")
        assert.strictEqual(agentValidation.suggestion.problem, corrected.problem)
        if (agentValidation.validation._tag !== "validated") {
          return yield* Effect.die("expected corrected agent validation metadata")
        }
        assert.strictEqual(agentValidation.validation.sourceRevisionId, humanValidation.revisionId)
      })
    ))

  it.effect("rejects a mismatched expected revision identity without appending", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview
        const suggestion = report.suggestions[0]!
        const original = (yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(1)
        })).current

        const result = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: PrReviewSuggestionRevisionId.make(`sha256:${"f".repeat(64)}`),
          expectedSequence: original.sequence,
          edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
            ...suggestion,
            title: "This edit must not be persisted"
          }),
          author: PrReviewSuggestionOperatorAuthor.make({
            personId: PERSON_ID
          }),
          createdAt: T3
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, AgentJobInputError)
          assert.strictEqual(result.failure.reason, "revision-identity-mismatch")
        }
        const unchanged = yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(10)
        })
        assert.strictEqual(unchanged.current.revisionId, original.revisionId)
        assert.deepStrictEqual(unchanged.revisions, [])
      })
    ))

  it.effect("rejects an invalid suggestion transition as a typed input error", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview
        const suggestion = report.suggestions[0]!
        const original = yield* currentSuggestionRevision(
          suggestion.suggestionId
        )
        const result = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: original.revisionId,
          expectedSequence: original.sequence,
          edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
            ...suggestion,
            replacement: {
              reviewedHead: "3".repeat(40),
              unifiedDiff: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
              explanation: "Targets a different head."
            }
          }),
          author: PrReviewSuggestionOperatorAuthor.make({
            personId: PERSON_ID
          }),
          createdAt: T3
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, AgentJobInputError)
          assert.strictEqual(result.failure.reason, "invalid-transition")
        }
      })
    ))

  it.effect("rejects an oversized revision as a typed input error", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview
        const suggestion = report.suggestions[0]!
        const original = yield* currentSuggestionRevision(
          suggestion.suggestionId
        )
        const path = (index: number) => `${String(index).padStart(2, "0")}/${"x".repeat(1_000)}`
        const oversizedEdit = Schema.decodeUnknownSync(
          PrReviewSuggestionEdit
        )({
          ...suggestion,
          relatedLocations: Array.from({ length: 32 }, (_, index) => ({
            path: path(index + 40),
            startLine: index + 1,
            endLine: index + 1,
            label: "l".repeat(500)
          })),
          prevention: {
            summary: "Bound the complete revision before persistence.",
            enforcement: "test",
            existingRuleOrConfig: "agent job repository integration suite",
            recurrenceEvidence: "r".repeat(2_000),
            targetFile: path(99),
            sourcePaths: Array.from({ length: 32 }, (_, index) => path(index)),
            matcherOrInvariant: "m".repeat(4_000),
            invalidFixture: "i".repeat(8_000),
            validFixture: "v".repeat(8_000),
            boundary: "b".repeat(4_000)
          }
        })
        assert.isAbove(
          new TextEncoder().encode(JSON.stringify(oversizedEdit)).byteLength,
          MAXIMUM_PR_REVIEW_SUGGESTION_REVISION_BYTES
        )

        const result = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: original.revisionId,
          expectedSequence: original.sequence,
          edit: oversizedEdit,
          author: PrReviewSuggestionOperatorAuthor.make({
            personId: PERSON_ID
          }),
          createdAt: T3
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, AgentJobInputError)
          assert.strictEqual(
            result.failure.reason,
            "output-limit-exceeded"
          )
        }
        const unchanged = yield* currentSuggestionRevision(
          suggestion.suggestionId
        )
        assert.strictEqual(unchanged.revisionId, original.revisionId)
      })
    ))

  it.effect("keeps appended suggestion revisions durable across database restart", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-review-revision-restart-")
      const persisted = yield* withRepositoryConfig(
        config,
        Effect.gen(function*() {
          const jobs = yield* AgentJobRepository
          yield* setupFoundation
          yield* enqueueReview
          yield* completeReview
          const suggestion = report.suggestions[0]!
          const original = (yield* jobs.reviewSuggestionRevisions({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            suggestionId: suggestion.suggestionId,
            beforeSequence: null,
            limit: PrReviewSuggestionRevisionPageSize.make(1)
          })).current
          return yield* jobs.appendReviewSuggestionRevision({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            suggestionId: suggestion.suggestionId,
            expectedRevisionId: original.revisionId,
            expectedSequence: original.sequence,
            edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
              ...suggestion,
              title: "Durable edited suggestion"
            }),
            author: PrReviewSuggestionOperatorAuthor.make({
              personId: PERSON_ID
            }),
            createdAt: T3
          })
        })
      )

      yield* withRepositoryConfig(
        config,
        Effect.gen(function*() {
          const jobs = yield* AgentJobRepository
          const page = yield* jobs.reviewSuggestionRevisions({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            suggestionId: report.suggestions[0]!.suggestionId,
            beforeSequence: null,
            limit: PrReviewSuggestionRevisionPageSize.make(10)
          })
          assert.strictEqual(page.current.revisionId, persisted.revisionId)
          assert.strictEqual(page.current.suggestion.title, "Durable edited suggestion")
          assert.deepStrictEqual(page.revisions.map(({ sequence }) => sequence), [1])
        })
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("allows one winner for concurrent edits of the same revision", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview
        const suggestion = report.suggestions[0]!
        const original = (yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(1)
        })).current
        const author = PrReviewSuggestionOperatorAuthor.make({
          personId: PERSON_ID
        })
        const attempts = yield* Effect.all(
          ["First edit", "Second edit"].map((title) =>
            jobs.appendReviewSuggestionRevision({
              workspaceId: WORKSPACE_ID,
              jobId: JOB_ID,
              suggestionId: suggestion.suggestionId,
              expectedRevisionId: original.revisionId,
              expectedSequence: original.sequence,
              edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
                ...suggestion,
                title
              }),
              author,
              createdAt: T3
            }).pipe(Effect.result)
          ),
          { concurrency: "unbounded" }
        )

        assert.strictEqual(attempts.filter(Result.isSuccess).length, 1)
        const failure = attempts.find(Result.isFailure)
        assert.isDefined(failure)
        if (failure !== undefined && Result.isFailure(failure)) {
          assert.instanceOf(failure.failure, RevisionConflictError)
        }
        const page = yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(10)
        })
        assert.strictEqual(page.current.sequence, 2)
        assert.deepStrictEqual(
          page.revisions.map(({ sequence }) => sequence),
          [1]
        )
      })
    ))

  it.effect("freezes a terminal queued cancellation as cancelled review context", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* jobs.requestCancellation({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          requestedAt: T1
        })

        yield* enqueueReviewFor(SWAP_JOB_ID, advancedSubject)
        yield* TestClock.setTime(DateTime.toEpochMillis(T2))
        const next = yield* jobs.claimNext({
          workspaceId: WORKSPACE_ID,
          taskTags: ["pr-review"],
          leaseOwner: LEASE_OWNER,
          leaseToken: SECOND_LEASE_TOKEN,
          claimedAt: T2,
          leaseExpiresAt: T4
        })
        assert.isTrue(Option.isSome(next))
        if (Option.isNone(next)) return yield* Effect.die("follow-up review claim missing")
        assert.strictEqual(next.value.jobId, SWAP_JOB_ID)
        assert.strictEqual(next.value.context.task._tag, "pr-review")
        if (next.value.context.task._tag !== "pr-review") {
          return yield* Effect.die("follow-up review task mismatch")
        }
        assert.strictEqual(next.value.context.task.context.priorRuns[0]?.state, "cancelled")
      })
    ))

  it.effect("keeps a genuinely queued prior review unknown in frozen context", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* enqueueReviewFor(SWAP_JOB_ID, advancedSubject)
        yield* jobs.requestCancellation({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          requestedAt: T1
        })

        yield* TestClock.setTime(DateTime.toEpochMillis(T2))
        const next = yield* jobs.claimNext({
          workspaceId: WORKSPACE_ID,
          taskTags: ["pr-review"],
          leaseOwner: LEASE_OWNER,
          leaseToken: SECOND_LEASE_TOKEN,
          claimedAt: T2,
          leaseExpiresAt: T4
        })
        assert.isTrue(Option.isSome(next))
        if (Option.isNone(next)) return yield* Effect.die("queued follow-up review claim missing")
        assert.strictEqual(next.value.context.task._tag, "pr-review")
        if (next.value.context.task._tag !== "pr-review") {
          return yield* Effect.die("queued follow-up review task mismatch")
        }
        assert.strictEqual(next.value.context.task.context.priorRuns[0]?.state, "unknown")
      })
    ))

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
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          subject,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        const advancedPage = yield* jobs.reviewThreadAfter({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          subject: advancedSubject,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        assert.strictEqual(firstPage.events.length, advancedPage.events.length)
        assert.deepStrictEqual(
          advancedPage.events.map(({ jobId }) => jobId),
          [JOB_ID, JOB_ID, JOB_ID, JOB_ID, SWAP_JOB_ID, SWAP_JOB_ID]
        )
        const tail = yield* jobs.reviewThreadTail({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          subject,
          limit: AgentThreadEventPageSize.make(3)
        })
        assert.deepStrictEqual(
          tail.events.map(({ jobId }) => jobId),
          [JOB_ID, SWAP_JOB_ID, SWAP_JOB_ID]
        )
        assert.deepStrictEqual(
          tail.events.map(({ eventSequence }) => eventSequence),
          [
            AgentEventCursor.make(4),
            AgentEventCursor.make(5),
            AgentEventCursor.make(6)
          ]
        )
        assert.strictEqual(tail.nextCursor, AgentEventCursor.make(6))
        const earlier = yield* jobs.reviewThreadBefore({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          subject: advancedSubject,
          before: AgentEventCursor.make(5),
          limit: AgentThreadEventPageSize.make(2)
        })
        assert.deepStrictEqual(
          earlier.events.map(({ eventSequence }) => eventSequence),
          [AgentEventCursor.make(3), AgentEventCursor.make(4)]
        )
        assert.strictEqual(earlier.nextCursor, AgentEventCursor.make(3))
      })
    ))

  it.effect("trims limitation cutoffs before freezing follow-up context", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        const firstClaim = yield* claimReview
        const reason = `${"x".repeat(999)} tail`
        const limitedReport = Schema.decodeUnknownSync(PrReviewReport)({
          ...report,
          completion: { status: "unable-to-conclude", reason }
        })
        yield* jobs.completeReview({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          attemptSequence: firstClaim.attemptSequence,
          leaseToken: LEASE_TOKEN,
          report: limitedReport,
          completedAt: T2
        })

        yield* enqueueReviewFor(SWAP_JOB_ID, advancedSubject)
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
        if (Option.isNone(secondClaim)) return yield* Effect.die("follow-up review claim missing")
        assert.strictEqual(secondClaim.value.context.task._tag, "pr-review")
        if (secondClaim.value.context.task._tag !== "pr-review") {
          return yield* Effect.die("follow-up review task mismatch")
        }
        assert.strictEqual(
          secondClaim.value.context.task.context.priorRuns[0]?.limitation,
          "x".repeat(999)
        )
      })
    ))

  it.effect("fits maximum valid thread history into the durable event envelope", () =>
    withRepository(
      Effect.gen(function*() {
        const database = yield* Database
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        const jobIds = [
          JobId.make("01890f6f-6d6a-7cc0-98d2-000000000047"),
          JobId.make("01890f6f-6d6a-7cc0-98d2-000000000048"),
          JobId.make("01890f6f-6d6a-7cc0-98d2-000000000049"),
          JobId.make("01890f6f-6d6a-7cc0-98d2-00000000004a")
        ]
        for (const [index, jobId] of jobIds.entries()) {
          const runSubject = {
            ...subject,
            headRevision: String(index + 3).repeat(40)
          } satisfies PrReviewSubject
          yield* enqueueReviewFor(
            jobId,
            runSubject,
            "p".repeat(MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH)
          )
          yield* TestClock.setTime(DateTime.toEpochMillis(T1))
          const leaseToken = AgentLeaseToken.make(String(index + 3).repeat(64))
          const claimed = yield* jobs.claimNext({
            workspaceId: WORKSPACE_ID,
            taskTags: ["pr-review"],
            leaseOwner: LEASE_OWNER,
            leaseToken,
            claimedAt: T1,
            leaseExpiresAt: T4
          })
          assert.isTrue(Option.isSome(claimed))
          if (Option.isNone(claimed)) return yield* Effect.die("dense review claim missing")
          yield* jobs.completeReview({
            workspaceId: WORKSPACE_ID,
            jobId,
            attemptSequence: claimed.value.attemptSequence,
            leaseToken,
            report: denseContextReport(runSubject),
            completedAt: T2
          })
        }

        const followUpJobId = JobId.make("01890f6f-6d6a-7cc0-98d2-00000000004b")
        const followUpSubject = {
          ...subject,
          headRevision: "7".repeat(40)
        } satisfies PrReviewSubject
        yield* enqueueReviewFor(followUpJobId, followUpSubject, "Review the newest head.")
        yield* TestClock.setTime(DateTime.toEpochMillis(T3))
        const followUpClaim = yield* jobs.claimNext({
          workspaceId: WORKSPACE_ID,
          taskTags: ["pr-review"],
          leaseOwner: LEASE_OWNER,
          leaseToken: SECOND_LEASE_TOKEN,
          claimedAt: T3,
          leaseExpiresAt: T4
        })
        assert.isTrue(Option.isSome(followUpClaim))
        if (Option.isNone(followUpClaim)) return yield* Effect.die("bounded follow-up claim missing")
        assert.strictEqual(followUpClaim.value.context.task._tag, "pr-review")
        if (followUpClaim.value.context.task._tag !== "pr-review") {
          return yield* Effect.die("bounded follow-up task mismatch")
        }
        const context = followUpClaim.value.context.task.context
        assert.isTrue(context.historyTruncated)
        assert.strictEqual(context.recentRequests.length, 4)
        assert.isBelow(context.priorRuns.length, 4)

        const rows = yield* database.sql<{
          readonly contextBytes: number
          readonly taskBytes: number
          readonly queuedBytes: number
        }>`SELECT
          length(CAST(attempt.context_snapshot_json AS BLOB)) AS contextBytes,
          length(CAST(job.task_context_json AS BLOB)) AS taskBytes,
          event.payload_byte_length AS queuedBytes
        FROM agent_jobs job
        INNER JOIN agent_job_attempts attempt
          ON attempt.workspace_id = job.workspace_id
         AND attempt.job_id = job.job_id
         AND attempt.attempt_sequence = 1
        INNER JOIN agent_thread_events event
          ON event.workspace_id = job.workspace_id
         AND event.job_id = job.job_id
         AND event.event_kind = 'job-queued'
        WHERE job.workspace_id = ${WORKSPACE_ID}
          AND job.job_id = ${followUpJobId}`
        assert.strictEqual(rows.length, 1)
        assert.isAtMost(rows[0]!.contextBytes, MAXIMUM_AGENT_RUNTIME_EVENT_BYTES)
        assert.isAtMost(rows[0]!.taskBytes, MAXIMUM_AGENT_RUNTIME_EVENT_BYTES)
        assert.isAtMost(rows[0]!.queuedBytes, MAXIMUM_AGENT_RUNTIME_EVENT_BYTES)
      })
    ))

  it.effect("fences explicit history before the current run even for a fabricated cursor", () =>
    withRepository(
      Effect.gen(function*() {
        const database = yield* Database
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        const priorJobId = JobId.make("01890f6f-6d6a-7cc0-98d2-00000000005c")
        const currentJobId = JobId.make("01890f6f-6d6a-7cc0-98d2-00000000005d")
        const futureJobId = JobId.make("01890f6f-6d6a-7cc0-98d2-00000000005e")
        yield* enqueueReviewFor(priorJobId, subject, "Review the first head.")
        yield* enqueueReviewFor(currentJobId, advancedSubject, "Review the current head.")
        yield* enqueueReviewFor(
          futureJobId,
          { ...advancedSubject, headRevision: "5".repeat(40) },
          "Review the future head."
        )
        const rows = yield* database.sql<{ readonly threadId: string }>`SELECT
          thread_id AS threadId
        FROM agent_jobs
        WHERE workspace_id = ${WORKSPACE_ID}
          AND job_id = ${currentJobId}`
        assert.strictEqual(rows.length, 1)
        const threadId = AgentThreadId.make(rows[0]!.threadId)

        const history = yield* jobs.reviewThreadHistory({
          workspaceId: WORKSPACE_ID,
          threadId,
          beforeJobId: currentJobId,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE)
        })
        assert.strictEqual(history.events.length, 2)
        assert.isTrue(history.events.every(({ jobId }) => jobId === priorJobId))

        const fabricated = yield* jobs.reviewThreadHistory({
          workspaceId: WORKSPACE_ID,
          threadId,
          beforeJobId: currentJobId,
          after: AgentEventCursor.make(999),
          limit: AgentThreadEventPageSize.make(MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE)
        })
        assert.deepStrictEqual(fabricated.events, [])
        assert.strictEqual(fabricated.nextCursor, AgentEventCursor.make(999))
      })
    ))

  it.effect("packs more than 64 prior durable events into one model-visible history page", () =>
    withRepository(
      Effect.gen(function*() {
        const database = yield* Database
        yield* setupFoundation
        for (let index = 0; index < 33; index += 1) {
          yield* enqueueReviewFor(
            JobId.make(`01890f6f-6d6a-7cc0-98d2-${String(index + 100).padStart(12, "0")}`),
            subject,
            `Review request ${String(index + 1)}.`
          )
        }
        const currentJobId = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000200")
        yield* enqueueReviewFor(currentJobId, advancedSubject, "Review the current head.")
        const rows = yield* database.sql<{ readonly threadId: string }>`SELECT
          thread_id AS threadId
        FROM agent_jobs
        WHERE workspace_id = ${WORKSPACE_ID}
          AND job_id = ${currentJobId}`
        assert.strictEqual(rows.length, 1)
        const threadId = AgentThreadId.make(rows[0]!.threadId)
        const page = yield* Effect.gen(function*() {
          const history = yield* PrReviewThreadHistory
          return yield* history.page({
            after: AgentEventCursor.make(0),
            claim: {
              workspaceId: WORKSPACE_ID,
              releaseId: RELEASE_ID,
              threadId,
              jobId: currentJobId,
              attemptSequence: AgentAttemptSequence.make(1),
              leaseOwner: LEASE_OWNER,
              leaseToken: LEASE_TOKEN,
              leaseExpiresAt: T3,
              providerId: PROVIDER_ID,
              model: "deterministic-review-model",
              access: "read-only",
              prompt: "Review the current head.",
              context: {
                workspaceId: WORKSPACE_ID,
                releaseId: RELEASE_ID,
                subjectRevision: advancedSubject.headRevision,
                fingerprint: FINGERPRINT,
                task: {
                  _tag: "pr-review",
                  pluginConnectionId: PLUGIN_CONNECTION_ID,
                  subject: advancedSubject,
                  reviewProfile,
                  context: EMPTY_PR_REVIEW_THREAD_CONTEXT
                }
              },
              sessionRef: null,
              cancellationRequested: false
            }
          })
        }).pipe(Effect.provide(prReviewThreadHistoryLayer))
        assert.strictEqual(page.events.length, 66)
        assert.isFalse(page.hasMore)
        assert.strictEqual(page.nextCursor, page.events.at(-1)?.eventSequence)
      })
    ))

  it.effect("returns a bounded not-found identity for maximum valid PR subjects", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        const maximumSubject = Schema.decodeUnknownSync(PrReviewSubject)({
          ...subject,
          repository: "r".repeat(200),
          pullRequestId: "p".repeat(512)
        })
        const result = yield* jobs.reviewThreadAfter({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          subject: maximumSubject,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.isTrue(Schema.is(RecordNotFoundError)(result.failure))
          if (Schema.is(RecordNotFoundError)(result.failure)) {
            assert.strictEqual(result.failure.recordKey, "p".repeat(500))
          }
        }
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
        const revision = yield* currentSuggestionRevision(suggestionId)

        yield* jobs.reserveReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          revisionId: revision.revisionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          reservedAt: T3
        })
        yield* jobs.recordReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          revisionId: revision.revisionId,
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
          revisionId: revision.revisionId,
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
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          subject
        })
        assert.isTrue(Option.isSome(latest))
        if (Option.isSome(latest)) {
          assert.strictEqual(latest.value.report?.suggestions[0]?.state, "published")
        }

        const page = yield* jobs.reviewThreadAfter({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_CONNECTION_ID,
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

  it.effect("blocks edits until an in-flight publication is finalized", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview
        const suggestion = report.suggestions[0]!
        const revision = yield* currentSuggestionRevision(
          suggestion.suggestionId
        )
        yield* jobs.reserveReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          revisionId: revision.revisionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          reservedAt: T3
        })
        yield* jobs.recordReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          revisionId: revision.revisionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          publicationId: PUBLICATION_ID,
          publishedAt: T3,
          finalize: false
        })

        const edit = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: revision.revisionId,
          expectedSequence: revision.sequence,
          edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
            ...suggestion,
            title: "Do not race an in-flight publication"
          }),
          author: PrReviewSuggestionOperatorAuthor.make({
            personId: PERSON_ID
          }),
          createdAt: T4
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(edit))
        if (Result.isFailure(edit)) {
          assert.instanceOf(edit.failure, AgentJobInputError)
          assert.strictEqual(edit.failure.reason, "invalid-transition")
        }

        yield* jobs.recordReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          revisionId: revision.revisionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          publicationId: PUBLICATION_ID,
          publishedAt: T3,
          finalize: true
        })
        const editAfterPublication = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: revision.revisionId,
          expectedSequence: revision.sequence,
          edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
            ...suggestion,
            title: "Do not edit a finalized publication"
          }),
          author: PrReviewSuggestionOperatorAuthor.make({
            personId: PERSON_ID
          }),
          createdAt: T4
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(editAfterPublication))
        if (Result.isFailure(editAfterPublication)) {
          assert.instanceOf(editAfterPublication.failure, AgentJobInputError)
          assert.strictEqual(editAfterPublication.failure.reason, "invalid-transition")
        }
        const reloaded = yield* jobs.reviewResult({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID
        })
        assert.strictEqual(
          reloaded.report.suggestions[0]?.state,
          "published"
        )
        const thread = yield* jobs.reviewThreadAfter({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          subject,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        assert.strictEqual(
          thread.events.filter(
            ({ eventKind }) => eventKind === "review-suggestion-published"
          ).length,
          1
        )
      })
    ))

  it.effect("allows an edit after a no-write publication reservation is released", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview
        const suggestion = report.suggestions[0]!
        const revision = yield* currentSuggestionRevision(
          suggestion.suggestionId
        )
        yield* jobs.reserveReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          revisionId: revision.revisionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          reservedAt: T3
        })
        yield* jobs.releaseReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          revisionId: revision.revisionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID
        })

        const edited = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: revision.revisionId,
          expectedSequence: revision.sequence,
          edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
            ...suggestion,
            title: "Edit after releasing the no-write reservation"
          }),
          author: PrReviewSuggestionOperatorAuthor.make({
            personId: PERSON_ID
          }),
          createdAt: T4
        })
        assert.strictEqual(edited.sequence, 2)
      })
    ))

  it.effect("keeps original revision state immutable when a later revision is published", () =>
    withRepository(
      Effect.gen(function*() {
        const jobs = yield* AgentJobRepository
        yield* setupFoundation
        yield* enqueueReview
        yield* completeReview
        const suggestion = report.suggestions[0]!
        const original = yield* currentSuggestionRevision(
          suggestion.suggestionId
        )
        const edited = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          expectedRevisionId: original.revisionId,
          expectedSequence: original.sequence,
          edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)({
            ...suggestion,
            title: "Publish only this exact second revision"
          }),
          author: PrReviewSuggestionOperatorAuthor.make({
            personId: PERSON_ID
          }),
          createdAt: T3
        })
        yield* jobs.reserveReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          revisionId: edited.revisionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          reservedAt: T4
        })
        yield* jobs.recordReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          revisionId: edited.revisionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          publicationId: PUBLICATION_ID,
          publishedAt: T4
        })

        const history = yield* jobs.reviewSuggestionRevisions({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId: suggestion.suggestionId,
          beforeSequence: null,
          limit: PrReviewSuggestionRevisionPageSize.make(10)
        })
        assert.strictEqual(history.current.revisionId, edited.revisionId)
        assert.strictEqual(history.current.suggestion.state, "draft")
        assert.strictEqual(history.revisions[0]?.revisionId, original.revisionId)
        assert.strictEqual(history.revisions[0]?.suggestion.state, "draft")
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
        const revision = yield* currentSuggestionRevision(suggestionId)
        yield* jobs.reserveReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          revisionId: revision.revisionId,
          contentDigest: CONTENT_DIGEST,
          reservationId: RESERVATION_ID,
          reservedAt: T3
        })
        yield* jobs.recordReviewSuggestionPublication({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          suggestionId,
          revisionId: revision.revisionId,
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
        const revision = yield* currentSuggestionRevision(suggestionId)
        const reserve = (contentDigest: typeof ReviewSuggestionPublicationDigest.Type) =>
          jobs.reserveReviewSuggestionPublication({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            suggestionId,
            revisionId: revision.revisionId,
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
          revisionId: revision.revisionId,
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
            revisionId: revision.revisionId,
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
          pluginConnectionId: PLUGIN_CONNECTION_ID,
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
        const revision = yield* currentSuggestionRevision(suggestionId)
        const reserveAt = (reservedAt: typeof UtcTimestamp.Type) =>
          jobs.reserveReviewSuggestionPublication({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            suggestionId,
            revisionId: revision.revisionId,
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
          revisionId: revision.revisionId,
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
          revisionId: revision.revisionId,
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
          pluginConnectionId: PLUGIN_CONNECTION_ID,
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
          pluginConnectionId: PLUGIN_CONNECTION_ID,
          subject,
          after: AgentEventCursor.make(0),
          limit: AgentThreadEventPageSize.make(128)
        })
        assert.deepStrictEqual(
          page.events.map(({ eventKind, task }) => ({ eventKind, task })),
          [
            {
              eventKind: "user-message",
              task: { _tag: "pr-review", pluginConnectionId: PLUGIN_CONNECTION_ID, subject, reviewProfile }
            },
            {
              eventKind: "job-queued",
              task: { _tag: "pr-review", pluginConnectionId: PLUGIN_CONNECTION_ID, subject, reviewProfile }
            },
            {
              eventKind: "review-report",
              task: { _tag: "pr-review", pluginConnectionId: PLUGIN_CONNECTION_ID, subject, reviewProfile }
            },
            {
              eventKind: "job-completed",
              task: { _tag: "pr-review", pluginConnectionId: PLUGIN_CONNECTION_ID, subject, reviewProfile }
            }
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
          pluginConnectionId: PLUGIN_CONNECTION_ID,
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
