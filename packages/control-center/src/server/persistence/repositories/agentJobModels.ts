/** Durable release-thread and local-agent job contracts. @module */
import { AgentContextFingerprint, AgentProviderId, AgentRuntimeEvent, AgentSessionRef } from "@knpkv/ai-runtime"
import * as Schema from "effect/Schema"

import { AgentThreadId, JobId, ReleaseId, WorkspaceId } from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"

/** Maximum persisted provider output across one attempt. */
export const MAXIMUM_AGENT_ATTEMPT_OUTPUT_BYTES = 1_048_576

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
  prompt: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(131_072)),
  contextFingerprint: AgentContextFingerprint,
  subjectRevision: SubjectRevision,
  createdAt: UtcTimestamp
})
export type EnqueueAgentJobInput = typeof EnqueueAgentJobInput.Type

/** Context frozen for one provider attempt. */
export const AgentContextSnapshotRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  subjectRevision: SubjectRevision,
  fingerprint: AgentContextFingerprint
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
  prompt: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(131_072)),
  context: AgentContextSnapshotRecord,
  sessionRef: Schema.NullOr(AgentSessionRef),
  cancellationRequested: Schema.Boolean
})
export type ClaimedAgentJob = typeof ClaimedAgentJob.Type

/** Identity and expiration used to claim or reclaim one queued job. */
export const ClaimAgentJobInput = Schema.Struct({
  workspaceId: WorkspaceId,
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

/** One immutable event in a release thread. */
export const AgentThreadEvent = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: AgentThreadId,
  eventSequence: AgentEventCursor.check(Schema.isGreaterThan(0)),
  jobId: JobId,
  attemptSequence: Schema.NullOr(AgentAttemptSequence),
  eventKind: Schema.Literals([
    "user-message",
    "job-queued",
    "job-started",
    "assistant-output",
    "progress",
    "usage",
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
      "output-limit-exceeded",
      "event-limit-exceeded"
    ])
  }
) {}
