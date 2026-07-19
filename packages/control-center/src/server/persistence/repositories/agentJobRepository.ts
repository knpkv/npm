/** Durable release-thread job claiming, event persistence, and replay. @module */
import { AgentProviderError, AgentRuntimeEvent } from "@knpkv/ai-runtime"
import {
  type ClaimableAgentJobState,
  renderAgentJobClaimQuery,
  renderAgentJobDispatchCandidatesQuery,
  renderAgentThreadReplayQuery
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

import { AgentThreadId, JobId, ReleaseId, WorkspaceId } from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { PersistedRecordError, PersistenceOperationError, RecordNotFoundError } from "../errors.js"
import {
  AgentAttemptSequence,
  AgentContextSnapshotRecord,
  AgentEventCursor,
  AgentJobInputError,
  AgentJobState,
  AgentLeaseToken,
  AgentThreadEvent,
  AgentThreadEventPageSize,
  AppendAgentEventInput,
  ClaimAgentJobInput,
  ClaimedAgentJob,
  EnqueueAgentJobInput,
  MAXIMUM_AGENT_ATTEMPT_OUTPUT_BYTES
} from "./agentJobModels.js"
import { mapAlreadyExists, mapPersistenceOperation, readChanges } from "./internal.js"

const DISPATCH_CANDIDATE_LIMIT = 32
const MAXIMUM_AGENT_EVENT_BYTES = 32_768
const SHA_256_PREFIX = "sha256:"

const PersistedDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
)

const UserMessagePayload = Schema.Struct({
  prompt: EnqueueAgentJobInput.fields.prompt
})

const JobQueuedPayload = Schema.Struct({
  access: EnqueueAgentJobInput.fields.access,
  contextFingerprint: EnqueueAgentJobInput.fields.contextFingerprint,
  model: EnqueueAgentJobInput.fields.model,
  providerId: EnqueueAgentJobInput.fields.providerId,
  subjectRevision: EnqueueAgentJobInput.fields.subjectRevision
})

const CancellationRequestedPayload = Schema.Struct({
  requestedAt: UtcTimestamp
})

const ProviderFailurePayload = Schema.Struct({
  error: AgentProviderError
})

const ThreadRow = Schema.Struct({
  threadId: AgentThreadId,
  releaseId: ReleaseId
})

const JobRow = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  threadId: AgentThreadId,
  providerId: EnqueueAgentJobInput.fields.providerId,
  model: EnqueueAgentJobInput.fields.model,
  access: EnqueueAgentJobInput.fields.access,
  prompt: EnqueueAgentJobInput.fields.prompt,
  contextFingerprint: EnqueueAgentJobInput.fields.contextFingerprint,
  subjectRevision: EnqueueAgentJobInput.fields.subjectRevision,
  state: AgentJobState,
  createdAt: UtcTimestamp,
  cancelRequestedAt: Schema.NullOr(UtcTimestamp),
  terminalAt: Schema.NullOr(UtcTimestamp)
})

const DispatchCandidateRow = Schema.Struct({
  ...JobRow.fields,
  state: Schema.Literals(["queued", "running", "cancel-requested"]),
  attemptSequence: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  )
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
    return yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(value))
    ).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.encode-utf8" }))
    )
  })

  const digestBytes = Effect.fn("AgentJobRepository.digestBytes")(function*(bytes: Uint8Array) {
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.digest" }))
    )
    return `${SHA_256_PREFIX}${Encoding.encodeHex(digest)}`
  })

  const encodePayload = Effect.fn("AgentJobRepository.encodePayload")(function*(
    schema: Schema.Codec<unknown, unknown, never, never>,
    payload: unknown
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

  const findThreadForRelease = Effect.fn("AgentJobRepository.findThreadForRelease")(function*(
    workspaceId: typeof WorkspaceId.Type,
    releaseId: typeof ReleaseId.Type
  ) {
    const rows = yield* sql<Record<string, unknown>>`SELECT
      thread_id AS threadId, release_id AS releaseId
      FROM agent_threads
      WHERE workspace_id = ${workspaceId} AND release_id = ${releaseId}`
    if (rows.length === 0) return Option.none<typeof ThreadRow.Type>()
    const decoded = Schema.decodeUnknownResult(ThreadRow)(rows[0])
    if (Result.isFailure(decoded)) {
      return yield* persistedRecordError(
        workspaceId,
        "agent-thread",
        releaseId,
        "agent-thread-schema-invalid"
      )
    }
    return Option.some(decoded.success)
  })

  const findThreadForJob = Effect.fn("AgentJobRepository.findThreadForJob")(function*(
    workspaceId: typeof WorkspaceId.Type,
    threadId: typeof AgentThreadId.Type,
    jobId: typeof JobId.Type
  ) {
    const rows = yield* sql<Record<string, unknown>>`SELECT
      thread_id AS threadId, release_id AS releaseId
      FROM agent_threads
      WHERE workspace_id = ${workspaceId} AND thread_id = ${threadId}`
    const decoded = Schema.decodeUnknownResult(ThreadRow)(rows[0])
    if (Result.isFailure(decoded)) {
      return yield* persistedRecordError(
        workspaceId,
        "agent-thread",
        jobId,
        "agent-thread-schema-invalid"
      )
    }
    return decoded.success
  })

  const getJob = Effect.fn("AgentJobRepository.getJob")(function*(
    workspaceId: typeof WorkspaceId.Type,
    jobId: typeof JobId.Type
  ) {
    const rows = yield* sql<Record<string, unknown>>`SELECT
      workspace_id AS workspaceId, job_id AS jobId, thread_id AS threadId,
      provider_id AS providerId, model, access, prompt,
      context_fingerprint AS contextFingerprint, subject_revision AS subjectRevision,
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
      return yield* persistedRecordError(
        workspaceId,
        "agent-job",
        jobId,
        "agent-job-schema-invalid"
      )
    }
    return decoded.success
  })

  const validateLease = Effect.fn("AgentJobRepository.validateLease")(function*(options: {
    readonly workspaceId: typeof WorkspaceId.Type
    readonly jobId: typeof JobId.Type
    readonly attemptSequence: typeof AgentAttemptSequence.Type
    readonly leaseToken: typeof AgentLeaseToken.Type
    readonly observedAt: typeof UtcTimestamp.Type
  }) {
    const attemptRows = yield* sql<Record<string, unknown>>`SELECT
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
    const leaseRows = yield* sql<Record<string, unknown>>`SELECT
      lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
      FROM agent_job_leases
      WHERE workspace_id = ${options.workspaceId}
        AND job_id = ${options.jobId}
        AND attempt_sequence = ${options.attemptSequence}`
    const lease = Schema.decodeUnknownResult(LeaseRow)(leaseRows[0])
    if (Result.isFailure(lease) || lease.success.leaseToken !== options.leaseToken) {
      return yield* new AgentJobInputError({
        workspaceId: options.workspaceId,
        jobId: options.jobId,
        reason: "lease-lost"
      })
    }
    if (DateTime.Order(options.observedAt, lease.success.leaseExpiresAt) >= 0) {
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
        AND job_id = ${options.jobId}
        AND attempt_sequence = ${options.attemptSequence}`
  })

  const decodeRuntimePayload = Effect.fn("AgentJobRepository.decodeRuntimePayload")(function*(
    workspaceId: typeof WorkspaceId.Type,
    row: typeof ThreadEventRow.Type,
    parsed: unknown
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
    const parsed = Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(row.payloadJson)
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
      case "job-started":
      case "assistant-output":
      case "progress":
      case "usage":
      case "job-completed":
        return yield* decodeRuntimePayload(workspaceId, row, payload)
    }
  })

  return {
    enqueue: Effect.fn("AgentJobRepository.enqueue")(function*(input: typeof EnqueueAgentJobInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(EnqueueAgentJobInput))(input)
      const candidateThreadId = yield* cryptoService.randomUUIDv7.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AgentThreadId)),
        Effect.mapError(() => new PersistenceOperationError({ operation: "agent-job.thread-id" }))
      )
      return yield* database.transaction(Effect.gen(function*() {
        const releaseRows = yield* sql`SELECT release_id FROM releases
          WHERE workspace_id = ${request.workspaceId} AND release_id = ${request.releaseId}`
        if (releaseRows.length === 0) {
          return yield* new RecordNotFoundError({
            workspaceId: request.workspaceId,
            recordKind: "release",
            recordKey: request.releaseId
          })
        }
        yield* sql`INSERT INTO agent_threads (
          workspace_id, thread_id, release_id, next_event_sequence, created_at
        ) VALUES (
          ${request.workspaceId}, ${candidateThreadId}, ${request.releaseId}, 1,
          ${encodeTimestamp(request.createdAt)}
        ) ON CONFLICT (workspace_id, release_id) DO NOTHING`
        const thread = yield* findThreadForRelease(request.workspaceId, request.releaseId)
        if (Option.isNone(thread)) {
          return yield* new PersistenceOperationError({ operation: "agent-job.find-thread" })
        }
        yield* sql`INSERT INTO agent_jobs (
          workspace_id, job_id, thread_id, provider_id, model, access, prompt,
          context_fingerprint, subject_revision, state, created_at,
          cancel_requested_at, terminal_at
        ) VALUES (
          ${request.workspaceId}, ${request.jobId}, ${thread.value.threadId},
          ${request.providerId}, ${request.model}, ${request.access}, ${request.prompt},
          ${request.contextFingerprint}, ${request.subjectRevision}, 'queued',
          ${encodeTimestamp(request.createdAt)}, NULL, NULL
        )`
        yield* appendThreadEvent({
          workspaceId: request.workspaceId,
          threadId: thread.value.threadId,
          jobId: request.jobId,
          attemptSequence: null,
          eventKind: "user-message",
          payload: { prompt: request.prompt },
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
            subjectRevision: request.subjectRevision
          },
          payloadSchema: JobQueuedPayload,
          occurredAt: request.createdAt
        })
        return thread.value.threadId
      })).pipe(
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
      const observedAt = encodeTimestamp(request.claimedAt)
      return yield* database.transaction(Effect.gen(function*() {
        const dispatch = renderAgentJobDispatchCandidatesQuery({
          workspaceId: request.workspaceId,
          observedAt,
          limit: DISPATCH_CANDIDATE_LIMIT
        })
        const candidateRows = yield* sql.unsafe<Record<string, unknown>>(
          dispatch.sql,
          [...dispatch.params]
        )
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
          if (DateTime.Order(request.claimedAt, request.leaseExpiresAt) >= 0) {
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
          const claimedRows = yield* sql.unsafe<Record<string, unknown>>(
            claim.sql,
            [...claim.params]
          )
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
          const thread = yield* findThreadForJob(
            request.workspaceId,
            claimed.success.threadId,
            claimed.success.jobId
          )
          const context = yield* Schema.decodeUnknownEffect(Schema.toType(AgentContextSnapshotRecord))({
            workspaceId: request.workspaceId,
            releaseId: thread.releaseId,
            subjectRevision: claimed.success.subjectRevision,
            fingerprint: claimed.success.contextFingerprint
          })
          const contextPayload = yield* encodePayload(AgentContextSnapshotRecord, context)
          let sessionRef: null | typeof ClaimedAgentJob.fields.sessionRef.Type = null
          if (candidate.attemptSequence > 0) {
            const previousRows = yield* sql<Record<string, unknown>>`SELECT
              context_snapshot_json AS contextSnapshotJson,
              context_snapshot_digest AS contextSnapshotDigest,
              session_ref AS sessionRef
              FROM agent_job_attempts
              WHERE workspace_id = ${request.workspaceId}
                AND job_id = ${candidate.jobId}
                AND attempt_sequence = ${candidate.attemptSequence}`
            const previous = Schema.decodeUnknownResult(PreviousAttemptRow)(previousRows[0])
            const previousContext = Result.isSuccess(previous)
              ? Schema.decodeUnknownResult(
                Schema.fromJsonString(AgentContextSnapshotRecord)
              )(previous.success.contextSnapshotJson)
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
            releaseId: thread.releaseId,
            threadId: thread.threadId,
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
            sessionRef,
            cancellationRequested: claimed.success.state === "cancel-requested"
          })
          return Option.some(claimedJob)
        }
        return Option.none<typeof ClaimedAgentJob.Type>()
      })).pipe(mapPersistenceOperation("agent-job.claim-next"))
    }),

    appendEvent: Effect.fn("AgentJobRepository.appendEvent")(function*(
      input: typeof AppendAgentEventInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(AppendAgentEventInput))(input)
      return yield* database.transaction(Effect.gen(function*() {
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
          observedAt: request.occurredAt
        })
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
      })).pipe(mapPersistenceOperation("agent-job.append-event"))
    }),

    failAttempt: Effect.fn("AgentJobRepository.failAttempt")(function*(
      input: typeof FailAgentAttemptInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(FailAgentAttemptInput))(input)
      return yield* database.transaction(Effect.gen(function*() {
        const job = yield* getJob(request.workspaceId, request.jobId)
        if (
          (job.state !== "running" && job.state !== "cancel-requested") ||
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
      })).pipe(mapPersistenceOperation("agent-job.fail-attempt"))
    }),

    requestCancellation: Effect.fn("AgentJobRepository.requestCancellation")(function*(
      input: typeof RequestAgentCancellationInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(RequestAgentCancellationInput))(input)
      yield* database.transaction(Effect.gen(function*() {
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
      })).pipe(mapPersistenceOperation("agent-job.request-cancellation"))
    }),

    threadAfter: Effect.fn("AgentJobRepository.threadAfter")(function*(
      input: typeof AgentThreadAfterInput.Type
    ) {
      const request = yield* Schema.decodeUnknownEffect(Schema.toType(AgentThreadAfterInput))(input)
      const thread = yield* findThreadForRelease(request.workspaceId, request.releaseId).pipe(
        mapPersistenceOperation("agent-job.find-thread")
      )
      if (Option.isNone(thread)) {
        return yield* new RecordNotFoundError({
          workspaceId: request.workspaceId,
          recordKind: "agent-thread",
          recordKey: request.releaseId
        })
      }
      const replay = renderAgentThreadReplayQuery({
        workspaceId: request.workspaceId,
        threadId: thread.value.threadId,
        afterSequence: request.after,
        limit: request.limit
      })
      const rows = yield* sql.unsafe<Record<string, unknown>>(
        replay.sql,
        [...replay.params]
      ).pipe(mapPersistenceOperation("agent-job.thread-after"))
      const decodedRows = Schema.decodeUnknownResult(Schema.Array(ThreadEventRow))(rows)
      if (Result.isFailure(decodedRows)) {
        return yield* persistedRecordError(
          request.workspaceId,
          "agent-thread",
          thread.value.threadId,
          "agent-thread-event-schema-invalid"
        )
      }
      const events = yield* Effect.forEach(
        decodedRows.success,
        (row) =>
          decodeEventPayload(request.workspaceId, row).pipe(
            Effect.flatMap((payload) =>
              Schema.decodeUnknownEffect(Schema.toType(AgentThreadEvent))({
                workspaceId: row.workspaceId,
                threadId: row.threadId,
                eventSequence: row.eventSequence,
                jobId: row.jobId,
                attemptSequence: row.attemptSequence,
                eventKind: row.eventKind,
                payload,
                occurredAt: row.occurredAt
              })
            )
          )
      )
      const nextCursor = events.at(-1)?.eventSequence ?? request.after
      return { events, nextCursor }
    })
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
