import { DateTime, Effect, Layer, Option, Schema } from "effect"

import { ReviewCommandArtifactId } from "../../src/domain/identifiers.js"
import { PersistenceOperationError, RecordNotFoundError } from "../../src/server/persistence/errors.js"
import {
  CreateReviewCommandArtifactsInput,
  MAXIMUM_REVIEW_COMMAND_ARTIFACT_ATTEMPT_BYTES,
  MAXIMUM_REVIEW_COMMAND_ARTIFACTS_PER_ATTEMPT,
  pageReviewCommandArtifactBytes,
  type ReviewCommandArtifactMetadata,
  ReviewCommandArtifactRepository,
  type ReviewCommandArtifactRepositoryService,
  searchReviewCommandArtifactBytes
} from "../../src/server/persistence/repositories/reviewCommandArtifactRepository.js"

interface StoredArtifact {
  readonly content: Uint8Array
  readonly metadata: ReviewCommandArtifactMetadata
}

const RETENTION_DAYS = 7

export const reviewCommandArtifactTestLayer = (): Layer.Layer<ReviewCommandArtifactRepository> => {
  const artifacts = new Map<ReviewCommandArtifactId, StoredArtifact>()
  let sequence = 0
  const findScoped = (
    input: Parameters<ReviewCommandArtifactRepositoryService["page"]>[0]
  ): StoredArtifact | undefined => {
    const artifact = artifacts.get(input.artifactId)
    return artifact !== undefined &&
        artifact.metadata.workspaceId === input.workspaceId &&
        artifact.metadata.threadId === input.threadId &&
        artifact.metadata.jobId === input.jobId &&
        artifact.metadata.attemptSequence === input.attemptSequence &&
        artifact.metadata.commandSequence === input.commandSequence &&
        artifact.metadata.stream === input.stream
      ? artifact
      : undefined
  }
  const findReadable = (
    input: Parameters<ReviewCommandArtifactRepositoryService["page"]>[0]
  ): Effect.Effect<StoredArtifact, RecordNotFoundError> =>
    Effect.gen(function*() {
      const artifact = findScoped(input)
      const now = yield* DateTime.now
      if (
        artifact !== undefined &&
        DateTime.toEpochMillis(artifact.metadata.expiresAt) > DateTime.toEpochMillis(now)
      ) return artifact
      return yield* new RecordNotFoundError({
        recordKind: "review-command-artifact",
        recordKey: input.artifactId,
        workspaceId: input.workspaceId
      })
    })
  const service = ReviewCommandArtifactRepository.of({
    createCommand: (input) =>
      Effect.gen(function*() {
        const decoded = yield* Schema.decodeUnknownEffect(CreateReviewCommandArtifactsInput)(input).pipe(
          Effect.mapError(() => new PersistenceOperationError({ operation: "review-artifact.input" }))
        )
        const createdAt = yield* DateTime.now
        const expiresAt = DateTime.add(createdAt, { days: RETENTION_DAYS })
        const existing = Array.from(artifacts.values()).filter(({ metadata }) =>
          metadata.workspaceId === decoded.workspaceId &&
          metadata.jobId === decoded.jobId &&
          metadata.attemptSequence === decoded.attemptSequence
        )
        const drafts = decoded.artifacts.map(({ content, stream }) => ({
          content: new TextEncoder().encode(content),
          stream
        }))
        const byteLength = existing.reduce(
          (total, artifact) => total + artifact.metadata.byteLength,
          drafts.reduce((total, draft) => total + draft.content.byteLength, 0)
        )
        if (
          existing.length + drafts.length > MAXIMUM_REVIEW_COMMAND_ARTIFACTS_PER_ATTEMPT ||
          byteLength > MAXIMUM_REVIEW_COMMAND_ARTIFACT_ATTEMPT_BYTES
        ) {
          return yield* new PersistenceOperationError({
            operation: "review-artifact.attempt-capacity"
          })
        }
        return drafts.map(({ content, stream }) => {
          sequence += 1
          const artifactId = ReviewCommandArtifactId.make(
            `01890f6f-6d6a-7cc0-98d2-${String(sequence).padStart(12, "0")}`
          )
          const metadata = {
            workspaceId: decoded.workspaceId,
            threadId: decoded.threadId,
            jobId: decoded.jobId,
            attemptSequence: decoded.attemptSequence,
            commandSequence: decoded.commandSequence,
            artifactId,
            stream,
            byteLength: content.byteLength,
            createdAt,
            expiresAt
          } satisfies ReviewCommandArtifactMetadata
          artifacts.set(artifactId, { content, metadata })
          return metadata
        })
      }),
    metadata: (input) =>
      Effect.sync(() => Option.fromUndefinedOr(findScoped({ ...input, offset: 0, limit: 1 })?.metadata)),
    list: ({ jobId, limit, threadId, workspaceId }) =>
      DateTime.now.pipe(
        Effect.map((now) =>
          Array.from(artifacts.values())
            .map(({ metadata }) => metadata)
            .filter((metadata) =>
              metadata.workspaceId === workspaceId &&
              metadata.threadId === threadId &&
              metadata.jobId === jobId &&
              DateTime.toEpochMillis(metadata.expiresAt) > DateTime.toEpochMillis(now)
            )
            .sort((left, right) =>
              right.attemptSequence - left.attemptSequence ||
              right.commandSequence - left.commandSequence ||
              left.stream.localeCompare(right.stream)
            )
            .slice(0, limit)
        )
      ),
    page: (input) =>
      findReadable(input).pipe(
        Effect.flatMap(({ content }) => {
          const page = pageReviewCommandArtifactBytes(content, input.offset, input.limit)
          return page === null
            ? Effect.fail(
              new PersistenceOperationError({ operation: "review-artifact.page-boundary" })
            )
            : Effect.succeed(page)
        })
      ),
    search: (input) =>
      findReadable({ ...input, offset: 0, limit: 1 }).pipe(
        Effect.map(({ content }) => searchReviewCommandArtifactBytes(content, input.query))
      )
  })
  return Layer.succeed(ReviewCommandArtifactRepository, service)
}
