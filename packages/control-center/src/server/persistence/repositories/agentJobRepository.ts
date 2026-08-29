/** Durable release-thread job claiming, event persistence, and replay. @module */
import { AgentProviderError, AgentRuntimeEvent, MAXIMUM_AGENT_RUNTIME_EVENT_BYTES } from "@knpkv/ai-runtime"
import {
  type ClaimableAgentJobState,
  renderAgentJobClaimQuery,
  renderAgentJobDispatchCandidatesQuery,
  renderAgentReviewContextEventsQuery,
  renderAgentReviewThreadHistoryQuery,
  renderAgentThreadBeforeQuery,
  renderAgentThreadReplayQuery,
  renderAgentThreadTailQuery,
  renderLatestAgentReviewQuery
} from "@knpkv/control-center-sql"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  AgentThreadId,
  GovernedActionId,
  JobId,
  PluginConnectionId,
  ReleaseId,
  ReviewSuggestionPublicationReservationId,
  WorkspaceId
} from "../../../domain/identifiers.js"
import {
  MAXIMUM_PR_REVIEW_REPORT_BYTES,
  PrReviewReport,
  PrReviewSubject,
  type PrReviewSuggestion,
  PrReviewSuggestionId,
  reconcilePrReviewReports
} from "../../../domain/prReview.js"
import { validatePrReviewReportTransitions } from "../../../domain/prReviewReconciliation.js"
import {
  PrReviewSuggestionAgentAuthor,
  PrReviewSuggestionEdit,
  PrReviewSuggestionRevision,
  PrReviewSuggestionRevisionPageSize
} from "../../../domain/prReviewRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import {
  MAXIMUM_PERSISTENCE_RECORD_KEY_LENGTH,
  PersistedRecordError,
  PersistenceOperationError,
  RecordNotFoundError
} from "../errors.js"
import {
  AgentAttemptSequence,
  AgentContextSnapshotRecord,
  AgentEventCursor,
  AgentJobInputError,
  type AgentJobPrompt,
  AgentJobState,
  AgentJobTask,
  AgentJobTaskTag,
  AgentLeaseToken,
  AgentReviewResultInput,
  AgentReviewResultRecord,
  AgentReviewThreadAfterInput,
  AgentReviewThreadBeforeInput,
  AgentReviewThreadHistoryInput,
  AgentReviewThreadTailInput,
  AgentThreadEvent,
  type AgentThreadEventPage,
  AgentThreadEventPageSize,
  AppendAgentEventInput,
  type AppendReviewSuggestionRevisionInput,
  AttachRunningPrReviewSessionInput,
  ClaimAgentJobInput,
  ClaimedAgentJob,
  CompleteAgentReviewInput,
  CompleteTargetedReviewInput,
  EnqueueAgentJobInput,
  ExtendReviewBudgetInput,
  InterruptRunningReviewsInput,
  LatestAgentReviewInput,
  LatestAgentReviewRecord,
  MAXIMUM_AGENT_ATTEMPT_OUTPUT_BYTES,
  MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE,
  PrReviewThreadContextSnapshot,
  type PrReviewThreadSubject,
  ReadReviewBudgetInput,
  ReadReviewSuggestionPublication,
  ReadReviewSuggestionPublicationInput,
  type ReadReviewSuggestionRevisionsInput,
  RecordAgentReviewProgressInput,
  RecordReviewSuggestionPublicationInput,
  ReleaseReviewSuggestionPublicationInput,
  ReserveReviewSuggestionPublicationInput,
  ReviewSuggestionPublicationCommentId,
  ReviewSuggestionPublicationDigest,
  ReviewSuggestionPublicationReservation,
  RunningPrReviewAttempt
} from "./agentJobModels.js"
import { mapAlreadyExists, mapPersistenceOperation, readChanges } from "./internal.js"
import {
  makeReviewSuggestionRevisionOperations,
  ReviewSuggestionRevisedPayload
} from "./internal/reviewSuggestionRevisions.js"
import type { SqlRow } from "./sqlRow.js"

const DISPATCH_CANDIDATE_LIMIT = 32
const MAXIMUM_AGENT_EVENT_BYTES = MAXIMUM_AGENT_RUNTIME_EVENT_BYTES
const SHA_256_PREFIX = "sha256:"
const REVIEW_SUGGESTION_PUBLICATION_RESERVATION_LIFETIME_MINUTES = 10
const REVIEW_CONTEXT_EVENT_LIMIT = 32
const REVIEW_CONTEXT_ITEM_LIMIT = 4
const REVIEW_CONTEXT_REPORT_ITEM_LIMIT = 8
const PrReviewSubjectEquivalence = Schema.toEquivalence(PrReviewSubject)
const PrReviewThreadIdentity = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  providerId: PrReviewSubject.fields.providerId,
  repository: PrReviewSubject.fields.repository,
  pullRequestId: PrReviewSubject.fields.pullRequestId
})

const PersistedDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
)

const ReviewSuggestionLifecycleRevisionRow = Schema.Struct({
  suggestionId: PrReviewSuggestionId,
  revisionJson: Schema.String,
  revisionDigest: PersistedDigest
})

const UserMessagePayload = Schema.Struct({
  prompt: EnqueueAgentJobInput.fields.userPrompt
})

const JobQueuedPayload = Schema.Struct({
  model: EnqueueAgentJobInput.fields.model,
  providerId: EnqueueAgentJobInput.fields.providerId
})

const PersistedJobQueuedPayload = Schema.Struct({
  access: EnqueueAgentJobInput.fields.access,
  contextFingerprint: EnqueueAgentJobInput.fields.contextFingerprint,
  model: EnqueueAgentJobInput.fields.model,
  providerId: EnqueueAgentJobInput.fields.providerId,
  subjectRevision: EnqueueAgentJobInput.fields.subjectRevision,
  task: AgentJobTask,
  reviewBudgetMillis: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600_000 }))),
  reviewBudgetExtensionCount: Schema.optionalKey(Schema.Literal(1))
})

const CancellationRequestedPayload = Schema.Struct({
  requestedAt: UtcTimestamp
})

const ProviderFailurePayload = Schema.Struct({
  error: AgentProviderError
})

export const PROCESS_RESTART_INTERRUPTION_MESSAGE = "Review interrupted because the Control Center process restarted."

const ReviewSuggestionPublishedPayload = Schema.Struct({
  suggestionId: RecordReviewSuggestionPublicationInput.fields.suggestionId,
  revisionId: RecordReviewSuggestionPublicationInput.fields.revisionId,
  publicationId: RecordReviewSuggestionPublicationInput.fields.publicationId
})

const ReviewSuggestionPublicationRow = Schema.Struct({
  revisionId: RecordReviewSuggestionPublicationInput.fields.revisionId,
  contentDigest: ReviewSuggestionPublicationDigest,
  state: Schema.Literals(["reserved", "published"]),
  publicationId: Schema.NullOr(GovernedActionId),
  commentId: Schema.NullOr(ReviewSuggestionPublicationCommentId),
  previousContentDigest: Schema.NullOr(ReviewSuggestionPublicationDigest),
  previousPublicationId: Schema.NullOr(GovernedActionId),
  previousPublishedAt: Schema.NullOr(UtcTimestamp),
  reservationAcquiredAt: UtcTimestamp,
  reservationId: ReviewSuggestionPublicationReservationId,
  reservedAt: UtcTimestamp,
  publishedAt: Schema.NullOr(UtcTimestamp)
})

const ThreadRow = Schema.Struct({
  threadId: AgentThreadId,
  threadKind: AgentJobTaskTag,
  subjectKey: Schema.String,
  releaseId: Schema.NullOr(ReleaseId)
})

const JobRow = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  threadId: AgentThreadId,
  releaseId: Schema.NullOr(ReleaseId),
  providerId: EnqueueAgentJobInput.fields.providerId,
  model: EnqueueAgentJobInput.fields.model,
  access: EnqueueAgentJobInput.fields.access,
  prompt: EnqueueAgentJobInput.fields.prompt,
  contextFingerprint: EnqueueAgentJobInput.fields.contextFingerprint,
  subjectRevision: EnqueueAgentJobInput.fields.subjectRevision,
  taskContextJson: Schema.String,
  taskContextDigest: PersistedDigest,
  state: AgentJobState,
  createdAt: UtcTimestamp,
  cancelRequestedAt: Schema.NullOr(UtcTimestamp),
  terminalAt: Schema.NullOr(UtcTimestamp)
})

const LatestReviewRow = Schema.Struct({
  jobId: JobId,
  threadId: AgentThreadId,
  providerId: EnqueueAgentJobInput.fields.providerId,
  model: EnqueueAgentJobInput.fields.model,
  state: AgentJobState,
  createdAt: UtcTimestamp,
  terminalAt: Schema.NullOr(UtcTimestamp),
  taskContextJson: Schema.String,
  taskContextDigest: PersistedDigest
})

const DispatchCandidateRow = Schema.Struct({
  ...JobRow.fields,
  state: Schema.Literals(["queued", "running", "cancel-requested"]),
  attemptSequence: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
})

const PreviousAttemptRow = Schema.Struct({
  contextSnapshotJson: Schema.String,
  contextSnapshotDigest: PersistedDigest,
  sessionRef: ClaimedAgentJob.fields.sessionRef
})

const ActiveAttemptRow = Schema.Struct({
  startedAt: UtcTimestamp,
  completedAt: Schema.NullOr(UtcTimestamp)
})

const LeaseRow = Schema.Struct({
  leaseToken: AgentLeaseToken,
  leaseExpiresAt: UtcTimestamp
})

const ActiveLeaseRow = Schema.Struct({
  active: Schema.Int
})

const ThreadEventRow = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: AgentThreadId,
  eventSequence: AgentEventCursor.check(Schema.isGreaterThan(0)),
  jobId: JobId,
  attemptSequence: Schema.NullOr(AgentAttemptSequence),
  eventKind: AgentThreadEvent.fields.eventKind,
  payloadJson: Schema.String,
  payloadDigest: PersistedDigest,
  payloadByteLength: Schema.Int,
  occurredAt: UtcTimestamp
})

const ReplayThreadEventRow = Schema.Struct({
  ...ThreadEventRow.fields,
  taskContextJson: Schema.String,
  taskContextDigest: PersistedDigest
})

const ReviewContextThreadEventRow = Schema.Struct({
  ...ReplayThreadEventRow.fields,
  jobState: AgentJobState
})

const FailAgentAttemptInput = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  attemptSequence: AgentAttemptSequence,
  leaseToken: AgentLeaseToken,
  error: AgentProviderError,
  failedAt: UtcTimestamp
})

const RequestAgentCancellationInput = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  requestedAt: UtcTimestamp
})

const HeartbeatAgentJobInput = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  attemptSequence: AgentAttemptSequence,
  leaseToken: AgentLeaseToken,
  leaseExpiresAt: UtcTimestamp
})

const AgentThreadAfterInput = Schema.Struct({
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  after: AgentEventCursor,
  limit: AgentThreadEventPageSize
})

type EncodedPayload = {
  readonly bytes: Uint8Array
  readonly digest: string
  readonly json: string
}

type EventKind = typeof AgentThreadEvent.fields.eventKind.Type

const encodeTimestamp = Schema.encodeSync(UtcTimestamp)

const persistedRecordError = (
  workspaceId: typeof WorkspaceId.Type,
  recordKind: string,
  recordKey: string,
  diagnosticCode: string
) => new PersistedRecordError({ workspaceId, recordKind, recordKey, diagnosticCode })

const makeAgentJobRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const sql = database.sql

  const bytesFromText = Effect.fn("AgentJobRepository.bytesFromText")(function*(value: string) {
    return yield* Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(value))).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.encode-utf8" }))
    )
  })

  const digestBytes = Effect.fn("AgentJobRepository.digestBytes")(function*(bytes: Uint8Array) {
    const digest = yield* cryptoService
      .digest("SHA-256", bytes)
      .pipe(Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.digest" })))
    return `${SHA_256_PREFIX}${Encoding.encodeHex(digest)}`
  })

  const encodePayload = Effect.fn("AgentJobRepository.encodePayload")(function*<UnparsedInput>(
    schema: Schema.Codec<unknown, unknown, never, never>,
    payload: UnparsedInput
  ): Effect.fn.Return<EncodedPayload, PersistenceOperationError> {
    const json = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(schema))(payload).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.encode-payload" }))
    )
    const bytes = yield* bytesFromText(json)
    if (bytes.length > MAXIMUM_AGENT_EVENT_BYTES) {
      return yield* new PersistenceOperationError({ operation: "agent-job.event-too-large" })
    }
    return { bytes, digest: yield* digestBytes(bytes), json }
  })

  const encodeReviewReport = Effect.fn("AgentJobRepository.encodeReviewReport")(function*(
    report: typeof PrReviewReport.Type
  ): Effect.fn.Return<EncodedPayload, PersistenceOperationError> {
    const json = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(PrReviewReport))(report).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.encode-review-report" }))
    )
    const bytes = yield* bytesFromText(json)
    if (bytes.length > MAXIMUM_PR_REVIEW_REPORT_BYTES) {
      return yield* new PersistenceOperationError({ operation: "agent-job.review-report-too-large" })
    }
    return { bytes, digest: yield* digestBytes(bytes), json }
  })

  const sanitizeAgentReviewReport = (report: typeof PrReviewReport.Type): typeof PrReviewReport.Type =>
    (() => {
      const { transitions: _agentOwnedTransitions, ...agentOwnedReport } = report
      return PrReviewReport.make(agentOwnedReport)
    })()
  const isAgentOwnedSuggestionState = (state: typeof PrReviewReport.Type["suggestions"][number]["state"]): boolean =>
    state === "draft" || state === "resolved"

  const decodeTaskContext = Effect.fn("AgentJobRepository.decodeTaskContext")(function*(
    workspaceId: typeof WorkspaceId.Type,
    jobId: typeof JobId.Type,
    taskContextJson: string,
    taskContextDigest: typeof PersistedDigest.Type
  ) {
    const bytes = yield* bytesFromText(taskContextJson)
    const actualDigest = yield* digestBytes(bytes)
    if (actualDigest !== taskContextDigest) {
      return yield* persistedRecordError(
        workspaceId,
        "agent-job",
        jobId,
        "agent-job-task-context-integrity-invalid"
      )
    }
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AgentJobTask))(taskContextJson).pipe(
      Effect.mapError(() => persistedRecordError(workspaceId, "agent-job", jobId, "agent-job-task-context-invalid"))
    )
  })

  const reserveEventSequence = Effect.fn("AgentJobRepository.reserveEventSequence")(function*(
    workspaceId: typeof WorkspaceId.Type,
    threadId: typeof AgentThreadId.Type
  ) {
    const rows = yield* sql<{ readonly eventSequence: number }>`UPDATE agent_threads
      SET next_event_sequence = next_event_sequence + 1
      WHERE workspace_id = ${workspaceId}
        AND thread_id = ${threadId}
        AND next_event_sequence < ${Number.MAX_SAFE_INTEGER}
      RETURNING next_event_sequence - 1 AS eventSequence`
    const eventSequence = rows[0]?.eventSequence
    if (eventSequence === undefined) {
      return yield* new PersistenceOperationError({ operation: "agent-job.reserve-event-sequence" })
    }
    return yield* Schema.decodeUnknownEffect(AgentEventCursor.check(Schema.isGreaterThan(0)))(eventSequence)
  })

  const appendThreadEvent = Effect.fn("AgentJobRepository.appendThreadEvent")(function*(options: {
    readonly workspaceId: typeof WorkspaceId.Type
    readonly threadId: typeof AgentThreadId.Type
    readonly jobId: typeof JobId.Type
    readonly attemptSequence: null | typeof AgentAttemptSequence.Type
    readonly eventKind: EventKind
    readonly payload: unknown
    readonly payloadSchema: Schema.Codec<unknown, unknown, never, never>
    readonly occurredAt: typeof UtcTimestamp.Type
  }) {
    const encoded = yield* encodePayload(options.payloadSchema, options.payload).pipe(
      Effect.mapError((error): AgentJobInputError | PersistenceOperationError =>
        error.operation === "agent-job.event-too-large"
          ? new AgentJobInputError({
            workspaceId: options.workspaceId,
            jobId: options.jobId,
            reason: "event-limit-exceeded"
          })
          : error
      )
    )
    const eventSequence = yield* reserveEventSequence(options.workspaceId, options.threadId)
    yield* sql`INSERT INTO agent_thread_events (
      workspace_id, thread_id, event_sequence, job_id, attempt_sequence,
      event_kind, payload_json, payload_digest, payload_byte_length, occurred_at
    ) VALUES (
      ${options.workspaceId}, ${options.threadId}, ${eventSequence}, ${options.jobId},
      ${options.attemptSequence}, ${options.eventKind}, ${encoded.json}, ${encoded.digest},
      ${encoded.bytes.length}, ${encodeTimestamp(options.occurredAt)}
    )`
    return yield* Schema.decodeUnknownEffect(Schema.toType(AgentThreadEvent))({
      workspaceId: options.workspaceId,
      threadId: options.threadId,
      eventSequence,
      jobId: options.jobId,
      attemptSequence: options.attemptSequence,
      eventKind: options.eventKind,
      payload: options.payload,
      occurredAt: options.occurredAt
    })
  })

  const findThread = Effect.fn("AgentJobRepository.findThread")(function*(
    workspaceId: typeof WorkspaceId.Type,
    threadKind: typeof AgentJobTaskTag.Type,
    subjectKey: string
  ) {
    const rows = yield* sql<SqlRow>`SELECT
      thread_id AS threadId, thread_kind AS threadKind,
      subject_key AS subjectKey, release_id AS releaseId
      FROM agent_threads
      WHERE workspace_id = ${workspaceId}
        AND thread_kind = ${threadKind}
        AND subject_key = ${subjectKey}`
    if (rows.length === 0) return Option.none<typeof ThreadRow.Type>()
    const decoded = Schema.decodeUnknownResult(ThreadRow)(rows[0])
    if (Result.isFailure(decoded)) {
      return yield* persistedRecordError(workspaceId, "agent-thread", subjectKey, "agent-thread-schema-invalid")
    }
    return Option.some(decoded.success)
  })

  const reviewThreadSubjectKey = Effect.fn("AgentJobRepository.reviewThreadSubjectKey")(function*(
    pluginConnectionId: typeof PluginConnectionId.Type,
    subject: typeof PrReviewThreadSubject.Type
  ) {
    return yield* Schema.encodeUnknownEffect(
      Schema.fromJsonString(PrReviewThreadIdentity)
    )({
      pluginConnectionId,
      providerId: subject.providerId,
      repository: subject.repository,
      pullRequestId: subject.pullRequestId
    }).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.review-thread-subject-key" }))
    )
  })

  const getJob = Effect.fn("AgentJobRepository.getJob")(function*(
    workspaceId: typeof WorkspaceId.Type,
    jobId: typeof JobId.Type
  ) {
    const rows = yield* sql<SqlRow>`SELECT
      workspace_id AS workspaceId, job_id AS jobId, thread_id AS threadId,
      release_id AS releaseId, provider_id AS providerId, model, access, prompt,
      context_fingerprint AS contextFingerprint, subject_revision AS subjectRevision,
      task_context_json AS taskContextJson, task_context_digest AS taskContextDigest,
      state, created_at AS createdAt, cancel_requested_at AS cancelRequestedAt,
      terminal_at AS terminalAt
      FROM agent_jobs
      WHERE workspace_id = ${workspaceId} AND job_id = ${jobId}`
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "agent-job",
        recordKey: jobId
      })
    }
    const decoded = Schema.decodeUnknownResult(JobRow)(rows[0])
    if (Result.isFailure(decoded)) {
      return yield* persistedRecordError(workspaceId, "agent-job", jobId, "agent-job-schema-invalid")
    }
    return {
      ...decoded.success,
      task: yield* decodeTaskContext(
        workspaceId,
        jobId,
        decoded.success.taskContextJson,
        decoded.success.taskContextDigest
      )
    }
  })

  const validateLease = Effect.fn("AgentJobRepository.validateLease")(function*(options: {
    readonly workspaceId: typeof WorkspaceId.Type
    readonly jobId: typeof JobId.Type
    readonly attemptSequence: typeof AgentAttemptSequence.Type
    readonly leaseToken: typeof AgentLeaseToken.Type
    readonly observedAt: typeof UtcTimestamp.Type
  }) {
    const currentTime = yield* DateTime.now
    const leaseRows = yield* sql<SqlRow>`SELECT
      lease.lease_token AS leaseToken, lease.lease_expires_at AS leaseExpiresAt
      FROM agent_job_leases lease
      WHERE lease.workspace_id = ${options.workspaceId}
        AND lease.job_id = ${options.jobId}
        AND lease.attempt_sequence = ${options.attemptSequence}
        AND NOT EXISTS (
          SELECT 1 FROM agent_job_attempts newer
          WHERE newer.workspace_id = lease.workspace_id
            AND newer.job_id = lease.job_id
            AND newer.attempt_sequence > lease.attempt_sequence
        )`
    const lease = Schema.decodeUnknownResult(LeaseRow)(leaseRows[0])
    if (Result.isFailure(lease) || lease.success.leaseToken !== options.leaseToken) {
      return yield* new AgentJobInputError({
        workspaceId: options.workspaceId,
        jobId: options.jobId,
        reason: "lease-lost"
      })
    }
    const attemptRows = yield* sql<SqlRow>`SELECT
      started_at AS startedAt, completed_at AS completedAt
      FROM agent_job_attempts
      WHERE workspace_id = ${options.workspaceId}
        AND job_id = ${options.jobId}
        AND attempt_sequence = ${options.attemptSequence}`
    const attempt = Schema.decodeUnknownResult(ActiveAttemptRow)(attemptRows[0])
    if (Result.isFailure(attempt) || attempt.success.completedAt !== null) {
      return yield* new AgentJobInputError({
        workspaceId: options.workspaceId,
        jobId: options.jobId,
        reason: "invalid-transition"
      })
    }
    if (
      DateTime.Order(currentTime, lease.success.leaseExpiresAt) >= 0 ||
      DateTime.Order(options.observedAt, lease.success.leaseExpiresAt) >= 0
    ) {
      return yield* new AgentJobInputError({
        workspaceId: options.workspaceId,
        jobId: options.jobId,
        reason: "lease-expired"
      })
    }
    if (DateTime.Order(attempt.success.startedAt, options.observedAt) > 0) {
      return yield* new AgentJobInputError({
        workspaceId: options.workspaceId,
        jobId: options.jobId,
        reason: "invalid-transition"
      })
    }
  })

  const completeAttempt = Effect.fn("AgentJobRepository.completeAttempt")(function*(options: {
    readonly workspaceId: typeof WorkspaceId.Type
    readonly jobId: typeof JobId.Type
    readonly attemptSequence: typeof AgentAttemptSequence.Type
    readonly completedAt: typeof UtcTimestamp.Type
    readonly outcome: "success" | "failed" | "cancelled" | "max-steps"
    readonly state: "succeeded" | "failed" | "cancelled"
    readonly sessionRef: null | typeof ClaimedAgentJob.fields.sessionRef.Type
    readonly errorJson: null | string
  }) {
    yield* sql`UPDATE agent_job_attempts
      SET completed_at = ${encodeTimestamp(options.completedAt)},
          outcome = ${options.outcome},
          session_ref = COALESCE(${options.sessionRef}, session_ref),
          error_json = ${options.errorJson}
      WHERE workspace_id = ${options.workspaceId}
        AND job_id = ${options.jobId}
        AND attempt_sequence = ${options.attemptSequence}
        AND completed_at IS NULL`
    if ((yield* readChanges(sql)) !== 1) {
      return yield* new AgentJobInputError({
        workspaceId: options.workspaceId,
        jobId: options.jobId,
        reason: "invalid-transition"
      })
    }
    yield* sql`UPDATE agent_jobs
      SET state = ${options.state}, terminal_at = ${encodeTimestamp(options.completedAt)}
      WHERE workspace_id = ${options.workspaceId}
        AND job_id = ${options.jobId}
        AND state IN ('running', 'cancel-requested')
        AND terminal_at IS NULL`
    if ((yield* readChanges(sql)) !== 1) {
      return yield* new AgentJobInputError({
        workspaceId: options.workspaceId,
        jobId: options.jobId,
        reason: "invalid-transition"
      })
    }
    yield* sql`DELETE FROM agent_job_leases
      WHERE workspace_id = ${options.workspaceId}
        AND job_id = ${options.jobId}`
  })

  const decodeRuntimePayload = Effect.fn("AgentJobRepository.decodeRuntimePayload")(function*<UnparsedInput>(
    workspaceId: typeof WorkspaceId.Type,
    row: typeof ThreadEventRow.Type,
    parsed: UnparsedInput
  ) {
    const decoded = Schema.decodeUnknownResult(AgentRuntimeEvent)(parsed)
    if (Result.isFailure(decoded)) {
      return yield* persistedRecordError(
        workspaceId,
        "agent-thread-event",
        `${row.threadId}/${row.eventSequence}`,
        "agent-thread-event-payload-invalid"
      )
    }
    const event = decoded.success
    const matches = row.eventKind === "job-started"
      ? event._tag === "started"
      : row.eventKind === "assistant-output"
      ? event._tag === "output" && event.channel === "assistant"
      : row.eventKind === "progress"
      ? event._tag === "output" && event.channel === "progress"
      : row.eventKind === "usage"
      ? event._tag === "usage"
      : row.eventKind === "job-completed" && event._tag === "completed"
    if (!matches) {
      return yield* persistedRecordError(
        workspaceId,
        "agent-thread-event",
        `${row.threadId}/${row.eventSequence}`,
        "agent-thread-event-kind-mismatch"
      )
    }
    return event
  })

  const decodeEventPayload = Effect.fn("AgentJobRepository.decodeEventPayload")(function*(
    workspaceId: typeof WorkspaceId.Type,
    row: typeof ThreadEventRow.Type
  ) {
    const bytes = yield* bytesFromText(row.payloadJson)
    const actualDigest = yield* digestBytes(bytes)
    if (bytes.length !== row.payloadByteLength || actualDigest !== row.payloadDigest) {
      return yield* persistedRecordError(
        workspaceId,
        "agent-thread-event",
        `${row.threadId}/${row.eventSequence}`,
        "agent-thread-event-integrity-invalid"
      )
    }
    const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(row.payloadJson)
    if (Result.isFailure(parsed)) {
      return yield* persistedRecordError(
        workspaceId,
        "agent-thread-event",
        `${row.threadId}/${row.eventSequence}`,
        "agent-thread-event-json-invalid"
      )
    }
    const payload = parsed.success
    switch (row.eventKind) {
      case "user-message":
        return yield* Schema.decodeUnknownEffect(UserMessagePayload)(payload).pipe(
          Effect.mapError(() =>
            persistedRecordError(
              workspaceId,
              "agent-thread-event",
              `${row.threadId}/${row.eventSequence}`,
              "agent-thread-event-payload-invalid"
            )
          )
        )
      case "job-queued":
        return yield* Schema.decodeUnknownEffect(JobQueuedPayload)(payload).pipe(
          Effect.mapError(() =>
            persistedRecordError(
              workspaceId,
              "agent-thread-event",
              `${row.threadId}/${row.eventSequence}`,
              "agent-thread-event-payload-invalid"
            )
          )
        )
      case "cancel-requested":
        return yield* Schema.decodeUnknownEffect(CancellationRequestedPayload)(payload).pipe(
          Effect.mapError(() =>
            persistedRecordError(
              workspaceId,
              "agent-thread-event",
              `${row.threadId}/${row.eventSequence}`,
              "agent-thread-event-payload-invalid"
            )
          )
        )
      case "job-failed":
        return yield* Schema.decodeUnknownEffect(ProviderFailurePayload)(payload).pipe(
          Effect.mapError(() =>
            persistedRecordError(
              workspaceId,
              "agent-thread-event",
              `${row.threadId}/${row.eventSequence}`,
              "agent-thread-event-payload-invalid"
            )
          )
        )
      case "review-report":
        return yield* Schema.decodeUnknownEffect(PrReviewReport)(payload).pipe(
          Effect.mapError(() =>
            persistedRecordError(
              workspaceId,
              "agent-thread-event",
              `${row.threadId}/${row.eventSequence}`,
              "agent-thread-event-payload-invalid"
            )
          )
        )
      case "review-suggestion-revised":
        return yield* Schema.decodeUnknownEffect(
          ReviewSuggestionRevisedPayload
        )(payload).pipe(
          Effect.mapError(() =>
            persistedRecordError(
              workspaceId,
              "agent-thread-event",
              `${row.threadId}/${row.eventSequence}`,
              "agent-thread-event-payload-invalid"
            )
          )
        )
      case "review-suggestion-published":
        return yield* Schema.decodeUnknownEffect(ReviewSuggestionPublishedPayload)(payload).pipe(
          Effect.mapError(() =>
            persistedRecordError(
              workspaceId,
              "agent-thread-event",
              `${row.threadId}/${row.eventSequence}`,
              "agent-thread-event-payload-invalid"
            )
          )
        )
      case "job-started":
      case "assistant-output":
      case "progress":
      case "usage":
      case "job-completed":
        return yield* decodeRuntimePayload(workspaceId, row, payload)
    }
  })

  const reviewBudgetState = Effect.fn("AgentJobRepository.reviewBudgetState")(function*(
    workspaceId: typeof WorkspaceId.Type,
    jobId: typeof JobId.Type,
    task: typeof AgentJobTask.Type
  ) {
    if (task._tag !== "pr-review") {
      return { reviewBudgetMillis: undefined, reviewBudgetExtensionCount: 0 }
    }
    const rows = yield* sql<SqlRow>`SELECT
      workspace_id AS workspaceId, thread_id AS threadId,
      event_sequence AS eventSequence, job_id AS jobId,
      attempt_sequence AS attemptSequence, event_kind AS eventKind,
      payload_json AS payloadJson, payload_digest AS payloadDigest,
      payload_byte_length AS payloadByteLength, occurred_at AS occurredAt
      FROM agent_thread_events
      WHERE workspace_id = ${workspaceId}
        AND job_id = ${jobId}
        AND event_kind = 'job-queued'
      ORDER BY event_sequence`.pipe(mapPersistenceOperation("agent-job.review-budget"))
    let reviewBudgetMillis = task.reviewProfile.budgetMillis
    let reviewBudgetExtensionCount = 0
    for (const unknownRow of rows) {
      const row = Schema.decodeUnknownResult(ThreadEventRow)(unknownRow)
      if (Result.isFailure(row)) {
        return yield* persistedRecordError(
          workspaceId,
          "agent-review-budget",
          jobId,
          "agent-review-budget-event-schema-invalid"
        )
      }
      const bytes = yield* bytesFromText(row.success.payloadJson)
      const actualDigest = yield* digestBytes(bytes)
      if (bytes.length !== row.success.payloadByteLength || actualDigest !== row.success.payloadDigest) {
        return yield* persistedRecordError(
          workspaceId,
          "agent-review-budget",
          jobId,
          "agent-review-budget-event-integrity-invalid"
        )
      }
      const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(row.success.payloadJson)
      if (Result.isFailure(parsed)) {
        return yield* persistedRecordError(
          workspaceId,
          "agent-review-budget",
          jobId,
          "agent-review-budget-event-json-invalid"
        )
      }
      const decoded = Schema.decodeUnknownResult(PersistedJobQueuedPayload)(parsed.success)
      if (Result.isFailure(decoded)) {
        const legacy = Schema.decodeUnknownResult(JobQueuedPayload)(parsed.success)
        if (Result.isFailure(legacy)) {
          return yield* persistedRecordError(
            workspaceId,
            "agent-review-budget",
            jobId,
            "agent-review-budget-event-invalid"
          )
        }
        continue
      }
      if (decoded.success.task._tag !== "pr-review") continue
      if (decoded.success.reviewBudgetMillis !== undefined) {
        reviewBudgetMillis = decoded.success.reviewBudgetMillis
        reviewBudgetExtensionCount = decoded.success.reviewBudgetExtensionCount ?? 1
      }
    }
    return { reviewBudgetMillis, reviewBudgetExtensionCount }
  })

  const reviewContextSnapshot = Effect.fn("AgentJobRepository.reviewContextSnapshot")(function*(
    workspaceId: typeof WorkspaceId.Type,
    threadId: typeof AgentThreadId.Type
  ) {
    const rendered = renderAgentReviewContextEventsQuery({
      workspaceId,
      threadId,
      eventKinds: ["user-message", "review-report", "job-completed", "job-failed", "cancel-requested"],
      limit: REVIEW_CONTEXT_EVENT_LIMIT + 1
    })
    const unknownRows = yield* sql
      .unsafe<SqlRow>(rendered.sql, [...rendered.params])
      .pipe(mapPersistenceOperation("agent-job.review-context"))
    const decodedRows = Schema.decodeUnknownResult(
      Schema.Array(ReviewContextThreadEventRow)
    )(unknownRows.slice(0, REVIEW_CONTEXT_EVENT_LIMIT))
    if (Result.isFailure(decodedRows)) {
      return yield* persistedRecordError(
        workspaceId,
        "agent-thread",
        threadId,
        "agent-review-context-schema-invalid"
      )
    }

    type RunDraft = {
      readonly jobId: typeof JobId.Type
      readonly subject: typeof PrReviewSubject.Type
      readonly requestedAt: typeof UtcTimestamp.Type
      readonly state: "cancelled" | "failed" | "interrupted" | "succeeded" | "unknown"
      readonly report: null | typeof PrReviewReport.Type
    }

    const requests = new Array<{
      readonly jobId: typeof JobId.Type
      readonly prompt: typeof AgentJobPrompt.Type
      readonly subjectRevision: string
      readonly requestedAt: typeof UtcTimestamp.Type
    }>()
    const runs = new Map<typeof JobId.Type, RunDraft>()
    const tasks = new Map<typeof JobId.Type, typeof AgentJobTask.Type>()
    for (const row of [...decodedRows.success].reverse()) {
      const cachedTask = tasks.get(row.jobId)
      const task = cachedTask ?? (yield* decodeTaskContext(
        workspaceId,
        row.jobId,
        row.taskContextJson,
        row.taskContextDigest
      ))
      if (cachedTask === undefined) tasks.set(row.jobId, task)
      if (task._tag !== "pr-review") continue
      const current: RunDraft = runs.get(row.jobId) ?? {
        jobId: row.jobId,
        subject: task.subject,
        requestedAt: row.occurredAt,
        state: "unknown",
        report: null
      }
      const payload = yield* decodeEventPayload(workspaceId, row)
      switch (row.eventKind) {
        case "user-message": {
          const message = yield* Schema.decodeUnknownEffect(UserMessagePayload)(payload).pipe(
            Effect.mapError(() =>
              persistedRecordError(
                workspaceId,
                "agent-thread-event",
                `${row.threadId}/${row.eventSequence}`,
                "agent-review-context-message-invalid"
              )
            )
          )
          requests.push({
            jobId: row.jobId,
            prompt: message.prompt,
            subjectRevision: task.subject.headRevision,
            requestedAt: row.occurredAt
          })
          runs.set(row.jobId, { ...current, requestedAt: row.occurredAt })
          break
        }
        case "review-report": {
          const report = yield* Schema.decodeUnknownEffect(PrReviewReport)(payload).pipe(
            Effect.mapError(() =>
              persistedRecordError(
                workspaceId,
                "agent-thread-event",
                `${row.threadId}/${row.eventSequence}`,
                "agent-review-context-report-invalid"
              )
            )
          )
          runs.set(row.jobId, { ...current, report, state: "succeeded" })
          break
        }
        case "job-completed": {
          const runtimeEvent = yield* Schema.decodeUnknownEffect(AgentRuntimeEvent)(payload).pipe(
            Effect.mapError(() =>
              persistedRecordError(
                workspaceId,
                "agent-thread-event",
                `${row.threadId}/${row.eventSequence}`,
                "agent-review-context-outcome-invalid"
              )
            )
          )
          if (runtimeEvent._tag !== "completed") {
            return yield* persistedRecordError(
              workspaceId,
              "agent-thread-event",
              `${row.threadId}/${row.eventSequence}`,
              "agent-review-context-outcome-invalid"
            )
          }
          runs.set(row.jobId, {
            ...current,
            state: runtimeEvent.outcome === "cancelled" ? "cancelled" : "succeeded"
          })
          break
        }
        case "job-failed": {
          const failure = yield* Schema.decodeUnknownEffect(ProviderFailurePayload)(payload)
          runs.set(row.jobId, {
            ...current,
            state: failure.error.message === PROCESS_RESTART_INTERRUPTION_MESSAGE ? "interrupted" : "failed"
          })
          break
        }
        case "cancel-requested":
          if (row.jobState === "cancelled") {
            runs.set(row.jobId, { ...current, state: "cancelled" })
          }
          break
        default:
          break
      }
    }

    const allRuns = Array.from(runs.values())
    const selectedRuns = allRuns.slice(-REVIEW_CONTEXT_ITEM_LIMIT)
    const recentRequests = requests.slice(-REVIEW_CONTEXT_ITEM_LIMIT)
    const boundedText = (value: string, maximum: number): string => value.slice(0, maximum).trim()
    return yield* Schema.decodeUnknownEffect(Schema.toType(PrReviewThreadContextSnapshot))({
      recentRequests,
      priorRuns: selectedRuns.map(({ jobId, report, requestedAt, state, subject }) => ({
        jobId,
        subject,
        requestedAt,
        state,
        suggestionTitles: report?.suggestions
          .slice(0, REVIEW_CONTEXT_REPORT_ITEM_LIMIT)
          .map(({ title }) => boundedText(title, 500)) ?? [],
        suggestionsTruncated: (report?.suggestions.length ?? 0) > REVIEW_CONTEXT_REPORT_ITEM_LIMIT,
        noteTitles: report?.notes
          .slice(0, REVIEW_CONTEXT_REPORT_ITEM_LIMIT)
          .map(({ title }) => boundedText(title, 500)) ?? [],
        notesTruncated: (report?.notes.length ?? 0) > REVIEW_CONTEXT_REPORT_ITEM_LIMIT,
        limitation: report?.completion.status === "unable-to-conclude"
          ? boundedText(report.completion.reason, 1_000)
          : null
      })),
      historyTruncated: unknownRows.length > REVIEW_CONTEXT_EVENT_LIMIT ||
        requests.length > REVIEW_CONTEXT_ITEM_LIMIT ||
        allRuns.length > REVIEW_CONTEXT_ITEM_LIMIT
    })
  })

  const fitPrReviewTask = Effect.fn("AgentJobRepository.fitPrReviewTask")(function*(
    request: typeof EnqueueAgentJobInput.Type,
    snapshot: typeof PrReviewThreadContextSnapshot.Type
  ) {
    if (request.task._tag !== "pr-review") {
      return yield* new PersistenceOperationError({
        operation: "agent-job.fit-review-task-mismatch"
      })
    }
    let context = snapshot
    while (true) {
      const task = yield* Schema.decodeUnknownEffect(Schema.toType(AgentJobTask))({
        ...request.task,
        context
      }).pipe(
        Effect.mapError(() =>
          new PersistenceOperationError({
            operation: "agent-job.encode-payload"
          })
        )
      )
      const taskContext = yield* Effect.result(encodePayload(AgentJobTask, task))
      const queuedPayload = yield* Effect.result(encodePayload(PersistedJobQueuedPayload, {
        access: request.access,
        contextFingerprint: request.contextFingerprint,
        model: request.model,
        providerId: request.providerId,
        subjectRevision: request.subjectRevision,
        task
      }))
      const attemptContext = yield* Schema.decodeUnknownEffect(
        Schema.toType(AgentContextSnapshotRecord)
      )({
        workspaceId: request.workspaceId,
        releaseId: request.releaseId,
        subjectRevision: request.subjectRevision,
        fingerprint: request.contextFingerprint,
        task
      }).pipe(
        Effect.mapError(() =>
          new PersistenceOperationError({
            operation: "agent-job.encode-payload"
          })
        )
      )
      const attemptContextPayload = yield* Effect.result(
        encodePayload(AgentContextSnapshotRecord, attemptContext)
      )
      if (
        Result.isSuccess(taskContext) &&
        Result.isSuccess(queuedPayload) &&
        Result.isSuccess(attemptContextPayload)
      ) {
        return { task, taskContext: taskContext.success }
      }
      const failure = Result.isFailure(taskContext)
        ? taskContext.failure
        : Result.isFailure(queuedPayload)
        ? queuedPayload.failure
        : Result.isFailure(attemptContextPayload)
        ? attemptContextPayload.failure
        : null
      if (failure === null || failure.operation !== "agent-job.event-too-large") {
        return yield* (failure ?? new PersistenceOperationError({
          operation: "agent-job.fit-review-task"
        }))
      }
      if (context.priorRuns.length > 0) {
        context = PrReviewThreadContextSnapshot.make({
          ...context,
          priorRuns: context.priorRuns.slice(1),
          historyTruncated: true
        })
        continue
      }
      if (context.recentRequests.length > 0) {
        context = PrReviewThreadContextSnapshot.make({
          ...context,
          recentRequests: context.recentRequests.slice(1),
          historyTruncated: true
        })
        continue
      }
      return yield* failure
    }
  })

  const readReviewResult = Effect.fnUntraced(function*(
    input: typeof AgentReviewResultInput.Type
  ) {
    const request = yield* Schema.decodeUnknownEffect(Schema.toType(AgentReviewResultInput))(input)
    const rows = yield* sql<SqlRow>`SELECT
      workspace_id AS workspaceId, thread_id AS threadId,
      event_sequence AS eventSequence, job_id AS jobId,
      attempt_sequence AS attemptSequence, event_kind AS eventKind,
      payload_json AS payloadJson, payload_digest AS payloadDigest,
      payload_byte_length AS payloadByteLength, occurred_at AS occurredAt
      FROM agent_thread_events
      WHERE workspace_id = ${request.workspaceId}
        AND job_id = ${request.jobId}
        AND event_kind = 'review-report'
      ORDER BY event_sequence DESC
      LIMIT 1`.pipe(mapPersistenceOperation("agent-job.review-result"))
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId: request.workspaceId,
        recordKind: "agent-review-result",
        recordKey: request.jobId
      })
    }
    const row = Schema.decodeUnknownResult(ThreadEventRow)(rows[0])
    if (Result.isFailure(row) || row.success.attemptSequence === null) {
      return yield* persistedRecordError(
        request.workspaceId,
        "agent-review-result",
        request.jobId,
        "agent-review-result-schema-invalid"
      )
    }
    const report = yield* decodeEventPayload(request.workspaceId, row.success)
    const decodedReport = Schema.decodeUnknownResult(PrReviewReport)(report)
    if (Result.isFailure(decodedReport)) {
      return yield* persistedRecordError(
        request.workspaceId,
        "agent-review-result",
        request.jobId,
        "agent-review-result-payload-invalid"
      )
    }
    const publicationRows = yield* sql<SqlRow>`SELECT
      workspace_id AS workspaceId, thread_id AS threadId,
      event_sequence AS eventSequence, job_id AS jobId,
      attempt_sequence AS attemptSequence, event_kind AS eventKind,
      payload_json AS payloadJson, payload_digest AS payloadDigest,
      payload_byte_length AS payloadByteLength, occurred_at AS occurredAt
      FROM agent_thread_events
      WHERE workspace_id = ${request.workspaceId}
        AND job_id = ${request.jobId}
        AND event_kind = 'review-suggestion-published'
      ORDER BY event_sequence`.pipe(
      mapPersistenceOperation("agent-job.review-suggestion-publications")
    )
    const publishedSuggestionIds = new Set<string>()
    for (const unknownPublicationRow of publicationRows) {
      const publicationRow = Schema.decodeUnknownResult(ThreadEventRow)(unknownPublicationRow)
      if (Result.isFailure(publicationRow)) {
        return yield* persistedRecordError(
          request.workspaceId,
          "agent-review-result",
          request.jobId,
          "agent-review-publication-schema-invalid"
        )
      }
      const publication = yield* decodeEventPayload(request.workspaceId, publicationRow.success)
      const decodedPublication = Schema.decodeUnknownResult(
        ReviewSuggestionPublishedPayload
      )(publication)
      if (Result.isFailure(decodedPublication)) {
        return yield* persistedRecordError(
          request.workspaceId,
          "agent-review-result",
          request.jobId,
          "agent-review-publication-payload-invalid"
        )
      }
      publishedSuggestionIds.add(decodedPublication.success.suggestionId)
    }
    const lifecycleRows = yield* sql<SqlRow>`SELECT
      revision.suggestion_id AS suggestionId,
      revision.revision_json AS revisionJson,
      revision.revision_digest AS revisionDigest
      FROM agent_review_suggestion_revisions revision
      WHERE revision.workspace_id = ${request.workspaceId}
        AND revision.source_job_id = ${request.jobId}
        AND NOT EXISTS (
          SELECT 1
          FROM agent_review_suggestion_revisions newer
          WHERE newer.workspace_id = revision.workspace_id
            AND newer.source_job_id = revision.source_job_id
            AND newer.suggestion_id = revision.suggestion_id
            AND newer.revision_sequence > revision.revision_sequence
        )`.pipe(
      mapPersistenceOperation("agent-job.review-suggestion-lifecycle-revisions")
    )
    const latestSuggestionById = new Map<string, typeof PrReviewSuggestion.Type>()
    for (const unknownLifecycleRow of lifecycleRows) {
      const lifecycleRow = Schema.decodeUnknownResult(
        ReviewSuggestionLifecycleRevisionRow
      )(unknownLifecycleRow)
      if (Result.isFailure(lifecycleRow)) {
        return yield* persistedRecordError(
          request.workspaceId,
          "agent-review-result",
          request.jobId,
          "agent-review-lifecycle-revision-schema-invalid"
        )
      }
      const bytes = yield* bytesFromText(lifecycleRow.success.revisionJson)
      if ((yield* digestBytes(bytes)) !== lifecycleRow.success.revisionDigest) {
        return yield* persistedRecordError(
          request.workspaceId,
          "agent-review-result",
          request.jobId,
          "agent-review-lifecycle-revision-integrity-invalid"
        )
      }
      const revision = Schema.decodeUnknownResult(
        Schema.fromJsonString(PrReviewSuggestionRevision)
      )(lifecycleRow.success.revisionJson)
      if (
        Result.isFailure(revision) ||
        revision.success.sourceJobId !== request.jobId ||
        revision.success.suggestion.suggestionId !== lifecycleRow.success.suggestionId ||
        !PrReviewSubjectEquivalence(revision.success.subject, decodedReport.success.subject)
      ) {
        return yield* persistedRecordError(
          request.workspaceId,
          "agent-review-result",
          request.jobId,
          "agent-review-lifecycle-revision-payload-invalid"
        )
      }
      latestSuggestionById.set(lifecycleRow.success.suggestionId, revision.success.suggestion)
    }
    if (publishedSuggestionIds.size === 0 && latestSuggestionById.size === 0) {
      return yield* Schema.decodeUnknownEffect(Schema.toType(AgentReviewResultRecord))({
        workspaceId: request.workspaceId,
        jobId: request.jobId,
        attemptSequence: row.success.attemptSequence,
        report: decodedReport.success,
        completedAt: row.success.occurredAt
      })
    }
    const projectedReport = yield* Schema.decodeUnknownEffect(Schema.toType(PrReviewReport))({
      ...decodedReport.success,
      suggestions: decodedReport.success.suggestions.map((suggestion) => {
        const latest = latestSuggestionById.get(suggestion.suggestionId) ?? suggestion
        const state = publishedSuggestionIds.has(suggestion.suggestionId)
          ? "published"
          : latest.state
        return state === latest.state ? latest : { ...latest, state }
      })
    }).pipe(
      Effect.mapError(() =>
        persistedRecordError(
          request.workspaceId,
          "agent-review-result",
          request.jobId,
          "agent-review-lifecycle-projection-invalid"
        )
      )
    )
    return yield* Schema.decodeUnknownEffect(Schema.toType(AgentReviewResultRecord))({
      workspaceId: request.workspaceId,
      jobId: request.jobId,
      attemptSequence: row.success.attemptSequence,
      report: projectedReport,
      completedAt: row.success.occurredAt
    })
  }, Effect.withTracerEnabled(false))

  const readOriginalReviewResult = Effect.fn(
    "AgentJobRepository.readOriginalReviewResult"
  )(function*(input: typeof AgentReviewResultInput.Type) {
    const request = yield* Schema.decodeUnknownEffect(
      Schema.toType(AgentReviewResultInput)
    )(input)
    const rows = yield* sql<SqlRow>`SELECT
      workspace_id AS workspaceId, thread_id AS threadId,
      event_sequence AS eventSequence, job_id AS jobId,
      attempt_sequence AS attemptSequence, event_kind AS eventKind,
      payload_json AS payloadJson, payload_digest AS payloadDigest,
      payload_byte_length AS payloadByteLength, occurred_at AS occurredAt
      FROM agent_thread_events
      WHERE workspace_id = ${request.workspaceId}
        AND job_id = ${request.jobId}
        AND event_kind = 'review-report'
      ORDER BY event_sequence ASC
      LIMIT 1`.pipe(
      mapPersistenceOperation("agent-job.original-review-result")
    )
    if (rows.length === 0) {
      return yield* new RecordNotFoundError({
        workspaceId: request.workspaceId,
        recordKind: "agent-review-result",
        recordKey: request.jobId
      })
    }
    const row = Schema.decodeUnknownResult(ThreadEventRow)(rows[0])
    if (
      Result.isFailure(row) ||
      row.success.attemptSequence === null
    ) {
      return yield* persistedRecordError(
        request.workspaceId,
        "agent-review-result",
        request.jobId,
        "agent-review-original-result-schema-invalid"
      )
    }
    const report = Schema.decodeUnknownResult(
      PrReviewReport
    )(yield* decodeEventPayload(request.workspaceId, row.success))
    if (Result.isFailure(report)) {
      return yield* persistedRecordError(
        request.workspaceId,
        "agent-review-result",
        request.jobId,
        "agent-review-original-result-payload-invalid"
      )
    }
    return yield* Schema.decodeUnknownEffect(
      Schema.toType(AgentReviewResultRecord)
    )({
      workspaceId: request.workspaceId,
      jobId: request.jobId,
      attemptSequence: row.success.attemptSequence,
      report: report.success,
      completedAt: row.success.occurredAt
    })
  })

  const findPreviousReviewReport = Effect.fn("AgentJobRepository.findPreviousReviewReport")(function*(input: {
    readonly workspaceId: typeof WorkspaceId.Type
    readonly pluginConnectionId: typeof PluginConnectionId.Type
    readonly subject: typeof PrReviewSubject.Type
    readonly excludeJobId: typeof JobId.Type
  }) {
    const subjectJson = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(PrReviewSubject))(input.subject).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.previous-review-subject" }))
    )
    const taskContextPrefix =
      `{"_tag":"pr-review","pluginConnectionId":"${input.pluginConnectionId}","subject":${subjectJson},"reviewProfile":`
    const identityPrefix = taskContextPrefix.slice(0, taskContextPrefix.indexOf("\"baseRevision\""))
    const rendered = renderLatestAgentReviewQuery({
      workspaceId: input.workspaceId,
      taskContextPrefix: identityPrefix,
      excludeTargeted: true,
      excludeJobId: input.excludeJobId,
      excludeSubjectRevision: input.subject.headRevision,
      limit: 32
    })
    const rows = yield* sql
      .unsafe<SqlRow>(rendered.sql, [...rendered.params])
      .pipe(mapPersistenceOperation("agent-job.previous-review"))
    for (const rawRow of rows) {
      const row = Schema.decodeUnknownResult(LatestReviewRow)(rawRow)
      if (Result.isFailure(row)) {
        return yield* persistedRecordError(
          input.workspaceId,
          "agent-review",
          input.subject.pullRequestId,
          "agent-review-previous-schema-invalid"
        )
      }
      if (row.success.state !== "succeeded" && row.success.state !== "failed" && row.success.state !== "cancelled") {
        continue
      }
      const result = yield* readReviewResult({ workspaceId: input.workspaceId, jobId: row.success.jobId }).pipe(
        Effect.catchTag("RecordNotFoundError", () => Effect.succeed(null))
      )
      if (result !== null && result.report !== null) {
        return Option.some({ jobId: row.success.jobId, report: result.report })
      }
    }
    return Option.none<{ readonly jobId: typeof JobId.Type; readonly report: typeof PrReviewReport.Type }>()
  })

  const decodeThreadEventRows = Effect.fn("AgentJobRepository.decodeThreadEventRows")(function*(
    workspaceId: typeof WorkspaceId.Type,
    threadId: typeof AgentThreadId.Type,
    rows: ReadonlyArray<SqlRow>
  ) {
    const decodedRows = yield* Schema.decodeUnknownEffect(
      Schema.Array(ReplayThreadEventRow)
    )(rows).pipe(
      Effect.mapError(() =>
        persistedRecordError(
          workspaceId,
          "agent-thread",
          threadId,
          "agent-thread-event-schema-invalid"
        )
      )
    )
    const tasksByJob = new Map<typeof JobId.Type, typeof AgentJobTask.Type>()
    return yield* Effect.forEach(
      decodedRows,
      (row) =>
        Effect.gen(function*() {
          const payload = yield* decodeEventPayload(workspaceId, row)
          let task = tasksByJob.get(row.jobId)
          if (task === undefined) {
            task = yield* decodeTaskContext(
              workspaceId,
              row.jobId,
              row.taskContextJson,
              row.taskContextDigest
            )
            tasksByJob.set(row.jobId, task)
          }
          const presentedTask = task._tag === "release-chat"
            ? task
            : {
              _tag: task._tag,
              pluginConnectionId: task.pluginConnectionId,
              subject: task.subject,
              reviewProfile: task.reviewProfile
            }
          return yield* Schema.decodeUnknownEffect(Schema.toType(AgentThreadEvent))({
            workspaceId: row.workspaceId,
            threadId: row.threadId,
            eventSequence: row.eventSequence,
            jobId: row.jobId,
            attemptSequence: row.attemptSequence,
            task: presentedTask,
            eventKind: row.eventKind,
            payload,
            occurredAt: row.occurredAt
          })
        })
    )
  })

  const threadEventsAfter = Effect.fn("AgentJobRepository.threadEventsAfter")(function*(
    workspaceId: typeof WorkspaceId.Type,
    threadId: typeof AgentThreadId.Type,
    after: typeof AgentEventCursor.Type,
    limit: typeof AgentThreadEventPageSize.Type
  ) {
    const replay = renderAgentThreadReplayQuery({
      workspaceId,
      threadId,
      afterSequence: after,
      limit
    })
    const rows = yield* sql
      .unsafe<SqlRow>(replay.sql, [...replay.params])
      .pipe(mapPersistenceOperation("agent-job.thread-after"))
    const events = yield* decodeThreadEventRows(workspaceId, threadId, rows)
    return {
      events,
      nextCursor: events.at(-1)?.eventSequence ?? after
    }
  })

  const threadEventsBefore = Effect.fn("AgentJobRepository.threadEventsBefore")(function*(
    workspaceId: typeof WorkspaceId.Type,
    threadId: typeof AgentThreadId.Type,
    before: typeof AgentEventCursor.Type,
    limit: typeof AgentThreadEventPageSize.Type
  ) {
    const history = renderAgentThreadBeforeQuery({
      workspaceId,
      threadId,
      beforeSequence: before,
      limit
    })
    const rows = yield* sql
      .unsafe<SqlRow>(history.sql, [...history.params])
      .pipe(mapPersistenceOperation("agent-job.thread-before"))
    const events = yield* decodeThreadEventRows(
      workspaceId,
      threadId,
      [...rows].reverse()
    )
    return {
      events,
      nextCursor: events[0]?.eventSequence ?? before
    }
  })

  const threadEventsTail = Effect.fn("AgentJobRepository.threadEventsTail")(function*(
    workspaceId: typeof WorkspaceId.Type,
    threadId: typeof AgentThreadId.Type,
    limit: typeof AgentThreadEventPageSize.Type
  ) {
    const tail = renderAgentThreadTailQuery({
      workspaceId,
      threadId,
      limit
    })
    const rows = yield* sql
      .unsafe<SqlRow>(tail.sql, [...tail.params])
      .pipe(mapPersistenceOperation("agent-job.thread-tail"))
    const events = yield* decodeThreadEventRows(
      workspaceId,
      threadId,
      [...rows].reverse()
    )
    return {
      events,
      nextCursor: events.at(-1)?.eventSequence ?? AgentEventCursor.make(0)
    }
  })

  const reviewSuggestionRevisions = makeReviewSuggestionRevisionOperations({
    database,
    bytesFromText,
    digestBytes,
    readReviewResult: readOriginalReviewResult,
    getJob,
    appendThreadEvent: (options) => appendThreadEvent(options)
  })

  const currentPublishableReviewSuggestion = Effect.fn(
    "AgentJobRepository.currentPublishableReviewSuggestion"
  )(function*(input: {
    readonly workspaceId: typeof WorkspaceId.Type
    readonly jobId: typeof JobId.Type
    readonly suggestionId: typeof RecordReviewSuggestionPublicationInput.fields.suggestionId.Type
    readonly revisionId: typeof RecordReviewSuggestionPublicationInput.fields.revisionId.Type
  }) {
    const current = (yield* reviewSuggestionRevisions.read({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      suggestionId: input.suggestionId,
      beforeSequence: null,
      limit: PrReviewSuggestionRevisionPageSize.make(1)
    })).current
    if (
      current.revisionId !== input.revisionId ||
      current.suggestion.state !== "draft" ||
      current.validation._tag !== "validated"
    ) {
      return yield* new AgentJobInputError({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        reason: "invalid-transition"
      })
    }
    return current
  })

  const currentPublishedReviewSuggestion = Effect.fn(
    "AgentJobRepository.currentPublishedReviewSuggestion"
  )(function*(input: {
    readonly workspaceId: typeof WorkspaceId.Type
    readonly jobId: typeof JobId.Type
    readonly suggestionId: typeof RecordReviewSuggestionPublicationInput.fields.suggestionId.Type
    readonly revisionId: typeof RecordReviewSuggestionPublicationInput.fields.revisionId.Type
  }) {
    const current = (yield* reviewSuggestionRevisions.read({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      suggestionId: input.suggestionId,
      beforeSequence: null,
      limit: PrReviewSuggestionRevisionPageSize.make(1)
    })).current
    if (
      current.revisionId !== input.revisionId ||
      current.suggestion.state !== "published" ||
      current.validation._tag !== "validated"
    ) {
      return yield* new AgentJobInputError({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        reason: "invalid-transition"
      })
    }
    return current
  })

  return {
    appendReviewSuggestionRevision: Effect.fn(
      "AgentJobRepository.appendReviewSuggestionRevision"
    )(function*(input: typeof AppendReviewSuggestionRevisionInput.Type) {
      return yield* reviewSuggestionRevisions.append(input).pipe(
        mapPersistenceOperation("agent-job.append-review-suggestion-revision")
      )
    }),

    completeTargetedReview: Effect.fn(
      "AgentJobRepository.completeTargetedReview"
    )(function*(input: typeof CompleteTargetedReviewInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.toType(CompleteTargetedReviewInput)
      )(input)
      const report = yield* Schema.decodeUnknownEffect(Schema.toType(PrReviewReport))(request.target.report).pipe(
        Effect.mapError(() =>
          new AgentJobInputError({
            workspaceId: request.target.workspaceId,
            jobId: request.target.jobId,
            reason: "invalid-result"
          })
        )
      )
      const encodedReport = yield* encodeReviewReport(report).pipe(
        Effect.mapError(() =>
          new AgentJobInputError({
            workspaceId: request.target.workspaceId,
            jobId: request.target.jobId,
            reason: "invalid-result"
          })
        )
      )
      return yield* database.transaction(
        Effect.gen(function*() {
          const job = yield* getJob(request.target.workspaceId, request.target.jobId)
          if (job.state === "cancel-requested") {
            return yield* new AgentJobInputError({
              workspaceId: request.target.workspaceId,
              jobId: request.target.jobId,
              reason: "cancellation-requested"
            })
          }
          if (
            job.state !== "running" ||
            job.task._tag !== "pr-review" ||
            job.subjectRevision !== job.task.subject.headRevision ||
            !PrReviewSubjectEquivalence(job.task.subject, report.subject)
          ) {
            return yield* new AgentJobInputError({
              workspaceId: request.target.workspaceId,
              jobId: request.target.jobId,
              reason: "task-mismatch"
            })
          }
          yield* validateLease({
            workspaceId: request.target.workspaceId,
            jobId: request.target.jobId,
            attemptSequence: request.target.attemptSequence,
            leaseToken: request.target.leaseToken,
            observedAt: request.target.completedAt
          })
          const revision = yield* reviewSuggestionRevisions.appendInTransaction(request.source)
          const eventSequence = yield* reserveEventSequence(
            request.target.workspaceId,
            job.threadId
          )
          yield* sql`INSERT INTO agent_thread_events (
            workspace_id, thread_id, event_sequence, job_id, attempt_sequence,
            event_kind, payload_json, payload_digest, payload_byte_length, occurred_at
          ) VALUES (
            ${request.target.workspaceId}, ${job.threadId}, ${eventSequence},
            ${request.target.jobId}, ${request.target.attemptSequence}, 'review-report',
            ${encodedReport.json}, ${encodedReport.digest}, ${encodedReport.bytes.length},
            ${encodeTimestamp(request.target.completedAt)}
          )`
          yield* appendThreadEvent({
            workspaceId: request.target.workspaceId,
            threadId: job.threadId,
            jobId: request.target.jobId,
            attemptSequence: request.target.attemptSequence,
            eventKind: "job-completed",
            payload: { _tag: "completed", outcome: "success", sessionRef: null },
            payloadSchema: AgentRuntimeEvent,
            occurredAt: request.target.completedAt
          })
          yield* completeAttempt({
            workspaceId: request.target.workspaceId,
            jobId: request.target.jobId,
            attemptSequence: request.target.attemptSequence,
            completedAt: request.target.completedAt,
            outcome: "success",
            state: "succeeded",
            sessionRef: null,
            errorJson: null
          })
          return revision
        })
      ).pipe(mapPersistenceOperation("agent-job.complete-targeted-review"))
    }),

    enqueue: Effect.fn("AgentJobRepository.enqueue")(function*(input: typeof EnqueueAgentJobInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(EnqueueAgentJobInput))(input)
      if (
        request.task._tag === "pr-review" &&
        (request.access !== "read-only" || request.subjectRevision !== request.task.subject.headRevision)
      ) {
        return yield* new AgentJobInputError({
          workspaceId: request.workspaceId,
          jobId: request.jobId,
          reason: "task-mismatch"
        })
      }
      const candidateThreadId = yield* cryptoService.randomUUIDv7.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AgentThreadId)),
        Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.thread-id" }))
      )
      const threadKind = request.task._tag
      let subjectKey: string
      if (request.task._tag === "release-chat") {
        if (request.releaseId === null) {
          return yield* new AgentJobInputError({
            workspaceId: request.workspaceId,
            jobId: request.jobId,
            reason: "task-mismatch"
          })
        }
        subjectKey = request.releaseId
      } else {
        subjectKey = yield* reviewThreadSubjectKey(
          request.task.pluginConnectionId,
          request.task.subject
        )
      }
      return yield* database
        .transaction(
          Effect.gen(function*() {
            if (request.releaseId !== null) {
              const releaseRows = yield* sql`SELECT release_id FROM releases
            WHERE workspace_id = ${request.workspaceId} AND release_id = ${request.releaseId}`
              if (releaseRows.length === 0) {
                return yield* new RecordNotFoundError({
                  workspaceId: request.workspaceId,
                  recordKind: "release",
                  recordKey: request.releaseId
                })
              }
            }
            const threadReleaseId = request.task._tag === "release-chat"
              ? request.releaseId
              : null
            yield* sql`INSERT INTO agent_threads (
          workspace_id, thread_id, thread_kind, subject_key, release_id,
          next_event_sequence, created_at
        ) VALUES (
          ${request.workspaceId}, ${candidateThreadId}, ${threadKind}, ${subjectKey},
          ${threadReleaseId}, 1,
          ${encodeTimestamp(request.createdAt)}
        ) ON CONFLICT (workspace_id, thread_kind, subject_key) DO NOTHING`
            const thread = yield* findThread(request.workspaceId, threadKind, subjectKey)
            if (Option.isNone(thread)) {
              return yield* new PersistenceOperationError({ operation: "agent-job.find-thread" })
            }
            const fitted = request.task._tag === "release-chat"
              ? {
                task: request.task,
                taskContext: yield* encodePayload(AgentJobTask, request.task)
              }
              : yield* fitPrReviewTask(
                request,
                yield* reviewContextSnapshot(
                  request.workspaceId,
                  thread.value.threadId
                )
              )
            const { task, taskContext } = fitted
            yield* sql`INSERT INTO agent_jobs (
          workspace_id, job_id, thread_id, release_id, provider_id, model, access, prompt,
          context_fingerprint, subject_revision, task_context_json, task_context_digest, state, created_at,
          cancel_requested_at, terminal_at
        ) VALUES (
          ${request.workspaceId}, ${request.jobId}, ${thread.value.threadId},
          ${request.releaseId}, ${request.providerId}, ${request.model},
          ${request.access}, ${request.prompt},
          ${request.contextFingerprint}, ${request.subjectRevision}, ${taskContext.json}, ${taskContext.digest}, 'queued',
          ${encodeTimestamp(request.createdAt)}, NULL, NULL
        )`
            yield* appendThreadEvent({
              workspaceId: request.workspaceId,
              threadId: thread.value.threadId,
              jobId: request.jobId,
              attemptSequence: null,
              eventKind: "user-message",
              payload: { prompt: request.userPrompt },
              payloadSchema: UserMessagePayload,
              occurredAt: request.createdAt
            })
            yield* appendThreadEvent({
              workspaceId: request.workspaceId,
              threadId: thread.value.threadId,
              jobId: request.jobId,
              attemptSequence: null,
              eventKind: "job-queued",
              payload: {
                access: request.access,
                contextFingerprint: request.contextFingerprint,
                model: request.model,
                providerId: request.providerId,
                subjectRevision: request.subjectRevision,
                task
              },
              payloadSchema: PersistedJobQueuedPayload,
              occurredAt: request.createdAt
            })
            return thread.value.threadId
          })
        )
        .pipe(
          mapAlreadyExists({
            workspaceId: request.workspaceId,
            recordKind: "agent-job",
            recordKey: request.jobId
          }),
          mapPersistenceOperation("agent-job.enqueue")
        )
    }),

    claimNext: Effect.fn("AgentJobRepository.claimNext")(function*(input: typeof ClaimAgentJobInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(ClaimAgentJobInput))(input)
      return yield* database
        .transaction(
          Effect.gen(function*() {
            const claimedAt = yield* DateTime.now
            const observedAt = encodeTimestamp(claimedAt)
            const dispatch = renderAgentJobDispatchCandidatesQuery({
              workspaceId: request.workspaceId,
              observedAt,
              taskTags: request.taskTags,
              limit: DISPATCH_CANDIDATE_LIMIT
            })
            const candidateRows = yield* sql.unsafe<SqlRow>(dispatch.sql, [...dispatch.params])
            const candidates = Schema.decodeUnknownResult(Schema.Array(DispatchCandidateRow))(candidateRows)
            if (Result.isFailure(candidates)) {
              return yield* persistedRecordError(
                request.workspaceId,
                "agent-job",
                request.workspaceId,
                "agent-job-dispatch-schema-invalid"
              )
            }
            for (const candidate of candidates.success) {
              const task = yield* decodeTaskContext(
                request.workspaceId,
                candidate.jobId,
                candidate.taskContextJson,
                candidate.taskContextDigest
              )
              if (!request.taskTags.includes(task._tag)) continue
              if (DateTime.Order(claimedAt, request.leaseExpiresAt) >= 0) {
                return yield* new AgentJobInputError({
                  workspaceId: request.workspaceId,
                  jobId: candidate.jobId,
                  reason: "invalid-transition"
                })
              }
              const claim = renderAgentJobClaimQuery({
                workspaceId: request.workspaceId,
                jobId: candidate.jobId,
                expectedAttemptSequence: candidate.attemptSequence,
                expectedState: candidate.state satisfies ClaimableAgentJobState,
                observedAt
              })
              const claimedRows = yield* sql.unsafe<SqlRow>(claim.sql, [...claim.params])
              if (claimedRows.length === 0) continue
              const claimed = Schema.decodeUnknownResult(JobRow)(claimedRows[0])
              if (Result.isFailure(claimed)) {
                return yield* persistedRecordError(
                  request.workspaceId,
                  "agent-job",
                  candidate.jobId,
                  "agent-job-schema-invalid"
                )
              }
              const context = yield* Schema.decodeUnknownEffect(Schema.toType(AgentContextSnapshotRecord))({
                workspaceId: request.workspaceId,
                releaseId: claimed.success.releaseId,
                subjectRevision: claimed.success.subjectRevision,
                fingerprint: claimed.success.contextFingerprint,
                task
              })
              const reviewBudget = yield* reviewBudgetState(
                request.workspaceId,
                candidate.jobId,
                task
              )
              const contextPayload = yield* encodePayload(AgentContextSnapshotRecord, context)
              let sessionRef: null | typeof ClaimedAgentJob.fields.sessionRef.Type = null
              if (candidate.attemptSequence > 0) {
                const previousRows = yield* sql<SqlRow>`SELECT
              context_snapshot_json AS contextSnapshotJson,
              context_snapshot_digest AS contextSnapshotDigest,
              session_ref AS sessionRef
              FROM agent_job_attempts
              WHERE workspace_id = ${request.workspaceId}
                AND job_id = ${candidate.jobId}
                AND attempt_sequence = ${candidate.attemptSequence}`
                const previous = Schema.decodeUnknownResult(PreviousAttemptRow)(previousRows[0])
                const previousContext = Result.isSuccess(previous)
                  ? Schema.decodeUnknownResult(Schema.fromJsonString(AgentContextSnapshotRecord))(
                    previous.success.contextSnapshotJson
                  )
                  : null
                if (
                  Result.isFailure(previous) ||
                  previousContext === null ||
                  Result.isFailure(previousContext) ||
                  previous.success.contextSnapshotDigest !== contextPayload.digest ||
                  previous.success.contextSnapshotJson !== contextPayload.json
                ) {
                  return yield* persistedRecordError(
                    request.workspaceId,
                    "agent-job-attempt",
                    `${candidate.jobId}/${candidate.attemptSequence}`,
                    "agent-job-context-invalid"
                  )
                }
                sessionRef = previous.success.sessionRef
              }
              const attemptSequence = yield* Schema.decodeUnknownEffect(AgentAttemptSequence)(
                candidate.attemptSequence + 1
              )
              yield* sql`INSERT INTO agent_job_attempts (
            workspace_id, job_id, attempt_sequence, context_snapshot_json,
            context_snapshot_digest, output_bytes, provider_run_ref, session_ref,
            started_at, completed_at, outcome, error_json
          ) VALUES (
            ${request.workspaceId}, ${candidate.jobId}, ${attemptSequence},
            ${contextPayload.json}, ${contextPayload.digest}, 0, NULL, ${sessionRef},
            ${observedAt}, NULL, NULL, NULL
          )`
              yield* sql`INSERT INTO agent_job_leases (
            workspace_id, job_id, attempt_sequence, lease_owner, lease_token,
            acquired_at, last_renewed_at, lease_expires_at
          ) VALUES (
            ${request.workspaceId}, ${candidate.jobId}, ${attemptSequence},
            ${request.leaseOwner}, ${request.leaseToken}, ${observedAt}, ${observedAt},
            ${encodeTimestamp(request.leaseExpiresAt)}
          )`
              const claimedJob = yield* Schema.decodeUnknownEffect(Schema.toType(ClaimedAgentJob))({
                workspaceId: request.workspaceId,
                releaseId: claimed.success.releaseId,
                threadId: claimed.success.threadId,
                jobId: candidate.jobId,
                attemptSequence,
                leaseOwner: request.leaseOwner,
                leaseToken: request.leaseToken,
                leaseExpiresAt: request.leaseExpiresAt,
                providerId: claimed.success.providerId,
                model: claimed.success.model,
                access: claimed.success.access,
                prompt: claimed.success.prompt,
                context,
                ...(!(reviewBudget.reviewBudgetMillis === undefined) &&
                  { reviewBudgetMillis: reviewBudget.reviewBudgetMillis }),
                reviewBudgetExtensionCount: reviewBudget.reviewBudgetExtensionCount,
                sessionRef,
                cancellationRequested: claimed.success.state === "cancel-requested"
              })
              return Option.some(claimedJob)
            }
            return Option.none<typeof ClaimedAgentJob.Type>()
          })
        )
        .pipe(mapPersistenceOperation("agent-job.claim-next"))
    }),

    isLeaseActive: Effect.fn("AgentJobRepository.isLeaseActive")((
      workspaceId: typeof WorkspaceId.Type,
      jobId: typeof JobId.Type
    ) =>
      Effect.gen(function*() {
        const observedAt = encodeTimestamp(yield* DateTime.now)
        const rows = yield* sql<SqlRow>`SELECT COUNT(*) AS active
        FROM agent_jobs job
        JOIN agent_job_leases lease
          ON lease.workspace_id = job.workspace_id
          AND lease.job_id = job.job_id
        WHERE job.workspace_id = ${workspaceId}
          AND job.job_id = ${jobId}
          AND job.state IN ('running', 'cancel-requested')
          AND lease.lease_expires_at > ${observedAt}
          AND lease.attempt_sequence = (
            SELECT MAX(latest.attempt_sequence)
            FROM agent_job_leases latest
            WHERE latest.workspace_id = job.workspace_id
              AND latest.job_id = job.job_id
          )`
        const decoded = Schema.decodeUnknownResult(Schema.Array(ActiveLeaseRow))(rows)
        if (Result.isFailure(decoded) || decoded.success.length !== 1) {
          return yield* persistedRecordError(
            workspaceId,
            "agent-job",
            jobId,
            "agent-job-active-lease-schema-invalid"
          )
        }
        return decoded.success[0]?.active === 1
      }).pipe(mapPersistenceOperation("agent-job.is-lease-active"))
    ),

    heartbeat: Effect.fn("AgentJobRepository.heartbeat")(function*(
      input: typeof HeartbeatAgentJobInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(HeartbeatAgentJobInput))(input)
      return yield* database.transaction(
        Effect.gen(function*() {
          const renewedAt = yield* DateTime.now
          if (DateTime.Order(renewedAt, request.leaseExpiresAt) >= 0) {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          const job = yield* getJob(request.workspaceId, request.jobId)
          if (job.state !== "running" && job.state !== "cancel-requested") {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          yield* validateLease({
            workspaceId: request.workspaceId,
            jobId: request.jobId,
            attemptSequence: request.attemptSequence,
            leaseToken: request.leaseToken,
            observedAt: renewedAt
          })
          yield* sql`UPDATE agent_job_leases
            SET last_renewed_at = ${encodeTimestamp(renewedAt)},
                lease_expires_at = ${encodeTimestamp(request.leaseExpiresAt)}
            WHERE workspace_id = ${request.workspaceId}
              AND job_id = ${request.jobId}
              AND attempt_sequence = ${request.attemptSequence}
              AND lease_token = ${request.leaseToken}`
          if ((yield* readChanges(sql)) !== 1) {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "lease-lost"
            })
          }
          return job.state === "cancel-requested"
        })
      ).pipe(mapPersistenceOperation("agent-job.heartbeat"))
    }),

    appendEvent: Effect.fn("AgentJobRepository.appendEvent")(function*(input: typeof AppendAgentEventInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(AppendAgentEventInput))(input)
      return yield* database
        .transaction(
          Effect.gen(function*() {
            const job = yield* getJob(request.workspaceId, request.jobId)
            if (job.state !== "running" && job.state !== "cancel-requested") {
              return yield* new AgentJobInputError({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                reason: "invalid-transition"
              })
            }
            if (
              job.state === "cancel-requested" &&
              request.event._tag === "completed" &&
              request.event.outcome !== "cancelled"
            ) {
              return yield* new AgentJobInputError({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                reason: "cancellation-requested"
              })
            }
            yield* validateLease({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              attemptSequence: request.attemptSequence,
              leaseToken: request.leaseToken,
              observedAt: request.occurredAt
            })
            const allowedReviewActivity = request.event._tag === "started" ||
              request.event._tag === "usage" ||
              (request.event._tag === "output" && request.event.channel === "progress") ||
              (
                job.state === "cancel-requested" &&
                request.event._tag === "completed" &&
                request.event.outcome === "cancelled"
              )
            if (job.task._tag === "pr-review" && !allowedReviewActivity) {
              return yield* new AgentJobInputError({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                reason: "invalid-transition"
              })
            }
            let eventKind: EventKind
            switch (request.event._tag) {
              case "started":
                eventKind = "job-started"
                yield* sql`UPDATE agent_job_attempts
              SET provider_run_ref = ${request.event.providerRunRef},
                  session_ref = COALESCE(${request.event.sessionRef}, session_ref)
              WHERE workspace_id = ${request.workspaceId}
                AND job_id = ${request.jobId}
                AND attempt_sequence = ${request.attemptSequence}
                AND completed_at IS NULL`
                break
              case "output": {
                eventKind = request.event.channel === "assistant" ? "assistant-output" : "progress"
                const outputBytes = yield* bytesFromText(request.event.text)
                yield* sql`UPDATE agent_job_attempts
              SET output_bytes = output_bytes + ${outputBytes.length}
              WHERE workspace_id = ${request.workspaceId}
                AND job_id = ${request.jobId}
                AND attempt_sequence = ${request.attemptSequence}
                AND completed_at IS NULL
                AND output_bytes + ${outputBytes.length} <= ${MAXIMUM_AGENT_ATTEMPT_OUTPUT_BYTES}`
                if ((yield* readChanges(sql)) !== 1) {
                  return yield* new AgentJobInputError({
                    workspaceId: request.workspaceId,
                    jobId: request.jobId,
                    reason: "output-limit-exceeded"
                  })
                }
                break
              }
              case "usage":
                eventKind = "usage"
                break
              case "completed":
                eventKind = "job-completed"
                break
            }
            const persistedEvent = yield* appendThreadEvent({
              workspaceId: request.workspaceId,
              threadId: job.threadId,
              jobId: request.jobId,
              attemptSequence: request.attemptSequence,
              eventKind,
              payload: request.event,
              payloadSchema: AgentRuntimeEvent,
              occurredAt: request.occurredAt
            })
            if (request.event._tag === "completed") {
              const state = request.event.outcome === "success"
                ? "succeeded"
                : request.event.outcome === "cancelled"
                ? "cancelled"
                : "failed"
              yield* completeAttempt({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                attemptSequence: request.attemptSequence,
                completedAt: request.occurredAt,
                outcome: request.event.outcome,
                state,
                sessionRef: request.event.sessionRef,
                errorJson: null
              })
            }
            return persistedEvent
          })
        )
        .pipe(mapPersistenceOperation("agent-job.append-event"))
    }),

    recordReviewProgress: Effect.fnUntraced(function*(
      input: typeof RecordAgentReviewProgressInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(RecordAgentReviewProgressInput))(input)
      const agentReport = yield* Schema.decodeUnknownEffect(Schema.toType(PrReviewReport))(request.report).pipe(
        Effect.mapError(
          () =>
            new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-result"
            })
        )
      )
      if (!agentReport.suggestions.every(({ state }) => isAgentOwnedSuggestionState(state))) {
        return yield* new AgentJobInputError({
          workspaceId: request.workspaceId,
          jobId: request.jobId,
          reason: "invalid-result"
        })
      }
      const report = sanitizeAgentReviewReport(agentReport)
      return yield* database.transaction(
        Effect.gen(function*() {
          const job = yield* getJob(request.workspaceId, request.jobId)
          if (
            job.state !== "running" &&
              job.state !== "cancel-requested" ||
            job.task._tag !== "pr-review" ||
            !PrReviewSubjectEquivalence(job.task.subject, report.subject)
          ) {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "task-mismatch"
            })
          }
          yield* validateLease({
            workspaceId: request.workspaceId,
            jobId: request.jobId,
            attemptSequence: request.attemptSequence,
            leaseToken: request.leaseToken,
            observedAt: request.occurredAt
          })
          yield* appendThreadEvent({
            workspaceId: request.workspaceId,
            threadId: job.threadId,
            jobId: request.jobId,
            attemptSequence: request.attemptSequence,
            eventKind: "review-report",
            payload: report,
            payloadSchema: PrReviewReport,
            occurredAt: request.occurredAt
          })
          return yield* Schema.decodeUnknownEffect(Schema.toType(AgentReviewResultRecord))({
            workspaceId: request.workspaceId,
            jobId: request.jobId,
            attemptSequence: request.attemptSequence,
            report,
            completedAt: request.occurredAt
          })
        })
      ).pipe(mapPersistenceOperation("agent-job.record-review-progress"))
    }, Effect.withTracerEnabled(false)),

    completeReview: Effect.fnUntraced(function*(
      input: typeof CompleteAgentReviewInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(CompleteAgentReviewInput))(input)
      const agentReport = yield* Schema.decodeUnknownEffect(Schema.toType(PrReviewReport))(request.report).pipe(
        Effect.mapError(
          () =>
            new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-result"
            })
        )
      )
      if (!agentReport.suggestions.every(({ state }) => isAgentOwnedSuggestionState(state))) {
        return yield* new AgentJobInputError({
          workspaceId: request.workspaceId,
          jobId: request.jobId,
          reason: "invalid-result"
        })
      }
      return yield* database
        .transaction(
          Effect.gen(function*() {
            const job = yield* getJob(request.workspaceId, request.jobId)
            if (job.state === "cancel-requested") {
              return yield* new AgentJobInputError({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                reason: "cancellation-requested"
              })
            }
            if (
              job.state !== "running" ||
              job.task._tag !== "pr-review" ||
              job.subjectRevision !== job.task.subject.headRevision ||
              !PrReviewSubjectEquivalence(job.task.subject, agentReport.subject)
            ) {
              return yield* new AgentJobInputError({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                reason: "task-mismatch"
              })
            }
            const previous = yield* findPreviousReviewReport({
              workspaceId: request.workspaceId,
              pluginConnectionId: job.task.pluginConnectionId,
              subject: job.task.subject,
              excludeJobId: request.jobId
            })
            const previousReport = Option.isSome(previous)
              ? previous.value.report
              : PrReviewReport.make({ ...agentReport, suggestions: [], transitions: [] })
            if (Option.isSome(previous)) {
              for (const suggestion of previous.value.report.suggestions) {
                if (
                  suggestion.state !== "draft" && suggestion.state !== "published" && suggestion.state !== "reopened"
                ) {
                  continue
                }
                const currentRevision = yield* reviewSuggestionRevisions.read({
                  workspaceId: request.workspaceId,
                  jobId: previous.value.jobId,
                  suggestionId: suggestion.suggestionId,
                  beforeSequence: null,
                  limit: PrReviewSuggestionRevisionPageSize.make(1)
                })
                if (
                  currentRevision.current.suggestion.state !== "draft" &&
                  currentRevision.current.suggestion.state !== "published"
                ) {
                  continue
                }
                yield* reviewSuggestionRevisions.appendInTransaction({
                  workspaceId: request.workspaceId,
                  jobId: previous.value.jobId,
                  suggestionId: suggestion.suggestionId,
                  expectedRevisionId: currentRevision.current.revisionId,
                  expectedSequence: currentRevision.current.sequence,
                  edit: Schema.decodeUnknownSync(PrReviewSuggestionEdit)(currentRevision.current.suggestion),
                  state: "stale",
                  author: PrReviewSuggestionAgentAuthor.make({
                    jobId: request.jobId,
                    providerId: job.providerId,
                    model: job.model,
                    runtimeMetadata: null
                  }),
                  createdAt: request.completedAt
                })
              }
            }
            const expectedTransitions = reconcilePrReviewReports(previousReport, agentReport)
            if (agentReport.transitions !== undefined) {
              const validation = validatePrReviewReportTransitions(
                previousReport,
                agentReport,
                agentReport.transitions
              )
              if (validation._tag === "failure") {
                return yield* new AgentJobInputError({
                  workspaceId: request.workspaceId,
                  jobId: request.jobId,
                  reason: "invalid-result"
                })
              }
            }
            const report = PrReviewReport.make({ ...agentReport, transitions: expectedTransitions })
            const encodedReport = yield* encodeReviewReport(report).pipe(
              Effect.mapError(
                () =>
                  new AgentJobInputError({
                    workspaceId: request.workspaceId,
                    jobId: request.jobId,
                    reason: "invalid-result"
                  })
              )
            )
            yield* validateLease({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              attemptSequence: request.attemptSequence,
              leaseToken: request.leaseToken,
              observedAt: request.completedAt
            })
            const eventSequence = yield* reserveEventSequence(request.workspaceId, job.threadId)
            yield* sql`INSERT INTO agent_thread_events (
          workspace_id, thread_id, event_sequence, job_id, attempt_sequence,
          event_kind, payload_json, payload_digest, payload_byte_length, occurred_at
        ) VALUES (
          ${request.workspaceId}, ${job.threadId}, ${eventSequence}, ${request.jobId},
          ${request.attemptSequence}, 'review-report', ${encodedReport.json},
          ${encodedReport.digest}, ${encodedReport.bytes.length},
          ${encodeTimestamp(request.completedAt)}
        )`
            yield* appendThreadEvent({
              workspaceId: request.workspaceId,
              threadId: job.threadId,
              jobId: request.jobId,
              attemptSequence: request.attemptSequence,
              eventKind: "job-completed",
              payload: { _tag: "completed", outcome: "success", sessionRef: null },
              payloadSchema: AgentRuntimeEvent,
              occurredAt: request.completedAt
            })
            yield* completeAttempt({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              attemptSequence: request.attemptSequence,
              completedAt: request.completedAt,
              outcome: "success",
              state: "succeeded",
              sessionRef: null,
              errorJson: null
            })
            return yield* Schema.decodeUnknownEffect(Schema.toType(AgentReviewResultRecord))({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              attemptSequence: request.attemptSequence,
              report,
              completedAt: request.completedAt
            })
          })
        )
        .pipe(mapPersistenceOperation("agent-job.complete-review"))
    }, Effect.withTracerEnabled(false)),

    readReviewSuggestionPublication: Effect.fn(
      "AgentJobRepository.readReviewSuggestionPublication"
    )(function*(input: typeof ReadReviewSuggestionPublicationInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.toType(ReadReviewSuggestionPublicationInput)
      )(input)
      const rows = yield* sql<SqlRow>`SELECT
        revision_id AS revisionId, content_digest AS contentDigest, state,
        publication_id AS publicationId, comment_id AS commentId,
        previous_content_digest AS previousContentDigest,
        previous_publication_id AS previousPublicationId,
        previous_published_at AS previousPublishedAt,
        reservation_id AS reservationId,
        reservation_acquired_at AS reservationAcquiredAt, reserved_at AS reservedAt,
        published_at AS publishedAt
        FROM agent_review_suggestion_publications
        WHERE workspace_id = ${request.workspaceId}
          AND job_id = ${request.jobId}
          AND suggestion_id = ${request.suggestionId}
          AND revision_id = ${request.revisionId}`
      if (rows.length === 0) return null
      const decoded = Schema.decodeUnknownResult(ReviewSuggestionPublicationRow)(rows[0])
      if (Result.isFailure(decoded)) {
        return yield* persistedRecordError(
          request.workspaceId,
          "agent-review-suggestion-publication",
          `${request.jobId}:${request.suggestionId}:${request.revisionId}`,
          "agent-review-suggestion-publication-schema-invalid"
        )
      }
      const row = decoded.success
      if (row.state !== "published" || row.publicationId === null || row.commentId === null) return null
      return yield* Schema.decodeUnknownEffect(ReadReviewSuggestionPublication)({
        state: row.state,
        publicationId: row.publicationId,
        commentId: row.commentId
      })
    }),

    reserveReviewSuggestionPublication: Effect.fn(
      "AgentJobRepository.reserveReviewSuggestionPublication"
    )(function*(input: typeof ReserveReviewSuggestionPublicationInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.toType(ReserveReviewSuggestionPublicationInput)
      )(input)
      return yield* database.transaction(
        Effect.gen(function*() {
          const operation = request.operation ?? "create"
          const existingRows = yield* sql<SqlRow>`SELECT
            revision_id AS revisionId, content_digest AS contentDigest, state,
            publication_id AS publicationId, comment_id AS commentId,
            previous_content_digest AS previousContentDigest,
            previous_publication_id AS previousPublicationId,
            previous_published_at AS previousPublishedAt, reservation_id AS reservationId,
            reservation_acquired_at AS reservationAcquiredAt, reserved_at AS reservedAt,
            published_at AS publishedAt
            FROM agent_review_suggestion_publications
            WHERE workspace_id = ${request.workspaceId}
              AND job_id = ${request.jobId}
              AND suggestion_id = ${request.suggestionId}
              AND revision_id = ${request.revisionId}`
          if (existingRows.length > 0) {
            const existing = yield* Schema.decodeUnknownEffect(
              ReviewSuggestionPublicationRow
            )(existingRows[0])
            if (existing.contentDigest !== request.contentDigest) {
              if (
                operation !== "create" &&
                existing.state === "published" &&
                existing.publicationId !== null &&
                existing.publishedAt !== null &&
                existing.commentId !== null &&
                existing.commentId === request.commentId
              ) {
                yield* currentPublishedReviewSuggestion(request)
                yield* sql`UPDATE agent_review_suggestion_publications
                  SET content_digest = ${request.contentDigest},
                      state = 'reserved',
                      publication_id = NULL,
                      previous_content_digest = ${existing.contentDigest},
                      previous_publication_id = ${existing.publicationId},
                      previous_published_at = ${encodeTimestamp(existing.publishedAt)},
                      reservation_id = ${request.reservationId},
                      reservation_acquired_at = ${encodeTimestamp(request.reservedAt)},
                      published_at = NULL
                  WHERE workspace_id = ${request.workspaceId}
                    AND job_id = ${request.jobId}
                    AND suggestion_id = ${request.suggestionId}
                    AND revision_id = ${request.revisionId}
                    AND state = 'published'
                    AND content_digest = ${existing.contentDigest}
                    AND comment_id = ${request.commentId}`
                return ReviewSuggestionPublicationReservation.make({
                  _tag: (yield* readChanges(sql)) === 1 ? "acquired" : "in-progress",
                  commentId: existing.commentId
                })
              }
              return yield* new AgentJobInputError({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                reason: "invalid-transition"
              })
            }
            return existing.state === "published" &&
                existing.publicationId !== null &&
                existing.publishedAt !== null
              ? ReviewSuggestionPublicationReservation.make({
                _tag: "published",
                publicationId: existing.publicationId,
                publishedAt: existing.publishedAt,
                ...(!(existing.commentId === null) && { commentId: existing.commentId })
              })
              : existing.publicationId !== null && existing.publishedAt !== null
              ? ReviewSuggestionPublicationReservation.make({
                _tag: "recoverable",
                publicationId: existing.publicationId,
                publishedAt: existing.publishedAt,
                reservationId: existing.reservationId,
                ...(!(existing.commentId === null) && { commentId: existing.commentId })
              })
              : yield* Effect.gen(function*() {
                const recoveryEligibleAt = DateTime.add(existing.reservationAcquiredAt, {
                  minutes: REVIEW_SUGGESTION_PUBLICATION_RESERVATION_LIFETIME_MINUTES
                })
                if (DateTime.Order(request.reservedAt, recoveryEligibleAt) < 0) {
                  return ReviewSuggestionPublicationReservation.make({
                    _tag: "in-progress",
                    ...(!(existing.commentId === null) && { commentId: existing.commentId })
                  })
                }
                yield* sql`UPDATE agent_review_suggestion_publications
                  SET reservation_id = ${request.reservationId},
                      reservation_acquired_at = ${encodeTimestamp(request.reservedAt)}
                  WHERE workspace_id = ${request.workspaceId}
                    AND job_id = ${request.jobId}
                    AND suggestion_id = ${request.suggestionId}
                    AND revision_id = ${request.revisionId}
                    AND content_digest = ${request.contentDigest}
                    AND state = 'reserved'
                    AND publication_id IS NULL
                    AND reservation_id = ${existing.reservationId}
                    AND reservation_acquired_at = ${encodeTimestamp(existing.reservationAcquiredAt)}`
                return ReviewSuggestionPublicationReservation.make({
                  _tag: (yield* readChanges(sql)) === 1 ? "acquired" : "in-progress",
                  ...(!(existing.commentId === null) && { commentId: existing.commentId })
                })
              })
          }
          if (operation !== "create") {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          yield* currentPublishableReviewSuggestion(request)
          const inserted = yield* sql<SqlRow>`INSERT INTO agent_review_suggestion_publications (
            workspace_id, job_id, suggestion_id, revision_id, content_digest, state,
            publication_id, comment_id, reservation_id, reservation_acquired_at,
            reserved_at, published_at, previous_content_digest,
            previous_publication_id, previous_published_at
          ) VALUES (
            ${request.workspaceId}, ${request.jobId}, ${request.suggestionId},
            ${request.revisionId}, ${request.contentDigest}, 'reserved', NULL,
            NULL,
            ${request.reservationId}, ${encodeTimestamp(request.reservedAt)},
            ${encodeTimestamp(request.reservedAt)}, NULL, NULL, NULL, NULL
          ) ON CONFLICT DO NOTHING
          RETURNING suggestion_id AS suggestionId`
          const rows = yield* sql<SqlRow>`SELECT
            revision_id AS revisionId, content_digest AS contentDigest, state,
            publication_id AS publicationId, comment_id AS commentId,
            previous_content_digest AS previousContentDigest,
            previous_publication_id AS previousPublicationId,
            previous_published_at AS previousPublishedAt, reservation_id AS reservationId,
            reservation_acquired_at AS reservationAcquiredAt, reserved_at AS reservedAt,
            published_at AS publishedAt
            FROM agent_review_suggestion_publications
            WHERE workspace_id = ${request.workspaceId}
              AND job_id = ${request.jobId}
              AND suggestion_id = ${request.suggestionId}
              AND revision_id = ${request.revisionId}`
          const row = Schema.decodeUnknownResult(ReviewSuggestionPublicationRow)(rows[0])
          if (
            rows.length !== 1 ||
            Result.isFailure(row) ||
            row.success.revisionId !== request.revisionId ||
            row.success.contentDigest !== request.contentDigest
          ) {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          return row.success.state === "published" &&
              row.success.publicationId !== null &&
              row.success.publishedAt !== null
            ? ReviewSuggestionPublicationReservation.make({
              _tag: "published",
              publicationId: row.success.publicationId,
              publishedAt: row.success.publishedAt,
              ...(!(row.success.commentId === null) && { commentId: row.success.commentId })
            })
            : row.success.publicationId !== null && row.success.publishedAt !== null
            ? ReviewSuggestionPublicationReservation.make({
              _tag: "recoverable",
              publicationId: row.success.publicationId,
              publishedAt: row.success.publishedAt,
              reservationId: row.success.reservationId,
              ...(!(row.success.commentId === null) && { commentId: row.success.commentId })
            })
            : ReviewSuggestionPublicationReservation.make({
              _tag: inserted.length === 1 ? "acquired" : "in-progress"
            })
        })
      ).pipe(mapPersistenceOperation("agent-job.reserve-review-suggestion-publication"))
    }),

    releaseReviewSuggestionPublication: Effect.fn(
      "AgentJobRepository.releaseReviewSuggestionPublication"
    )(function*(input: typeof ReleaseReviewSuggestionPublicationInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.toType(ReleaseReviewSuggestionPublicationInput)
      )(input)
      yield* database.transaction(
        Effect.gen(function*() {
          yield* sql`UPDATE agent_review_suggestion_publications
            SET content_digest = previous_content_digest,
                state = 'published',
                publication_id = previous_publication_id,
                previous_content_digest = NULL,
                previous_publication_id = NULL,
                previous_published_at = NULL,
                published_at = previous_published_at
            WHERE workspace_id = ${request.workspaceId}
              AND job_id = ${request.jobId}
              AND suggestion_id = ${request.suggestionId}
              AND revision_id = ${request.revisionId}
              AND content_digest = ${request.contentDigest}
              AND state = 'reserved'
              AND publication_id IS NULL
              AND previous_content_digest IS NOT NULL
              AND reservation_id = ${request.reservationId}`
          if ((yield* readChanges(sql)) === 0) {
            yield* sql`DELETE FROM agent_review_suggestion_publications
              WHERE workspace_id = ${request.workspaceId}
                AND job_id = ${request.jobId}
                AND suggestion_id = ${request.suggestionId}
                AND revision_id = ${request.revisionId}
                AND content_digest = ${request.contentDigest}
                AND state = 'reserved'
                AND publication_id IS NULL
                AND reservation_id = ${request.reservationId}`
          }
        })
      ).pipe(mapPersistenceOperation("agent-job.release-review-suggestion-publication"))
    }),

    recordReviewSuggestionPublication: Effect.fn(
      "AgentJobRepository.recordReviewSuggestionPublication"
    )(function*(input: typeof RecordReviewSuggestionPublicationInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.toType(RecordReviewSuggestionPublicationInput)
      )(input)
      return yield* database.transaction(
        Effect.gen(function*() {
          const job = yield* getJob(request.workspaceId, request.jobId)
          const publicationRows = yield* sql<SqlRow>`SELECT
            revision_id AS revisionId, content_digest AS contentDigest, state,
            publication_id AS publicationId, comment_id AS commentId,
            previous_content_digest AS previousContentDigest,
            previous_publication_id AS previousPublicationId,
            previous_published_at AS previousPublishedAt, reservation_id AS reservationId,
            reservation_acquired_at AS reservationAcquiredAt, reserved_at AS reservedAt,
            published_at AS publishedAt
            FROM agent_review_suggestion_publications
            WHERE workspace_id = ${request.workspaceId}
              AND job_id = ${request.jobId}
              AND suggestion_id = ${request.suggestionId}
              AND revision_id = ${request.revisionId}`
          const publication = Schema.decodeUnknownResult(
            ReviewSuggestionPublicationRow
          )(publicationRows[0])
          if (publicationRows.length !== 1 || Result.isFailure(publication)) {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          if (publication.success.state === "published") {
            if (
              publication.success.contentDigest === request.contentDigest &&
              publication.success.publicationId === request.publicationId &&
              (request.commentId === undefined || publication.success.commentId === request.commentId)
            ) return
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          if (publication.success.contentDigest !== request.contentDigest) {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          if (
            (request.commentId !== undefined && publication.success.commentId !== null &&
              publication.success.commentId !== request.commentId)
          ) {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          if (request.finalize === false) {
            yield* sql`UPDATE agent_review_suggestion_publications
              SET publication_id = ${request.publicationId},
                  comment_id = COALESCE(${request.commentId ?? null}, comment_id),
                  previous_content_digest = NULL,
                  previous_publication_id = NULL,
                  previous_published_at = NULL,
                  published_at = ${encodeTimestamp(request.publishedAt)}
              WHERE workspace_id = ${request.workspaceId}
                AND job_id = ${request.jobId}
                AND suggestion_id = ${request.suggestionId}
                AND revision_id = ${request.revisionId}
                AND content_digest = ${request.contentDigest}
                AND state = 'reserved'
                AND reservation_id = ${request.reservationId}
                AND (
                  publication_id IS NULL OR publication_id = ${request.publicationId}
                )`
            if ((yield* readChanges(sql)) !== 1) {
              return yield* new AgentJobInputError({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                reason: "invalid-transition"
              })
            }
            return
          }
          if (
            publication.success.publicationId !== null &&
            publication.success.publicationId !== request.publicationId
          ) {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          const review = yield* readReviewResult({
            workspaceId: request.workspaceId,
            jobId: request.jobId
          })
          if ((request.operation ?? "create") === "create") {
            yield* currentPublishableReviewSuggestion(request)
          } else {
            yield* currentPublishedReviewSuggestion(request)
          }
          yield* sql`UPDATE agent_review_suggestion_publications
            SET state = 'published',
                publication_id = ${request.publicationId},
                comment_id = COALESCE(${request.commentId ?? null}, comment_id),
                previous_content_digest = NULL,
                previous_publication_id = NULL,
                previous_published_at = NULL,
                published_at = ${encodeTimestamp(request.publishedAt)}
            WHERE workspace_id = ${request.workspaceId}
              AND job_id = ${request.jobId}
              AND suggestion_id = ${request.suggestionId}
              AND revision_id = ${request.revisionId}
              AND content_digest = ${request.contentDigest}
              AND state = 'reserved'
              AND reservation_id = ${request.reservationId}
              AND (
                publication_id IS NULL OR publication_id = ${request.publicationId}
              )`
          if ((yield* readChanges(sql)) !== 1) {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          yield* appendThreadEvent({
            workspaceId: request.workspaceId,
            threadId: job.threadId,
            jobId: request.jobId,
            attemptSequence: review.attemptSequence,
            eventKind: "review-suggestion-published",
            payload: {
              suggestionId: request.suggestionId,
              revisionId: request.revisionId,
              publicationId: request.publicationId
            },
            payloadSchema: ReviewSuggestionPublishedPayload,
            occurredAt: request.publishedAt
          })
        })
      ).pipe(mapPersistenceOperation("agent-job.record-review-suggestion-publication"))
    }),

    failAttempt: Effect.fn("AgentJobRepository.failAttempt")(function*(input: typeof FailAgentAttemptInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(FailAgentAttemptInput))(input)
      return yield* database
        .transaction(
          Effect.gen(function*() {
            const job = yield* getJob(request.workspaceId, request.jobId)
            if (job.state === "cancel-requested") {
              return yield* new AgentJobInputError({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                reason: "cancellation-requested"
              })
            }
            if (
              job.state !== "running" ||
              job.providerId !== request.error.providerId
            ) {
              return yield* new AgentJobInputError({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                reason: "invalid-transition"
              })
            }
            yield* validateLease({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              attemptSequence: request.attemptSequence,
              leaseToken: request.leaseToken,
              observedAt: request.failedAt
            })
            const payload = { error: request.error }
            const persistedEvent = yield* appendThreadEvent({
              workspaceId: request.workspaceId,
              threadId: job.threadId,
              jobId: request.jobId,
              attemptSequence: request.attemptSequence,
              eventKind: "job-failed",
              payload,
              payloadSchema: ProviderFailurePayload,
              occurredAt: request.failedAt
            })
            const encodedFailure = yield* encodePayload(ProviderFailurePayload, payload)
            yield* completeAttempt({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              attemptSequence: request.attemptSequence,
              completedAt: request.failedAt,
              outcome: "failed",
              state: "failed",
              sessionRef: null,
              errorJson: encodedFailure.json
            })
            return persistedEvent
          })
        )
        .pipe(mapPersistenceOperation("agent-job.fail-attempt"))
    }),

    listRunningPrReviewAttempts: Effect.fn("AgentJobRepository.listRunningPrReviewAttempts")(function*(
      workspaceId: typeof WorkspaceId.Type
    ) {
      const rows = yield* sql<SqlRow>`SELECT
        job.job_id AS jobId, attempt.attempt_sequence AS attemptSequence,
        job.provider_id AS providerId, attempt.session_ref AS sessionRef
        FROM agent_jobs job
        JOIN agent_job_attempts attempt
          ON attempt.workspace_id = job.workspace_id
          AND attempt.job_id = job.job_id
        WHERE job.workspace_id = ${workspaceId}
          AND job.state IN ('running', 'cancel-requested')
          AND attempt.completed_at IS NULL
        ORDER BY job.job_id, attempt.attempt_sequence`
      const attempts: Array<typeof RunningPrReviewAttempt.Type> = []
      for (const row of rows) {
        const jobId = yield* Schema.decodeUnknownEffect(JobId)(row.jobId).pipe(
          Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.running-review-job-id" }))
        )
        const attemptSequence = yield* Schema.decodeUnknownEffect(AgentAttemptSequence)(row.attemptSequence).pipe(
          Effect.mapError(() =>
            new PersistenceOperationError({ operation: "agent-job.running-review-attempt-sequence" })
          )
        )
        const providerId = yield* Schema.decodeUnknownEffect(Schema.String)(row.providerId).pipe(
          Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.running-review-provider-id" }))
        )
        const job = yield* getJob(workspaceId, jobId)
        if (job.task._tag !== "pr-review") continue
        const digest = yield* cryptoService.digest(
          "SHA-256",
          yield* bytesFromText(`${providerId}:${jobId}:${String(attemptSequence)}`)
        ).pipe(
          Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.running-review-attempt-id" }))
        )
        const attempt = Schema.decodeUnknownResult(RunningPrReviewAttempt)({
          jobId,
          attemptSequence,
          attemptId: Encoding.encodeHex(digest).slice(0, 12),
          sessionRef: row.sessionRef
        })
        if (Result.isFailure(attempt)) {
          return yield* new PersistenceOperationError({ operation: "agent-job.running-review-attempt-invalid" })
        }
        attempts.push(attempt.success)
      }
      return attempts
    }),

    attachRunningPrReviewSession: Effect.fn("AgentJobRepository.attachRunningPrReviewSession")(function*(
      input: typeof AttachRunningPrReviewSessionInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.toType(AttachRunningPrReviewSessionInput)
      )(input)
      yield* sql`UPDATE agent_job_attempts
        SET session_ref = ${request.sessionRef}
        WHERE workspace_id = ${request.workspaceId}
          AND job_id = ${request.jobId}
          AND attempt_sequence = ${request.attemptSequence}
          AND completed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM agent_jobs job
            WHERE job.workspace_id = agent_job_attempts.workspace_id
              AND job.job_id = agent_job_attempts.job_id
              AND job.state IN ('running', 'cancel-requested')
          )`
      return undefined
    }),

    interruptRunningReviews: Effect.fn("AgentJobRepository.interruptRunningReviews")(function*(
      input: typeof InterruptRunningReviewsInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.toType(InterruptRunningReviewsInput)
      )(input)
      return yield* database.transaction(
        Effect.gen(function*() {
          const rows = yield* sql<SqlRow>`SELECT job_id AS jobId
            FROM agent_jobs
            WHERE workspace_id = ${request.workspaceId}
              AND state IN ('running', 'cancel-requested')`
          let interrupted = 0
          for (const row of rows) {
            const jobId = yield* Schema.decodeUnknownEffect(JobId)(row.jobId).pipe(
              Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.interrupt-job-id" }))
            )
            const job = yield* getJob(request.workspaceId, jobId)
            if (job.task._tag !== "pr-review") continue
            const attemptRows = yield* sql<SqlRow>`SELECT attempt_sequence AS attemptSequence
              FROM agent_job_attempts
              WHERE workspace_id = ${request.workspaceId}
                AND job_id = ${jobId}
                AND completed_at IS NULL
              ORDER BY attempt_sequence DESC
              LIMIT 1`
            const attempt = Schema.decodeUnknownResult(
              Schema.Struct({ attemptSequence: AgentAttemptSequence })
            )(attemptRows[0])
            if (Result.isFailure(attempt)) continue
            if (
              request.preservedAttempts?.some((preserved) =>
                preserved.jobId === jobId && preserved.attemptSequence === attempt.success.attemptSequence
              ) === true
            ) continue
            const existing = yield* readReviewResult({
              workspaceId: request.workspaceId,
              jobId
            }).pipe(Effect.result)
            if (Result.isFailure(existing) && existing.failure._tag !== "RecordNotFoundError") {
              return yield* existing.failure
            }
            const report = Result.isSuccess(existing)
              ? {
                ...existing.success.report,
                completion: {
                  status: "unable-to-conclude",
                  reason: PROCESS_RESTART_INTERRUPTION_MESSAGE
                }
              }
              : {
                schemaVersion: 3,
                subject: job.task.subject,
                completion: {
                  status: "unable-to-conclude",
                  reason: PROCESS_RESTART_INTERRUPTION_MESSAGE
                },
                suggestions: [],
                notes: []
              } satisfies typeof PrReviewReport.Type
            yield* appendThreadEvent({
              workspaceId: request.workspaceId,
              threadId: job.threadId,
              jobId,
              attemptSequence: attempt.success.attemptSequence,
              eventKind: "review-report",
              payload: report,
              payloadSchema: PrReviewReport,
              occurredAt: request.interruptedAt
            })
            const error = new AgentProviderError({
              providerId: job.providerId,
              phase: "execution",
              message: PROCESS_RESTART_INTERRUPTION_MESSAGE,
              retryable: false
            })
            const encodedFailure = yield* encodePayload(ProviderFailurePayload, { error })
            yield* appendThreadEvent({
              workspaceId: request.workspaceId,
              threadId: job.threadId,
              jobId,
              attemptSequence: attempt.success.attemptSequence,
              eventKind: "job-failed",
              payload: { error },
              payloadSchema: ProviderFailurePayload,
              occurredAt: request.interruptedAt
            })
            yield* completeAttempt({
              workspaceId: request.workspaceId,
              jobId,
              attemptSequence: attempt.success.attemptSequence,
              completedAt: request.interruptedAt,
              outcome: "failed",
              state: "failed",
              sessionRef: null,
              errorJson: encodedFailure.json
            })
            interrupted += 1
          }
          return { interrupted }
        })
      ).pipe(mapPersistenceOperation("agent-job.interrupt-running-reviews"))
    }),

    reviewBudget: Effect.fn("AgentJobRepository.reviewBudget")(function*(
      input: typeof ReadReviewBudgetInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(ReadReviewBudgetInput))(input)
      return yield* reviewBudgetState(request.workspaceId, request.jobId, request.task)
    }),

    extendReviewBudget: Effect.fn("AgentJobRepository.extendReviewBudget")(function*(
      input: typeof ExtendReviewBudgetInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(ExtendReviewBudgetInput))(input)
      return yield* database.transaction(
        Effect.gen(function*() {
          const job = yield* getJob(request.workspaceId, request.jobId)
          if (job.task._tag !== "pr-review" || job.state !== "running") {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          const current = yield* reviewBudgetState(request.workspaceId, request.jobId, job.task)
          if (
            current.reviewBudgetExtensionCount >= 1 ||
            current.reviewBudgetMillis === undefined ||
            current.reviewBudgetMillis + job.task.reviewProfile.budgetMillis > 3_600_000
          ) {
            return yield* new AgentJobInputError({
              workspaceId: request.workspaceId,
              jobId: request.jobId,
              reason: "invalid-transition"
            })
          }
          const reviewBudgetMillis = current.reviewBudgetMillis + job.task.reviewProfile.budgetMillis
          yield* appendThreadEvent({
            workspaceId: request.workspaceId,
            threadId: job.threadId,
            jobId: request.jobId,
            attemptSequence: null,
            eventKind: "job-queued",
            payload: {
              access: job.access,
              contextFingerprint: job.contextFingerprint,
              model: job.model,
              providerId: job.providerId,
              subjectRevision: job.subjectRevision,
              task: job.task,
              reviewBudgetMillis,
              reviewBudgetExtensionCount: 1
            },
            payloadSchema: PersistedJobQueuedPayload,
            occurredAt: request.extendedAt
          })
          return { reviewBudgetMillis, reviewBudgetExtensionCount: 1 }
        })
      ).pipe(mapPersistenceOperation("agent-job.extend-review-budget"))
    }),

    requestCancellation: Effect.fn("AgentJobRepository.requestCancellation")(function*(
      input: typeof RequestAgentCancellationInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(RequestAgentCancellationInput))(input)
      yield* database
        .transaction(
          Effect.gen(function*() {
            const job = yield* getJob(request.workspaceId, request.jobId)
            if (job.state === "cancel-requested") return
            if (job.state !== "queued" && job.state !== "running") {
              return yield* new AgentJobInputError({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                reason: "invalid-transition"
              })
            }
            const requestedAt = encodeTimestamp(request.requestedAt)
            const nextState = job.state === "queued" ? "cancelled" : "cancel-requested"
            const terminalAt = job.state === "queued" ? requestedAt : null
            yield* sql`UPDATE agent_jobs
          SET state = ${nextState}, cancel_requested_at = ${requestedAt}, terminal_at = ${terminalAt}
          WHERE workspace_id = ${request.workspaceId}
            AND job_id = ${request.jobId}
            AND state = ${job.state}`
            if ((yield* readChanges(sql)) !== 1) {
              return yield* new AgentJobInputError({
                workspaceId: request.workspaceId,
                jobId: request.jobId,
                reason: "invalid-transition"
              })
            }
            yield* appendThreadEvent({
              workspaceId: request.workspaceId,
              threadId: job.threadId,
              jobId: request.jobId,
              attemptSequence: null,
              eventKind: "cancel-requested",
              payload: { requestedAt: request.requestedAt },
              payloadSchema: CancellationRequestedPayload,
              occurredAt: request.requestedAt
            })
          })
        )
        .pipe(mapPersistenceOperation("agent-job.request-cancellation"))
    }),

    latestReview: Effect.fnUntraced(function*(input) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(LatestAgentReviewInput))(input)
      const subjectJson = yield* Schema.encodeUnknownEffect(
        Schema.fromJsonString(PrReviewSubject)
      )(request.subject).pipe(
        Effect.mapError(() =>
          new PersistenceOperationError({
            operation: "agent-job.latest-review-subject"
          })
        )
      )
      const taskContextPrefix =
        `{"_tag":"pr-review","pluginConnectionId":"${request.pluginConnectionId}","subject":${subjectJson},"reviewProfile":`
      const identityPrefix = taskContextPrefix.slice(0, taskContextPrefix.indexOf("\"baseRevision\""))
      const queryInput = {
        workspaceId: request.workspaceId,
        ...(!(request.excludeJobId === undefined) && { excludeJobId: request.excludeJobId }),
        ...(!(request.allowDifferentHead === true) && { subjectRevision: request.subject.headRevision }),
        taskContextPrefix: request.allowDifferentHead === true ? identityPrefix : taskContextPrefix,
        excludeTargeted: true,
        ...(!(request.jobId === undefined) && { jobId: request.jobId })
      }
      const rendered = request.requireReport === true
        ? renderLatestAgentReviewQuery({ ...queryInput, requireReport: true })
        : renderLatestAgentReviewQuery(queryInput)
      const rows = yield* sql
        .unsafe<SqlRow>(rendered.sql, [...rendered.params])
        .pipe(mapPersistenceOperation("agent-job.latest-review"))
      if (rows.length === 0) return Option.none<typeof LatestAgentReviewRecord.Type>()
      const row = Schema.decodeUnknownResult(LatestReviewRow)(rows[0])
      if (rows.length !== 1 || Result.isFailure(row)) {
        return yield* persistedRecordError(
          request.workspaceId,
          "agent-review",
          request.subject.pullRequestId,
          "agent-review-latest-schema-invalid"
        )
      }
      const task = yield* decodeTaskContext(
        request.workspaceId,
        row.success.jobId,
        row.success.taskContextJson,
        row.success.taskContextDigest
      )
      let interrupted = false
      let failure: AgentProviderError | null = null
      if (row.success.state === "failed") {
        const interruptionRows = yield* sql<SqlRow>`SELECT COUNT(*) AS interrupted
          FROM agent_thread_events
          WHERE workspace_id = ${request.workspaceId}
            AND job_id = ${row.success.jobId}
            AND event_kind = 'job-failed'
            AND payload_json LIKE ${`%${PROCESS_RESTART_INTERRUPTION_MESSAGE}%`}`.pipe(
          mapPersistenceOperation("agent-job.latest-review-interruption")
        )
        interrupted = Number(interruptionRows[0]?.interrupted ?? 0) > 0
        const failureRows = yield* sql<SqlRow>`SELECT
          workspace_id AS workspaceId, thread_id AS threadId,
          event_sequence AS eventSequence, job_id AS jobId,
          attempt_sequence AS attemptSequence, event_kind AS eventKind,
          payload_json AS payloadJson, payload_digest AS payloadDigest,
          payload_byte_length AS payloadByteLength, occurred_at AS occurredAt
          FROM agent_thread_events
          WHERE workspace_id = ${request.workspaceId}
            AND job_id = ${row.success.jobId}
            AND event_kind = 'job-failed'
          ORDER BY event_sequence DESC
          LIMIT 1`.pipe(mapPersistenceOperation("agent-job.latest-review-failure"))
        if (failureRows.length === 1) {
          const failureRow = Schema.decodeUnknownResult(ThreadEventRow)(failureRows[0])
          if (Result.isFailure(failureRow)) {
            return yield* persistedRecordError(
              request.workspaceId,
              "agent-review",
              request.subject.pullRequestId,
              "agent-review-failure-schema-invalid"
            )
          }
          const failurePayload = yield* decodeEventPayload(request.workspaceId, failureRow.success)
          const decodedFailure = Schema.decodeUnknownResult(ProviderFailurePayload)(failurePayload)
          if (Result.isFailure(decodedFailure)) {
            return yield* persistedRecordError(
              request.workspaceId,
              "agent-review",
              request.subject.pullRequestId,
              "agent-review-failure-payload-invalid"
            )
          }
          failure = decodedFailure.success.error
        }
      }
      if (
        task._tag !== "pr-review" ||
        task.pluginConnectionId !== request.pluginConnectionId ||
        (
          request.allowDifferentHead === true
            ? task.subject.providerId !== request.subject.providerId ||
              task.subject.repository !== request.subject.repository ||
              task.subject.pullRequestId !== request.subject.pullRequestId
            : !PrReviewSubjectEquivalence(task.subject, request.subject)
        )
      ) {
        return yield* persistedRecordError(
          request.workspaceId,
          "agent-review",
          request.subject.pullRequestId,
          "agent-review-subject-mismatch"
        )
      }
      const reviewBudget = yield* reviewBudgetState(
        request.workspaceId,
        row.success.jobId,
        task
      )
      const startedRows = yield* sql<SqlRow>`SELECT MAX(started_at) AS startedAt
        FROM agent_job_attempts
        WHERE workspace_id = ${request.workspaceId} AND job_id = ${row.success.jobId}`.pipe(
        mapPersistenceOperation("agent-job.latest-review-started-at")
      )
      const startedAt = Schema.decodeUnknownResult(
        Schema.Struct({ startedAt: Schema.NullOr(UtcTimestamp) })
      )(startedRows[0])
      if (startedRows.length !== 1 || Result.isFailure(startedAt)) {
        return yield* persistedRecordError(
          request.workspaceId,
          "agent-review",
          request.subject.pullRequestId,
          "agent-review-started-at-schema-invalid"
        )
      }
      const reviewResult = row.success.state === "succeeded" ||
          row.success.state === "failed" ||
          row.success.state === "cancelled"
        ? yield* readReviewResult({
          workspaceId: request.workspaceId,
          jobId: row.success.jobId
        }).pipe(Effect.catchTag("RecordNotFoundError", () => Effect.succeed(null)))
        : null
      const report = reviewResult === null ? null : reviewResult.report
      const activityRows = yield* sql<SqlRow>`SELECT
        workspace_id AS workspaceId, thread_id AS threadId,
        event_sequence AS eventSequence, job_id AS jobId,
        attempt_sequence AS attemptSequence, event_kind AS eventKind,
        payload_json AS payloadJson, payload_digest AS payloadDigest,
        payload_byte_length AS payloadByteLength, occurred_at AS occurredAt
        FROM agent_thread_events
        WHERE workspace_id = ${request.workspaceId}
          AND job_id = ${row.success.jobId}
          AND event_kind = 'progress'
        ORDER BY event_sequence DESC
        LIMIT ${MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE + 1}`.pipe(
        mapPersistenceOperation("agent-job.latest-review-activity")
      )
      const activity = new Array<string>()
      for (
        const unknownRow of activityRows
          .slice(0, MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE)
          .reverse()
      ) {
        const decodedRow = Schema.decodeUnknownResult(ThreadEventRow)(unknownRow)
        if (Result.isFailure(decodedRow)) {
          return yield* persistedRecordError(
            request.workspaceId,
            "agent-review",
            request.subject.pullRequestId,
            "agent-review-activity-schema-invalid"
          )
        }
        const payload = yield* decodeEventPayload(request.workspaceId, decodedRow.success)
        const decodedEvent = Schema.decodeUnknownResult(AgentRuntimeEvent)(payload)
        if (
          Result.isFailure(decodedEvent) ||
          decodedEvent.success._tag !== "output" ||
          decodedEvent.success.channel !== "progress"
        ) {
          return yield* persistedRecordError(
            request.workspaceId,
            "agent-review",
            request.subject.pullRequestId,
            "agent-review-activity-payload-invalid"
          )
        }
        activity.push(decodedEvent.success.text)
      }
      const record = yield* Schema.decodeUnknownEffect(Schema.toType(LatestAgentReviewRecord))({
        ...row.success,
        state: interrupted ? "interrupted" : row.success.state,
        failure: interrupted ? null : failure,
        startedAt: startedAt.success.startedAt,
        ...(!(reviewBudget.reviewBudgetMillis === undefined) &&
          { reviewBudgetMillis: reviewBudget.reviewBudgetMillis }),
        reviewBudgetExtensionCount: reviewBudget.reviewBudgetExtensionCount,
        taskIntent: task.intent ?? null,
        report,
        reviewProfile: task.reviewProfile,
        activity: {
          events: activity,
          truncated: activityRows.length > MAXIMUM_AGENT_THREAD_EVENT_PAGE_SIZE
        }
      })
      return Option.some(record)
    }, Effect.withTracerEnabled(false)),

    reviewResult: readReviewResult,

    reviewSuggestionRevisions: Effect.fn(
      "AgentJobRepository.reviewSuggestionRevisions"
    )(function*(input: typeof ReadReviewSuggestionRevisionsInput.Type) {
      return yield* reviewSuggestionRevisions.read(input).pipe(
        mapPersistenceOperation("agent-job.review-suggestion-revisions")
      )
    }),

    threadAfter: Effect.fn("AgentJobRepository.threadAfter")(function*(input: typeof AgentThreadAfterInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(AgentThreadAfterInput))(input)
      const thread = yield* findThread(
        request.workspaceId,
        "release-chat",
        request.releaseId
      ).pipe(
        mapPersistenceOperation("agent-job.find-thread")
      )
      if (Option.isNone(thread)) {
        return yield* new RecordNotFoundError({
          workspaceId: request.workspaceId,
          recordKind: "agent-thread",
          recordKey: request.releaseId
        })
      }
      return yield* threadEventsAfter(
        request.workspaceId,
        thread.value.threadId,
        request.after,
        request.limit
      )
    }),

    reviewThreadAfter: Effect.fnUntraced(function*(
      input: typeof AgentReviewThreadAfterInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.toType(AgentReviewThreadAfterInput)
      )(input)
      const subjectKey = yield* reviewThreadSubjectKey(
        request.pluginConnectionId,
        request.subject
      )
      const thread = yield* findThread(
        request.workspaceId,
        "pr-review",
        subjectKey
      ).pipe(mapPersistenceOperation("agent-job.find-review-thread"))
      if (Option.isNone(thread)) {
        return yield* new RecordNotFoundError({
          workspaceId: request.workspaceId,
          recordKind: "agent-review-thread",
          recordKey: request.subject.pullRequestId
            .slice(0, MAXIMUM_PERSISTENCE_RECORD_KEY_LENGTH)
            .trimEnd()
        })
      }
      return yield* threadEventsAfter(
        request.workspaceId,
        thread.value.threadId,
        request.after,
        request.limit
      )
    }, Effect.withTracerEnabled(false)),

    reviewThreadBefore: Effect.fnUntraced(function*(
      input: typeof AgentReviewThreadBeforeInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.toType(AgentReviewThreadBeforeInput)
      )(input)
      const subjectKey = yield* reviewThreadSubjectKey(
        request.pluginConnectionId,
        request.subject
      )
      const thread = yield* findThread(
        request.workspaceId,
        "pr-review",
        subjectKey
      ).pipe(mapPersistenceOperation("agent-job.find-review-thread"))
      if (Option.isNone(thread)) {
        return yield* new RecordNotFoundError({
          workspaceId: request.workspaceId,
          recordKind: "agent-review-thread",
          recordKey: request.subject.pullRequestId
            .slice(0, MAXIMUM_PERSISTENCE_RECORD_KEY_LENGTH)
            .trimEnd()
        })
      }
      return yield* threadEventsBefore(
        request.workspaceId,
        thread.value.threadId,
        request.before,
        request.limit
      )
    }, Effect.withTracerEnabled(false)),

    reviewThreadHistory: Effect.fnUntraced(function*(
      input: typeof AgentReviewThreadHistoryInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.toType(AgentReviewThreadHistoryInput)
      )(input)
      const history = renderAgentReviewThreadHistoryQuery({
        workspaceId: request.workspaceId,
        threadId: request.threadId,
        beforeJobId: request.beforeJobId,
        afterSequence: request.after,
        limit: request.limit
      })
      const rows = yield* sql
        .unsafe<SqlRow>(history.sql, [...history.params])
        .pipe(mapPersistenceOperation("agent-job.review-thread-history"))
      const events = yield* decodeThreadEventRows(
        request.workspaceId,
        request.threadId,
        rows
      )
      return {
        events,
        nextCursor: events.at(-1)?.eventSequence ?? request.after
      } satisfies AgentThreadEventPage
    }, Effect.withTracerEnabled(false)),

    reviewThreadTail: Effect.fnUntraced(function*(
      input: typeof AgentReviewThreadTailInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(
        Schema.toType(AgentReviewThreadTailInput)
      )(input)
      const subjectKey = yield* reviewThreadSubjectKey(
        request.pluginConnectionId,
        request.subject
      )
      const thread = yield* findThread(
        request.workspaceId,
        "pr-review",
        subjectKey
      ).pipe(mapPersistenceOperation("agent-job.find-review-thread"))
      if (Option.isNone(thread)) {
        return yield* new RecordNotFoundError({
          workspaceId: request.workspaceId,
          recordKind: "agent-review-thread",
          recordKey: request.subject.pullRequestId
            .slice(0, MAXIMUM_PERSISTENCE_RECORD_KEY_LENGTH)
            .trimEnd()
        })
      }
      return yield* threadEventsTail(
        request.workspaceId,
        thread.value.threadId,
        request.limit
      )
    }, Effect.withTracerEnabled(false))
  }
})

/** Durable release-thread repository with transactional worker ownership. */
export interface AgentJobRepositoryService extends Success<typeof makeAgentJobRepository> {}

/** Effect service owning durable agent job lifecycle and ordered replay. */
export class AgentJobRepository extends Context.Service<AgentJobRepository, AgentJobRepositoryService>()(
  "@knpkv/control-center/AgentJobRepository"
) {
  /** Layer that captures the shared SQLite database and cryptography services. */
  static readonly layer = Layer.effect(AgentJobRepository, makeAgentJobRepository)
}
