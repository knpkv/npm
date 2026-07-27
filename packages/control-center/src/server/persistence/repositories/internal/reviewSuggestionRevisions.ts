/** Append-only PR-review suggestion revision projection and persistence. @module */
import type { AgentProviderId } from "@knpkv/ai-runtime"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  type AgentThreadId,
  type JobId,
  PrReviewSuggestionRevisionId,
  type WorkspaceId
} from "../../../../domain/identifiers.js"
import { PrReviewSuggestion, type PrReviewSuggestionId } from "../../../../domain/prReview.js"
import {
  hasSamePrReviewTechnicalClaim,
  MAXIMUM_PR_REVIEW_SUGGESTION_REVISION_BYTES,
  PrReviewSuggestionAgentAuthor,
  PrReviewSuggestionEdit,
  PrReviewSuggestionRequiresRevalidation,
  PrReviewSuggestionRevision,
  PrReviewSuggestionRevisionPage,
  PrReviewSuggestionRevisionSequence,
  PrReviewSuggestionValidated
} from "../../../../domain/prReviewRevision.js"
import { type UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import type { Database } from "../../Database.js"
import {
  PersistedRecordError,
  PersistenceOperationError,
  RecordNotFoundError,
  RevisionConflictError
} from "../../errors.js"
import {
  AgentJobInputError,
  type AgentJobTask,
  type AgentReviewResultRecord,
  AppendReviewSuggestionRevisionInput,
  ReadReviewSuggestionRevisionsInput
} from "../agentJobModels.js"

const REVISION_ID_NAMESPACE = "review-suggestion-revision/v1"

const PersistedDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, {
    expected: "a lowercase SHA-256 digest"
  })
)

const RevisionRow = Schema.Struct({
  revisionSequence: PrReviewSuggestionRevisionSequence,
  revisionId: PrReviewSuggestionRevisionId,
  predecessorRevisionId: PrReviewSuggestionRevisionId,
  revisionJson: Schema.String,
  revisionDigest: PersistedDigest,
  createdAt: PrReviewSuggestionRevision.fields.createdAt
})

const RevisionStatsRow = Schema.Struct({
  revisionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  minimumSequence: Schema.NullOr(PrReviewSuggestionRevisionSequence),
  maximumSequence: Schema.NullOr(PrReviewSuggestionRevisionSequence)
})

/** Metadata-only durable event emitted with an accepted suggestion revision. */
export const ReviewSuggestionRevisedPayload = Schema.Struct({
  suggestionId: PrReviewSuggestion.fields.suggestionId,
  revisionId: PrReviewSuggestionRevision.fields.revisionId,
  sequence: PrReviewSuggestionRevision.fields.sequence,
  authorKind: Schema.Literals(["operator", "agent"]),
  validationState: Schema.Literals(["validated", "requires-revalidation"]),
  suggestionState: Schema.optionalKey(PrReviewSuggestion.fields.state)
})

interface SourceJob {
  readonly threadId: AgentThreadId
  readonly providerId: AgentProviderId
  readonly model: null | string
  readonly task: AgentJobTask
}

interface RevisionOperationsDependencies<
  ReadFailure,
  JobFailure,
  EventFailure
> {
  readonly database: Database["Service"]
  readonly bytesFromText: (
    value: string
  ) => Effect.Effect<Uint8Array, PersistenceOperationError>
  readonly digestBytes: (
    bytes: Uint8Array
  ) => Effect.Effect<string, PersistenceOperationError>
  readonly readReviewResult: (
    input: {
      readonly workspaceId: WorkspaceId
      readonly jobId: JobId
    }
  ) => Effect.Effect<AgentReviewResultRecord, ReadFailure>
  readonly getJob: (
    workspaceId: WorkspaceId,
    jobId: JobId
  ) => Effect.Effect<SourceJob, JobFailure>
  readonly appendThreadEvent: (options: {
    readonly workspaceId: WorkspaceId
    readonly threadId: AgentThreadId
    readonly jobId: JobId
    readonly attemptSequence: null
    readonly eventKind: "review-suggestion-revised"
    readonly payload: typeof ReviewSuggestionRevisedPayload.Type
    readonly payloadSchema: typeof ReviewSuggestionRevisedPayload
    readonly occurredAt: UtcTimestamp
  }) => Effect.Effect<unknown, EventFailure>
}

const revisionRecordKey = (
  jobId: JobId,
  suggestionId: PrReviewSuggestionId
): string => `${jobId}/${suggestionId}`

/** Build the cohesive revision boundary inside the owning agent repository. */
export const makeReviewSuggestionRevisionOperations = <
  ReadFailure,
  JobFailure,
  EventFailure
>(
  dependencies: RevisionOperationsDependencies<
    ReadFailure,
    JobFailure,
    EventFailure
  >
) => {
  const {
    appendThreadEvent,
    bytesFromText,
    database,
    digestBytes,
    getJob,
    readReviewResult
  } = dependencies
  const sql = database.sql

  const operationFailure = (operation: string) => new PersistenceOperationError({ operation })

  const recordFailure = (
    workspaceId: WorkspaceId,
    jobId: JobId,
    suggestionId: PrReviewSuggestionId,
    diagnosticCode: string
  ) =>
    new PersistedRecordError({
      workspaceId,
      recordKind: "agent-review-suggestion-revision",
      recordKey: revisionRecordKey(jobId, suggestionId),
      diagnosticCode
    })

  const deriveRevisionId = Effect.fn(
    "ReviewSuggestionRevisions.deriveRevisionId"
  )(function*(
    jobId: JobId,
    suggestionId: PrReviewSuggestionId,
    sequence: typeof PrReviewSuggestionRevisionSequence.Type
  ) {
    const bytes = yield* bytesFromText(
      `${REVISION_ID_NAMESPACE}\u0000${jobId}\u0000${suggestionId}\u0000${String(sequence)}`
    )
    return yield* Schema.decodeUnknownEffect(PrReviewSuggestionRevisionId)(
      yield* digestBytes(bytes)
    ).pipe(
      Effect.mapError(() => operationFailure("agent-job.review-revision-id"))
    )
  })

  const encodeRevision = Effect.fn(
    "ReviewSuggestionRevisions.encodeRevision"
  )(function*(
    workspaceId: WorkspaceId,
    revision: PrReviewSuggestionRevision
  ) {
    const json = yield* Schema.encodeUnknownEffect(
      Schema.fromJsonString(PrReviewSuggestionRevision)
    )(revision).pipe(
      Effect.mapError(() => operationFailure("agent-job.encode-review-revision"))
    )
    const bytes = yield* bytesFromText(json)
    if (bytes.length > MAXIMUM_PR_REVIEW_SUGGESTION_REVISION_BYTES) {
      return yield* new AgentJobInputError({
        workspaceId,
        jobId: revision.sourceJobId,
        reason: "output-limit-exceeded"
      })
    }
    return {
      json,
      digest: yield* digestBytes(bytes)
    }
  })

  const originalRevision = Effect.fn(
    "ReviewSuggestionRevisions.originalRevision"
  )(function*(
    workspaceId: WorkspaceId,
    jobId: JobId,
    suggestionId: PrReviewSuggestionId
  ) {
    const job = yield* getJob(workspaceId, jobId)
    const result = yield* readReviewResult({ workspaceId, jobId })
    if (job.task._tag !== "pr-review") {
      return yield* recordFailure(
        workspaceId,
        jobId,
        suggestionId,
        "agent-review-revision-task-mismatch"
      )
    }
    const suggestion = result.report.suggestions.find(
      (candidate) => candidate.suggestionId === suggestionId
    )
    if (suggestion === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "agent-review-suggestion",
        recordKey: suggestionId
      })
    }
    const sequence = PrReviewSuggestionRevisionSequence.make(1)
    const revisionId = yield* deriveRevisionId(jobId, suggestionId, sequence)
    return yield* Effect.try({
      try: () =>
        PrReviewSuggestionRevision.make({
          revisionId,
          sequence,
          predecessorRevisionId: null,
          sourceJobId: jobId,
          subject: result.report.subject,
          suggestion,
          validation: PrReviewSuggestionValidated.make({
            reviewedHead: result.report.subject.headRevision,
            validatingJobId: jobId,
            sourceRevisionId: revisionId
          }),
          author: PrReviewSuggestionAgentAuthor.make({
            jobId,
            providerId: job.providerId,
            model: job.model,
            runtimeMetadata: null
          }),
          createdAt: result.completedAt
        }),
      catch: () =>
        recordFailure(
          workspaceId,
          jobId,
          suggestionId,
          "agent-review-original-revision-invalid"
        )
    })
  })

  const revisionStats = Effect.fn(
    "ReviewSuggestionRevisions.revisionStats"
  )(function*(
    workspaceId: WorkspaceId,
    jobId: JobId,
    suggestionId: PrReviewSuggestionId
  ) {
    const rows = yield* sql<Record<string, unknown>>`SELECT
      COUNT(*) AS revisionCount,
      MIN(revision_sequence) AS minimumSequence,
      MAX(revision_sequence) AS maximumSequence
      FROM agent_review_suggestion_revisions
      WHERE workspace_id = ${workspaceId}
        AND source_job_id = ${jobId}
        AND suggestion_id = ${suggestionId}`
    const decoded = Schema.decodeUnknownResult(
      Schema.Array(RevisionStatsRow)
    )(rows)
    const stats = Result.isSuccess(decoded) ? decoded.success[0] : undefined
    if (stats === undefined) {
      return yield* recordFailure(
        workspaceId,
        jobId,
        suggestionId,
        "agent-review-revision-stats-invalid"
      )
    }
    if (
      stats.revisionCount > 0 &&
      (
        stats.minimumSequence !== 2 ||
        stats.maximumSequence === null ||
        stats.maximumSequence !== stats.revisionCount + 1
      )
    ) {
      return yield* recordFailure(
        workspaceId,
        jobId,
        suggestionId,
        "agent-review-revision-sequence-invalid"
      )
    }
    return stats
  })

  const decodeRevisionRow = Effect.fn(
    "ReviewSuggestionRevisions.decodeRevisionRow"
  )(function*(
    workspaceId: WorkspaceId,
    jobId: JobId,
    suggestionId: PrReviewSuggestionId,
    unknownRow: Record<string, unknown>
  ) {
    const row = Schema.decodeUnknownResult(RevisionRow)(unknownRow)
    if (Result.isFailure(row)) {
      return yield* recordFailure(
        workspaceId,
        jobId,
        suggestionId,
        "agent-review-revision-row-invalid"
      )
    }
    const bytes = yield* bytesFromText(row.success.revisionJson)
    if ((yield* digestBytes(bytes)) !== row.success.revisionDigest) {
      return yield* recordFailure(
        workspaceId,
        jobId,
        suggestionId,
        "agent-review-revision-integrity-invalid"
      )
    }
    const revision = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PrReviewSuggestionRevision)
    )(row.success.revisionJson).pipe(
      Effect.mapError(() =>
        recordFailure(
          workspaceId,
          jobId,
          suggestionId,
          "agent-review-revision-payload-invalid"
        )
      )
    )
    const expectedRevisionId = yield* deriveRevisionId(
      jobId,
      suggestionId,
      row.success.revisionSequence
    )
    if (row.success.revisionSequence < 2) {
      return yield* recordFailure(
        workspaceId,
        jobId,
        suggestionId,
        "agent-review-revision-row-invalid"
      )
    }
    const expectedPredecessorId = yield* deriveRevisionId(
      jobId,
      suggestionId,
      PrReviewSuggestionRevisionSequence.make(
        row.success.revisionSequence - 1
      )
    )
    if (
      row.success.revisionId !== expectedRevisionId ||
      row.success.predecessorRevisionId !== expectedPredecessorId ||
      revision.revisionId !== row.success.revisionId ||
      revision.predecessorRevisionId !== row.success.predecessorRevisionId ||
      revision.sequence !== row.success.revisionSequence ||
      revision.sourceJobId !== jobId ||
      revision.suggestion.suggestionId !== suggestionId ||
      !DateTime.Equivalence(revision.createdAt, row.success.createdAt)
    ) {
      return yield* recordFailure(
        workspaceId,
        jobId,
        suggestionId,
        "agent-review-revision-projection-invalid"
      )
    }
    return revision
  })

  const currentRevision = Effect.fn(
    "ReviewSuggestionRevisions.currentRevision"
  )(function*(
    workspaceId: WorkspaceId,
    jobId: JobId,
    suggestionId: PrReviewSuggestionId
  ) {
    const original = yield* originalRevision(workspaceId, jobId, suggestionId)
    const stats = yield* revisionStats(workspaceId, jobId, suggestionId)
    if (stats.maximumSequence === null) return original
    const rows = yield* sql<Record<string, unknown>>`SELECT
      revision_sequence AS revisionSequence,
      revision_id AS revisionId,
      predecessor_revision_id AS predecessorRevisionId,
      revision_json AS revisionJson,
      revision_digest AS revisionDigest,
      created_at AS createdAt
      FROM agent_review_suggestion_revisions
      WHERE workspace_id = ${workspaceId}
        AND source_job_id = ${jobId}
        AND suggestion_id = ${suggestionId}
        AND revision_sequence = ${stats.maximumSequence}`
    if (rows.length !== 1) {
      return yield* recordFailure(
        workspaceId,
        jobId,
        suggestionId,
        "agent-review-current-revision-missing"
      )
    }
    return yield* decodeRevisionRow(
      workspaceId,
      jobId,
      suggestionId,
      rows[0]!
    )
  })

  const read = Effect.fn("ReviewSuggestionRevisions.read")(function*(
    input: typeof ReadReviewSuggestionRevisionsInput.Type
  ) {
    const request = yield* Schema.decodeUnknownEffect(
      Schema.toType(ReadReviewSuggestionRevisionsInput)
    )(input)
    const current = yield* currentRevision(
      request.workspaceId,
      request.jobId,
      request.suggestionId
    )
    const before = request.beforeSequence ?? current.sequence
    if (before > current.sequence) {
      return yield* new AgentJobInputError({
        workspaceId: request.workspaceId,
        jobId: request.jobId,
        reason: "invalid-transition"
      })
    }
    const unknownRows = before <= 2
      ? []
      : yield* sql<Record<string, unknown>>`SELECT
        revision_sequence AS revisionSequence,
        revision_id AS revisionId,
        predecessor_revision_id AS predecessorRevisionId,
        revision_json AS revisionJson,
        revision_digest AS revisionDigest,
        created_at AS createdAt
        FROM agent_review_suggestion_revisions
        WHERE workspace_id = ${request.workspaceId}
          AND source_job_id = ${request.jobId}
          AND suggestion_id = ${request.suggestionId}
          AND revision_sequence < ${before}
        ORDER BY revision_sequence DESC
        LIMIT ${request.limit + 1}`
    const candidates = yield* Effect.forEach(
      unknownRows,
      (row) =>
        decodeRevisionRow(
          request.workspaceId,
          request.jobId,
          request.suggestionId,
          row
        )
    )
    if (
      candidates.length <= request.limit &&
      before > 1 &&
      (candidates.at(-1)?.sequence ?? before) > 1
    ) {
      candidates.push(
        yield* originalRevision(
          request.workspaceId,
          request.jobId,
          request.suggestionId
        )
      )
    }
    const revisions = candidates.slice(0, request.limit)
    const hasMore = candidates.length > request.limit
    return yield* Schema.decodeUnknownEffect(
      Schema.toType(PrReviewSuggestionRevisionPage)
    )({
      current,
      revisions,
      hasMore,
      nextBeforeSequence: hasMore
        ? revisions.at(-1)?.sequence ?? null
        : null
    }).pipe(
      Effect.mapError(() => operationFailure("agent-job.review-revision-page-invalid"))
    )
  })

  const append = Effect.fn("ReviewSuggestionRevisions.append")(function*(
    input: typeof AppendReviewSuggestionRevisionInput.Type
  ) {
    const request = yield* Schema.decodeUnknownEffect(
      Schema.toType(AppendReviewSuggestionRevisionInput)
    )(input)
    return yield* database.transaction(
      Effect.gen(function*() {
        const current = yield* currentRevision(
          request.workspaceId,
          request.jobId,
          request.suggestionId
        )
        const expectedRevisionId = yield* deriveRevisionId(
          request.jobId,
          request.suggestionId,
          request.expectedSequence
        )
        if (expectedRevisionId !== request.expectedRevisionId) {
          return yield* new AgentJobInputError({
            workspaceId: request.workspaceId,
            jobId: request.jobId,
            reason: "revision-identity-mismatch"
          })
        }
        if (
          current.revisionId !== request.expectedRevisionId ||
          current.sequence !== request.expectedSequence
        ) {
          return yield* new RevisionConflictError({
            workspaceId: request.workspaceId,
            recordKind: "agent-review-suggestion-revision",
            recordKey: revisionRecordKey(
              request.jobId,
              request.suggestionId
            ),
            expectedRevision: request.expectedSequence,
            actualRevision: current.sequence
          })
        }
        const currentEdit = yield* Schema.decodeUnknownEffect(
          Schema.toType(PrReviewSuggestionEdit)
        )(current.suggestion).pipe(
          Effect.mapError(() =>
            recordFailure(
              request.workspaceId,
              request.jobId,
              request.suggestionId,
              "agent-review-current-edit-invalid"
            )
          )
        )
        const currentEditJson = yield* Schema.encodeUnknownEffect(
          Schema.fromJsonString(PrReviewSuggestionEdit)
        )(currentEdit).pipe(
          Effect.mapError(() => operationFailure("agent-job.encode-current-review-edit"))
        )
        const requestedEditJson = yield* Schema.encodeUnknownEffect(
          Schema.fromJsonString(PrReviewSuggestionEdit)
        )(request.edit).pipe(
          Effect.mapError(() => operationFailure("agent-job.encode-requested-review-edit"))
        )
        if (currentEditJson === requestedEditJson && request.state === undefined) return current
        const activePublication = yield* sql`SELECT 1
          FROM agent_review_suggestion_publications
          WHERE workspace_id = ${request.workspaceId}
            AND job_id = ${request.jobId}
            AND suggestion_id = ${request.suggestionId}
          LIMIT 1`
        if (activePublication.length > 0) {
          return yield* new AgentJobInputError({
            workspaceId: request.workspaceId,
            jobId: request.jobId,
            reason: "invalid-transition"
          })
        }
        if (
          current.suggestion.state !== "draft" ||
          (
            request.edit.replacement !== undefined &&
            request.edit.replacement.reviewedHead !==
              current.subject.headRevision
          ) ||
          DateTime.Order(request.createdAt, current.createdAt) < 0
        ) {
          return yield* new AgentJobInputError({
            workspaceId: request.workspaceId,
            jobId: request.jobId,
            reason: "invalid-transition"
          })
        }
        const sequence = PrReviewSuggestionRevisionSequence.make(
          current.sequence + 1
        )
        const revisionId = yield* deriveRevisionId(
          request.jobId,
          request.suggestionId,
          sequence
        )
        const validation = hasSamePrReviewTechnicalClaim(
            currentEdit,
            request.edit
          )
          ? current.validation
          : PrReviewSuggestionRequiresRevalidation.make({
            reviewedHead: current.subject.headRevision,
            sourceRevisionId: current.revisionId,
            reason: request.author._tag === "agent"
              ? "agent-edit-not-validated"
              : "technical-claim-edited"
          })
        const suggestion = yield* Schema.decodeUnknownEffect(
          Schema.toType(PrReviewSuggestion)
        )({
          suggestionId: request.suggestionId,
          state: request.state ?? current.suggestion.state,
          ...request.edit
        }).pipe(
          Effect.mapError(() => operationFailure("agent-job.review-revision-suggestion-invalid"))
        )
        const revision = yield* Effect.try({
          try: () =>
            PrReviewSuggestionRevision.make({
              revisionId,
              sequence,
              predecessorRevisionId: current.revisionId,
              sourceJobId: request.jobId,
              subject: current.subject,
              suggestion,
              validation,
              author: request.author,
              createdAt: request.createdAt
            }),
          catch: () => operationFailure("agent-job.review-revision-invalid")
        })
        const encoded = yield* encodeRevision(request.workspaceId, revision)
        yield* sql`INSERT INTO agent_review_suggestion_revisions (
          workspace_id, source_job_id, suggestion_id, revision_sequence,
          revision_id, predecessor_revision_id, revision_json,
          revision_digest, created_at
        ) VALUES (
          ${request.workspaceId}, ${request.jobId}, ${request.suggestionId},
          ${sequence}, ${revisionId}, ${current.revisionId},
          ${encoded.json}, ${encoded.digest},
          ${
          Schema.encodeSync(PrReviewSuggestionRevision.fields.createdAt)(
            request.createdAt
          )
        }
        )`
        const job = yield* getJob(request.workspaceId, request.jobId)
        yield* appendThreadEvent({
          workspaceId: request.workspaceId,
          threadId: job.threadId,
          jobId: request.jobId,
          attemptSequence: null,
          eventKind: "review-suggestion-revised",
          payload: {
            suggestionId: request.suggestionId,
            revisionId,
            sequence,
            authorKind: request.author._tag,
            validationState: validation._tag,
            suggestionState: suggestion.state
          },
          payloadSchema: ReviewSuggestionRevisedPayload,
          occurredAt: request.createdAt
        })
        return revision
      })
    )
  })

  return { append, read }
}
