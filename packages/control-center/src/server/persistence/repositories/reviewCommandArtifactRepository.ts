/** Durable, bounded Review Sandbox command artifacts with redacted metadata. @module */
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { AgentThreadId, JobId, ReviewCommandArtifactId, WorkspaceId } from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { PersistenceOperationError, RecordNotFoundError } from "../errors.js"
import { AgentAttemptSequence } from "./agentJobModels.js"
import { mapPersistenceOperation } from "./internal.js"
import { WorkspaceSettingsRepository } from "./workspaceSettingsRepository.js"

export const MAXIMUM_REVIEW_COMMAND_ARTIFACT_BYTES = 16 * 1_024 * 1_024
export const MAXIMUM_REVIEW_COMMAND_ARTIFACT_ATTEMPT_BYTES = 64 * 1_024 * 1_024
export const MAXIMUM_REVIEW_COMMAND_ARTIFACTS_PER_ATTEMPT = 64
export const MAXIMUM_REVIEW_COMMAND_ARTIFACT_PAGE_LENGTH = 64 * 1_024
export const MAXIMUM_REVIEW_COMMAND_ARTIFACT_SEARCH_MATCHES = 100
const textDecoder = new TextDecoder("utf-8", { fatal: true })
const textEncoder = new TextEncoder()

export const ReviewCommandSequence = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
)
export type ReviewCommandSequence = typeof ReviewCommandSequence.Type

export const ReviewCommandArtifactStream = Schema.Literals(["stderr", "stdout"])
export type ReviewCommandArtifactStream = typeof ReviewCommandArtifactStream.Type

/** Durable opaque handle carrying the immutable command identity needed for scoped reads. */
export const ReviewCommandArtifactHandle = Schema.Struct({
  artifactId: ReviewCommandArtifactId,
  attemptSequence: AgentAttemptSequence,
  commandSequence: ReviewCommandSequence,
  stream: ReviewCommandArtifactStream
})
export type ReviewCommandArtifactHandle = typeof ReviewCommandArtifactHandle.Type

/** Browser-safe identity and lifecycle metadata. Command text and output are intentionally absent. */
export const ReviewCommandArtifactMetadata = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: AgentThreadId,
  jobId: JobId,
  attemptSequence: AgentAttemptSequence,
  commandSequence: ReviewCommandSequence,
  artifactId: ReviewCommandArtifactId,
  stream: ReviewCommandArtifactStream,
  byteLength: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAXIMUM_REVIEW_COMMAND_ARTIFACT_BYTES })
  ),
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp
})
export type ReviewCommandArtifactMetadata = typeof ReviewCommandArtifactMetadata.Type

const ReviewCommandArtifactDraft = Schema.Struct({
  stream: ReviewCommandArtifactStream,
  content: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.makeFilter(
      (value) => textEncoder.encode(value).byteLength <= MAXIMUM_REVIEW_COMMAND_ARTIFACT_BYTES,
      { expected: `UTF-8 content no larger than ${MAXIMUM_REVIEW_COMMAND_ARTIFACT_BYTES} bytes` }
    )
  )
})

const ReviewCommandArtifactDrafts = Schema.Array(ReviewCommandArtifactDraft).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2),
  Schema.makeFilter(
    (artifacts) => new Set(artifacts.map(({ stream }) => stream)).size === artifacts.length,
    { expected: "at most one artifact for each command output stream" }
  )
)

export const CreateReviewCommandArtifactsInput = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: AgentThreadId,
  jobId: JobId,
  attemptSequence: AgentAttemptSequence,
  commandSequence: ReviewCommandSequence,
  artifacts: ReviewCommandArtifactDrafts
})
export type CreateReviewCommandArtifactsInput = typeof CreateReviewCommandArtifactsInput.Type

const ScopedArtifactInput = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: AgentThreadId,
  jobId: JobId,
  ...ReviewCommandArtifactHandle.fields
})

export const PageReviewCommandArtifactInput = Schema.Struct({
  ...ScopedArtifactInput.fields,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAXIMUM_REVIEW_COMMAND_ARTIFACT_PAGE_LENGTH })
  )
})
export type PageReviewCommandArtifactInput = typeof PageReviewCommandArtifactInput.Type

export const SearchReviewCommandArtifactInput = Schema.Struct({
  ...ScopedArtifactInput.fields,
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024))
})
export type SearchReviewCommandArtifactInput = typeof SearchReviewCommandArtifactInput.Type

export const ListReviewCommandArtifactsInput = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: AgentThreadId,
  jobId: JobId,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 }))
})
export type ListReviewCommandArtifactsInput = typeof ListReviewCommandArtifactsInput.Type

export const ReviewCommandArtifactPage = Schema.Struct({
  text: Schema.String,
  nextOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  complete: Schema.Boolean
})
export type ReviewCommandArtifactPage = typeof ReviewCommandArtifactPage.Type

const MetadataRow = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: AgentThreadId,
  jobId: JobId,
  attemptSequence: AgentAttemptSequence,
  commandSequence: ReviewCommandSequence,
  artifactId: ReviewCommandArtifactId,
  stream: ReviewCommandArtifactStream,
  byteLength: Schema.Int,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp
})

const ContentRow = Schema.Struct({
  content: Schema.instanceOf(ArrayBuffer)
})

const isContinuationByte = (byte: number): boolean => byte >> 6 === 0b10

/** @internal Shared by the repository's contract test adapter. */
export const pageReviewCommandArtifactBytes = (
  bytes: Uint8Array,
  offset: number,
  limit: number
): ReviewCommandArtifactPage | null => {
  const start = Math.min(offset, bytes.byteLength)
  if (start < bytes.byteLength && isContinuationByte(bytes[start] ?? 0)) return null
  let end = Math.min(start + limit, bytes.byteLength)
  while (end > start && end < bytes.byteLength && isContinuationByte(bytes[end] ?? 0)) {
    end -= 1
  }
  if (end === start && start < bytes.byteLength) return null
  return {
    text: textDecoder.decode(bytes.slice(start, end)),
    nextOffset: end,
    complete: end === bytes.byteLength
  }
}

/** @internal Shared by the repository's contract test adapter. */
export const searchReviewCommandArtifactBytes = (
  haystack: Uint8Array,
  query: string
): ReadonlyArray<number> => {
  const needle = textEncoder.encode(query)
  const prefix = new Uint32Array(needle.byteLength)
  for (let index = 1, matched = 0; index < needle.byteLength; index += 1) {
    while (matched > 0 && needle[index] !== needle[matched]) {
      matched = prefix[matched - 1] ?? 0
    }
    if (needle[index] === needle[matched]) matched += 1
    prefix[index] = matched
  }
  const matches = new Array<number>()
  for (let index = 0, matched = 0; index < haystack.byteLength; index += 1) {
    while (matched > 0 && haystack[index] !== needle[matched]) {
      matched = prefix[matched - 1] ?? 0
    }
    if (haystack[index] === needle[matched]) matched += 1
    if (matched !== needle.byteLength) continue
    matches.push(index - needle.byteLength + 1)
    if (matches.length >= MAXIMUM_REVIEW_COMMAND_ARTIFACT_SEARCH_MATCHES) break
    matched = prefix[matched - 1] ?? 0
  }
  return matches
}

const decodeRows = <Row extends Schema.Top>(schema: Row, rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
    Effect.mapError(() => new PersistenceOperationError({ operation: "review-artifact.decode" }))
  )

export interface ReviewCommandArtifactRepositoryService {
  readonly createCommand: (
    input: CreateReviewCommandArtifactsInput
  ) => Effect.Effect<ReadonlyArray<ReviewCommandArtifactMetadata>, PersistenceOperationError>
  readonly metadata: (
    input: typeof ScopedArtifactInput.Type
  ) => Effect.Effect<Option.Option<ReviewCommandArtifactMetadata>, PersistenceOperationError>
  readonly list: (
    input: ListReviewCommandArtifactsInput
  ) => Effect.Effect<ReadonlyArray<ReviewCommandArtifactMetadata>, PersistenceOperationError>
  readonly page: (
    input: PageReviewCommandArtifactInput
  ) => Effect.Effect<ReviewCommandArtifactPage, PersistenceOperationError | RecordNotFoundError>
  readonly search: (
    input: SearchReviewCommandArtifactInput
  ) => Effect.Effect<ReadonlyArray<number>, PersistenceOperationError | RecordNotFoundError>
}

const makeReviewCommandArtifactRepository: Effect.Effect<
  ReviewCommandArtifactRepositoryService,
  never,
  Crypto.Crypto | Database | WorkspaceSettingsRepository
> = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const database = yield* Database
  const settings = yield* WorkspaceSettingsRepository
  const sql = database.sql

  const readContent = Effect.fnUntraced(
    function*(input: typeof ScopedArtifactInput.Type) {
      const readAt = Schema.encodeSync(UtcTimestamp)(yield* DateTime.now)
      const rows = yield* sql`SELECT content_blob AS content
        FROM agent_review_command_artifacts
        WHERE workspace_id = ${input.workspaceId}
          AND thread_id = ${input.threadId}
          AND job_id = ${input.jobId}
          AND attempt_sequence = ${input.attemptSequence}
          AND command_sequence = ${input.commandSequence}
          AND stream = ${input.stream}
          AND artifact_id = ${input.artifactId}
          AND expires_at > ${readAt}`.pipe(
        mapPersistenceOperation("review-artifact.read"),
        Effect.flatMap((result) => decodeRows(ContentRow, result))
      )
      const row = rows[0]
      if (row === undefined) {
        return yield* new RecordNotFoundError({
          recordKind: "review-command-artifact",
          recordKey: input.artifactId,
          workspaceId: input.workspaceId
        })
      }
      return new Uint8Array(row.content)
    },
    Effect.withTracerEnabled(false)
  )

  return {
    createCommand: Effect.fn("ReviewCommandArtifactRepository.createCommand")(function*(unknownInput) {
      const input = yield* Schema.decodeUnknownEffect(CreateReviewCommandArtifactsInput)(unknownInput).pipe(
        Effect.mapError(() => new PersistenceOperationError({ operation: "review-artifact.input" }))
      )
      const workspaceSettings = yield* settings.get(input.workspaceId).pipe(
        Effect.mapError(() => new PersistenceOperationError({ operation: "review-artifact.settings" }))
      )
      const artifacts = yield* Effect.forEach(
        input.artifacts,
        Effect.fnUntraced(function*(artifact) {
          const artifactId = yield* cryptoService.randomUUIDv7.pipe(
            Effect.mapError(() => new PersistenceOperationError({ operation: "review-artifact.identity" }))
          )
          const content = textEncoder.encode(artifact.content)
          return { ...artifact, artifactId, content, byteLength: content.byteLength }
        })
      )
      const createdAt = yield* DateTime.now
      const expiresAt = DateTime.add(createdAt, {
        days: workspaceSettings.settings.retention.sandboxArtifactDays
      })
      const encodedCreatedAt = Schema.encodeSync(UtcTimestamp)(createdAt)
      const encodedExpiresAt = Schema.encodeSync(UtcTimestamp)(expiresAt)
      yield* database.transaction(
        Effect.forEach(
          artifacts,
          (artifact) =>
            sql`INSERT INTO agent_review_command_artifacts (
              workspace_id, thread_id, job_id, attempt_sequence, command_sequence,
              artifact_id, stream, byte_length, content_blob, created_at, expires_at
            ) VALUES (
              ${input.workspaceId}, ${input.threadId}, ${input.jobId}, ${input.attemptSequence},
              ${input.commandSequence}, ${artifact.artifactId}, ${artifact.stream}, ${artifact.byteLength},
              ${artifact.content}, ${encodedCreatedAt}, ${encodedExpiresAt}
            )`,
          { discard: true }
        )
      ).pipe(mapPersistenceOperation("review-artifact.create"))
      return artifacts.map((artifact) =>
        ReviewCommandArtifactMetadata.make({
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          jobId: input.jobId,
          attemptSequence: input.attemptSequence,
          commandSequence: input.commandSequence,
          artifactId: ReviewCommandArtifactId.make(artifact.artifactId),
          stream: artifact.stream,
          byteLength: artifact.byteLength,
          createdAt,
          expiresAt
        })
      )
    }),
    metadata: Effect.fn("ReviewCommandArtifactRepository.metadata")(function*(unknownInput) {
      const input = yield* Schema.decodeUnknownEffect(ScopedArtifactInput)(unknownInput).pipe(
        Effect.mapError(() => new PersistenceOperationError({ operation: "review-artifact.input" }))
      )
      const rows = yield* sql`SELECT
          workspace_id AS workspaceId,
          thread_id AS threadId,
          job_id AS jobId,
          attempt_sequence AS attemptSequence,
          command_sequence AS commandSequence,
          artifact_id AS artifactId,
          stream,
          byte_length AS byteLength,
          created_at AS createdAt,
          expires_at AS expiresAt
        FROM agent_review_command_artifacts
        WHERE workspace_id = ${input.workspaceId}
          AND thread_id = ${input.threadId}
          AND job_id = ${input.jobId}
          AND attempt_sequence = ${input.attemptSequence}
          AND command_sequence = ${input.commandSequence}
          AND stream = ${input.stream}
          AND artifact_id = ${input.artifactId}`.pipe(
        mapPersistenceOperation("review-artifact.metadata"),
        Effect.flatMap((result) => decodeRows(MetadataRow, result))
      )
      return Option.fromUndefinedOr(rows[0])
    }),
    list: Effect.fn("ReviewCommandArtifactRepository.list")(function*(unknownInput) {
      const input = yield* Schema.decodeUnknownEffect(ListReviewCommandArtifactsInput)(unknownInput).pipe(
        Effect.mapError(() => new PersistenceOperationError({ operation: "review-artifact.input" }))
      )
      const readAt = Schema.encodeSync(UtcTimestamp)(yield* DateTime.now)
      const rows = yield* sql`SELECT
          workspace_id AS workspaceId,
          thread_id AS threadId,
          job_id AS jobId,
          attempt_sequence AS attemptSequence,
          command_sequence AS commandSequence,
          artifact_id AS artifactId,
          stream,
          byte_length AS byteLength,
          created_at AS createdAt,
          expires_at AS expiresAt
        FROM agent_review_command_artifacts
        WHERE workspace_id = ${input.workspaceId}
          AND thread_id = ${input.threadId}
          AND job_id = ${input.jobId}
          AND expires_at > ${readAt}
        ORDER BY attempt_sequence DESC, command_sequence DESC, stream
        LIMIT ${input.limit}`.pipe(
        mapPersistenceOperation("review-artifact.list"),
        Effect.flatMap((result) => decodeRows(MetadataRow, result))
      )
      return rows
    }),
    page: Effect.fnUntraced(
      function*(unknownInput) {
        const input = yield* Schema.decodeUnknownEffect(PageReviewCommandArtifactInput)(unknownInput).pipe(
          Effect.mapError(() => new PersistenceOperationError({ operation: "review-artifact.input" }))
        )
        const content = yield* readContent(input)
        const page = pageReviewCommandArtifactBytes(content, input.offset, input.limit)
        if (page === null) {
          return yield* new PersistenceOperationError({ operation: "review-artifact.page-boundary" })
        }
        return page
      },
      Effect.withTracerEnabled(false)
    ),
    search: Effect.fnUntraced(
      function*(unknownInput) {
        const input = yield* Schema.decodeUnknownEffect(SearchReviewCommandArtifactInput)(unknownInput).pipe(
          Effect.mapError(() => new PersistenceOperationError({ operation: "review-artifact.input" }))
        )
        const content = yield* readContent(input)
        return searchReviewCommandArtifactBytes(content, input.query)
      },
      Effect.withTracerEnabled(false)
    )
  }
})

/** SQLite-backed command-artifact operations used by the Review Sandbox. */
export class ReviewCommandArtifactRepository extends Context.Service<
  ReviewCommandArtifactRepository,
  ReviewCommandArtifactRepositoryService
>()("@knpkv/control-center/server/persistence/ReviewCommandArtifactRepository") {
  static readonly layer = Layer.effect(
    ReviewCommandArtifactRepository,
    makeReviewCommandArtifactRepository
  )
}
