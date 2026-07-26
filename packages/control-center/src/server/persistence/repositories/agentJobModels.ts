/** Durable release-thread and local-agent job contracts. @module */
import { AgentContextFingerprint, AgentProviderId, AgentRuntimeEvent, AgentSessionRef } from "@knpkv/ai-runtime"
import * as Schema from "effect/Schema"

import { ReviewAgentProfile } from "../../../api/agent.js"
import {
  AgentThreadId,
  GovernedActionId,
  JobId,
  PluginConnectionId,
  PrReviewSuggestionRevisionId,
  ReleaseId,
  ReviewSuggestionPublicationReservationId,
  WorkspaceId
} from "../../../domain/identifiers.js"
import { PrReviewReport, PrReviewSubject, PrReviewSuggestionId } from "../../../domain/prReview.js"
import {
  PrReviewSuggestionEdit,
  PrReviewSuggestionRevisionAuthor,
  PrReviewSuggestionRevisionPageSize,
  PrReviewSuggestionRevisionSequence
} from "../../../domain/prReviewRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"

/** Maximum persisted provider output across one attempt. */
export const MAXIMUM_AGENT_ATTEMPT_OUTPUT_BYTES = 1_048_576

/**
 * Maximum prompt characters accepted by durable enqueue.
 *
 * JSON may escape one UTF-16 code unit to six bytes. This conservative bound
 * therefore keeps the complete `{ "prompt": ... }` event below 32 KiB.
 */
export const MAXIMUM_AGENT_JOB_PROMPT_LENGTH = 5_000

/** Maximum thread events returned by one replay page. */
export const MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE = 128

/** Positive sequence assigned to attempts within one durable job. */
export const AgentAttemptSequence = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
).pipe(Schema.brand("AgentAttemptSequence"))
export type AgentAttemptSequence = typeof AgentAttemptSequence.Type

/** Cursor used to request thread events after an already observed event. */
export const AgentEventCursor = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
).pipe(Schema.brand("AgentEventCursor"))
export type AgentEventCursor = typeof AgentEventCursor.Type

/** Bounded replay-page size accepted by the repository. */
export const AgentThreadEventPageSize = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE })
).pipe(Schema.brand("AgentThreadEventPageSize"))
export type AgentThreadEventPageSize = typeof AgentThreadEventPageSize.Type

/** Opaque worker identity retained with a durable claim. */
export const AgentLeaseOwner = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200)
).pipe(Schema.brand("AgentLeaseOwner"))
export type AgentLeaseOwner = typeof AgentLeaseOwner.Type

/** Secret bearer value proving ownership of one attempt lease. */
export const AgentLeaseToken = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase 256-bit token" })
).pipe(Schema.brand("AgentLeaseToken"))
export type AgentLeaseToken = typeof AgentLeaseToken.Type

const SubjectRevision = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500)
)

const AgentModel = Schema.NullOr(
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500))
)

/** Prompt guaranteed to fit the durable user-message event envelope. */
export const AgentJobPrompt = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAXIMUM_AGENT_JOB_PROMPT_LENGTH)
)
export type AgentJobPrompt = typeof AgentJobPrompt.Type

/** Durable task discriminator used to scope worker claims before execution. */
export const AgentJobTaskTag = Schema.Literals(["release-chat", "pr-review"])
export type AgentJobTaskTag = typeof AgentJobTaskTag.Type

/** Existing release-scoped conversational work. */
const ReleaseChatAgentJobTask = Schema.TaggedStruct("release-chat", {})

const PrReviewAgentJobTaskFields = {
  pluginConnectionId: PluginConnectionId,
  subject: PrReviewSubject,
  reviewProfile: ReviewAgentProfile
}

/** Read-only review request bound to one immutable pull request head. */
const EnqueuePrReviewAgentJobTask = Schema.TaggedStruct("pr-review", PrReviewAgentJobTaskFields)

const PrReviewThreadRequestSummary = Schema.Struct({
  jobId: JobId,
  prompt: AgentJobPrompt,
  subjectRevision: SubjectRevision,
  requestedAt: UtcTimestamp
})

const PrReviewThreadRunSummary = Schema.Struct({
  jobId: JobId,
  subject: PrReviewSubject,
  state: Schema.Literals(["cancelled", "failed", "succeeded", "unknown"]),
  requestedAt: UtcTimestamp,
  suggestionTitles: Schema.Array(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500))
  ).check(Schema.isMaxLength(8)),
  suggestionsTruncated: Schema.Boolean,
  noteTitles: Schema.Array(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500))
  ).check(Schema.isMaxLength(8)),
  notesTruncated: Schema.Boolean,
  limitation: Schema.NullOr(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_000))
  )
})

/**
 * Small review-thread context frozen into one immutable run.
 *
 * Full messages and artifacts remain behind explicit paged lookup boundaries.
 */
export const PrReviewThreadContextSnapshot = Schema.Struct({
  recentRequests: Schema.Array(PrReviewThreadRequestSummary).check(Schema.isMaxLength(4)),
  priorRuns: Schema.Array(PrReviewThreadRunSummary).check(Schema.isMaxLength(4)),
  historyTruncated: Schema.Boolean
})
export type PrReviewThreadContextSnapshot = typeof PrReviewThreadContextSnapshot.Type

/** Empty first-run context used before a review thread has prior activity. */
export const EMPTY_PR_REVIEW_THREAD_CONTEXT = PrReviewThreadContextSnapshot.make({
  recentRequests: [],
  priorRuns: [],
  historyTruncated: false
})

/** Persisted review work with the bounded thread context selected at enqueue. */
const PrReviewAgentJobTask = Schema.TaggedStruct("pr-review", {
  ...PrReviewAgentJobTaskFields,
  context: PrReviewThreadContextSnapshot
})

/** Caller-owned task request before repository context enrichment. */
export const EnqueueAgentJobTask = Schema.Union([
  ReleaseChatAgentJobTask,
  EnqueuePrReviewAgentJobTask
]).pipe(Schema.toTaggedUnion("_tag"))
export type EnqueueAgentJobTask = typeof EnqueueAgentJobTask.Type

/** Durable task context used to select an internal task executor. */
export const AgentJobTask = Schema.Union([
  ReleaseChatAgentJobTask,
  PrReviewAgentJobTask
]).pipe(Schema.toTaggedUnion("_tag"))
export type AgentJobTask = typeof AgentJobTask.Type

/** Lifecycle state of one durable agent job. */
export const AgentJobState = Schema.Literals([
  "queued",
  "running",
  "cancel-requested",
  "succeeded",
  "failed",
  "cancelled"
])
export type AgentJobState = typeof AgentJobState.Type

/** Immutable request persisted before a worker may claim it. */
export const EnqueueAgentJobInput = Schema.Struct({
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  jobId: JobId,
  providerId: AgentProviderId,
  model: AgentModel,
  access: Schema.Literals(["read-only", "workspace-write"]),
  userPrompt: AgentJobPrompt,
  prompt: AgentJobPrompt,
  contextFingerprint: AgentContextFingerprint,
  subjectRevision: SubjectRevision,
  task: EnqueueAgentJobTask,
  createdAt: UtcTimestamp
})
export type EnqueueAgentJobInput = typeof EnqueueAgentJobInput.Type

/** Context frozen for one provider attempt. */
export const AgentContextSnapshotRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  subjectRevision: SubjectRevision,
  fingerprint: AgentContextFingerprint,
  task: AgentJobTask
})
export type AgentContextSnapshotRecord = typeof AgentContextSnapshotRecord.Type

/** Claimed work returned only after the lease and attempt are durable. */
export const ClaimedAgentJob = Schema.Struct({
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  threadId: AgentThreadId,
  jobId: JobId,
  attemptSequence: AgentAttemptSequence,
  leaseOwner: AgentLeaseOwner,
  leaseToken: AgentLeaseToken,
  leaseExpiresAt: UtcTimestamp,
  providerId: AgentProviderId,
  model: AgentModel,
  access: Schema.Literals(["read-only", "workspace-write"]),
  prompt: AgentJobPrompt,
  context: AgentContextSnapshotRecord,
  sessionRef: Schema.NullOr(AgentSessionRef),
  cancellationRequested: Schema.Boolean
})
export type ClaimedAgentJob = typeof ClaimedAgentJob.Type

/**
 * Identity and expiration used to claim or reclaim one queued job.
 *
 * `claimedAt` is caller-reported context only; repository clock time owns
 * lease eligibility and the durable acquisition timestamp.
 */
export const ClaimAgentJobInput = Schema.Struct({
  workspaceId: WorkspaceId,
  taskTags: Schema.Array(AgentJobTaskTag).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AgentJobTaskTag.literals.length),
    Schema.isUnique()
  ),
  leaseOwner: AgentLeaseOwner,
  leaseToken: AgentLeaseToken,
  claimedAt: UtcTimestamp,
  leaseExpiresAt: UtcTimestamp
})
export type ClaimAgentJobInput = typeof ClaimAgentJobInput.Type

/** Provider event persisted under an active attempt lease. */
export const AppendAgentEventInput = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  attemptSequence: AgentAttemptSequence,
  leaseToken: AgentLeaseToken,
  event: AgentRuntimeEvent,
  occurredAt: UtcTimestamp
})
export type AppendAgentEventInput = typeof AppendAgentEventInput.Type

/** Untrusted complete review output presented under one active attempt lease. */
export const CompleteAgentReviewInput = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  attemptSequence: AgentAttemptSequence,
  leaseToken: AgentLeaseToken,
  report: Schema.Unknown,
  completedAt: UtcTimestamp
})
export type CompleteAgentReviewInput = typeof CompleteAgentReviewInput.Type

/** Digest binding one durable publication reservation to the exact confirmed body. */
export const ReviewSuggestionPublicationDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
).pipe(Schema.brand("ReviewSuggestionPublicationDigest"))
export type ReviewSuggestionPublicationDigest = typeof ReviewSuggestionPublicationDigest.Type

/** Atomic pre-provider reservation for one suggestion and exact confirmed body. */
export const ReserveReviewSuggestionPublicationInput = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  suggestionId: PrReviewSuggestionId,
  contentDigest: ReviewSuggestionPublicationDigest,
  reservationId: ReviewSuggestionPublicationReservationId,
  reservedAt: UtcTimestamp
})
export type ReserveReviewSuggestionPublicationInput = typeof ReserveReviewSuggestionPublicationInput.Type

/** Durable result of reserving an exact publication body. */
export const ReviewSuggestionPublicationReservation = Schema.Union([
  Schema.TaggedStruct("acquired", {}),
  Schema.TaggedStruct("in-progress", {}),
  Schema.TaggedStruct("recoverable", {
    publicationId: GovernedActionId,
    publishedAt: UtcTimestamp,
    reservationId: ReviewSuggestionPublicationReservationId
  }),
  Schema.TaggedStruct("published", {
    publicationId: GovernedActionId,
    publishedAt: UtcTimestamp
  })
])
export type ReviewSuggestionPublicationReservation = typeof ReviewSuggestionPublicationReservation.Type

/** Release one exact reservation after a confirmed provider no-write outcome. */
export const ReleaseReviewSuggestionPublicationInput = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  suggestionId: PrReviewSuggestionId,
  contentDigest: ReviewSuggestionPublicationDigest,
  reservationId: ReviewSuggestionPublicationReservationId
})
export type ReleaseReviewSuggestionPublicationInput = typeof ReleaseReviewSuggestionPublicationInput.Type

/** Successful governed publication to overlay onto one immutable review report. */
export const RecordReviewSuggestionPublicationInput = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  suggestionId: PrReviewSuggestionId,
  contentDigest: ReviewSuggestionPublicationDigest,
  reservationId: ReviewSuggestionPublicationReservationId,
  publicationId: GovernedActionId,
  publishedAt: UtcTimestamp,
  finalize: Schema.optionalKey(Schema.Boolean)
})
export type RecordReviewSuggestionPublicationInput = typeof RecordReviewSuggestionPublicationInput.Type

/** Workspace-scoped lookup for one durable review result. */
export const AgentReviewResultInput = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId
})
export type AgentReviewResultInput = typeof AgentReviewResultInput.Type

/** Sanitized durable review result attributable to one terminal attempt. */
export const AgentReviewResultRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  attemptSequence: AgentAttemptSequence,
  report: PrReviewReport,
  completedAt: UtcTimestamp
})
export type AgentReviewResultRecord = typeof AgentReviewResultRecord.Type

/** Workspace-scoped bounded read of one stable suggestion's prior revisions. */
export const ReadReviewSuggestionRevisionsInput = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  suggestionId: PrReviewSuggestionId,
  beforeSequence: Schema.NullOr(PrReviewSuggestionRevisionSequence),
  limit: PrReviewSuggestionRevisionPageSize
})
export type ReadReviewSuggestionRevisionsInput = typeof ReadReviewSuggestionRevisionsInput.Type

/** Complete compare-and-append command for one immutable suggestion edit. */
export const AppendReviewSuggestionRevisionInput = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  suggestionId: PrReviewSuggestionId,
  expectedRevisionId: PrReviewSuggestionRevisionId,
  expectedSequence: PrReviewSuggestionRevisionSequence,
  edit: PrReviewSuggestionEdit,
  author: PrReviewSuggestionRevisionAuthor,
  createdAt: UtcTimestamp
})
export type AppendReviewSuggestionRevisionInput = typeof AppendReviewSuggestionRevisionInput.Type

/** Exact immutable subject used to recover its newest durable review job. */
export const LatestAgentReviewInput = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  subject: PrReviewSubject,
  jobId: Schema.optionalKey(JobId)
})
export type LatestAgentReviewInput = typeof LatestAgentReviewInput.Type

/** Cursor-bounded lookup for the durable thread behind a stable pull request. */
export const PrReviewThreadSubject = Schema.Struct({
  providerId: PrReviewSubject.fields.providerId,
  repository: PrReviewSubject.fields.repository,
  pullRequestId: PrReviewSubject.fields.pullRequestId
})
export type PrReviewThreadSubject = typeof PrReviewThreadSubject.Type

export const AgentReviewThreadAfterInput = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  subject: PrReviewThreadSubject,
  after: AgentEventCursor,
  limit: AgentThreadEventPageSize
})
export type AgentReviewThreadAfterInput = typeof AgentReviewThreadAfterInput.Type

export const AgentReviewThreadBeforeInput = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  subject: PrReviewThreadSubject,
  before: AgentEventCursor,
  limit: AgentThreadEventPageSize
})
export type AgentReviewThreadBeforeInput = typeof AgentReviewThreadBeforeInput.Type

/** Cursor-bounded prior history fenced before one immutable review job. */
export const AgentReviewThreadHistoryInput = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: AgentThreadId,
  beforeJobId: JobId,
  after: AgentEventCursor,
  limit: AgentThreadEventPageSize
})
export type AgentReviewThreadHistoryInput = typeof AgentReviewThreadHistoryInput.Type

export const AgentReviewThreadTailInput = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  subject: PrReviewThreadSubject,
  limit: AgentThreadEventPageSize
})
export type AgentReviewThreadTailInput = typeof AgentReviewThreadTailInput.Type

/** Newest durable lifecycle state for one exact immutable review subject. */
export const LatestAgentReviewRecord = Schema.Struct({
  jobId: JobId,
  threadId: AgentThreadId,
  providerId: AgentProviderId,
  model: AgentModel,
  state: AgentJobState,
  createdAt: UtcTimestamp,
  terminalAt: Schema.NullOr(UtcTimestamp),
  report: Schema.NullOr(PrReviewReport),
  reviewProfile: ReviewAgentProfile,
  activity: Schema.Struct({
    events: Schema.Array(
      Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAXIMUM_AGENT_ATTEMPT_OUTPUT_BYTES))
    ).check(Schema.isMaxLength(MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE)),
    truncated: Schema.Boolean
  })
}).check(
  Schema.makeFilter(
    ({ report, state }) => (state === "succeeded") === (report !== null),
    { expected: "only succeeded review jobs to carry a report" }
  )
)
export type LatestAgentReviewRecord = typeof LatestAgentReviewRecord.Type

/** One immutable event in a release thread. */
export const AgentThreadEvent = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: AgentThreadId,
  eventSequence: AgentEventCursor.check(Schema.isGreaterThan(0)),
  jobId: JobId,
  attemptSequence: Schema.NullOr(AgentAttemptSequence),
  task: Schema.optionalKey(EnqueueAgentJobTask),
  eventKind: Schema.Literals([
    "user-message",
    "job-queued",
    "job-started",
    "assistant-output",
    "progress",
    "usage",
    "review-report",
    "review-suggestion-revised",
    "review-suggestion-published",
    "job-completed",
    "job-failed",
    "cancel-requested"
  ]),
  payload: Schema.Unknown,
  occurredAt: UtcTimestamp
})
export type AgentThreadEvent = typeof AgentThreadEvent.Type

/** Ordered bounded replay page for one release thread. */
export interface AgentThreadEventPage {
  readonly events: ReadonlyArray<AgentThreadEvent>
  readonly nextCursor: AgentEventCursor
}

/** Stable typed failure for invalid job state, lease, or bounded output. */
export class AgentJobInputError extends Schema.TaggedErrorClass<AgentJobInputError>()(
  "AgentJobInputError",
  {
    workspaceId: WorkspaceId,
    jobId: JobId,
    reason: Schema.Literals([
      "invalid-transition",
      "lease-lost",
      "lease-expired",
      "cancellation-requested",
      "output-limit-exceeded",
      "event-limit-exceeded",
      "invalid-result",
      "revision-identity-mismatch",
      "task-mismatch"
    ])
  }
) {}
