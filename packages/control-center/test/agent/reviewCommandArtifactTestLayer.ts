import { DateTime, Effect, Layer, Option } from "effect"

import { ReviewCommandArtifactId } from "../../src/domain/identifiers.js"
import { PersistenceOperationError, RecordNotFoundError } from "../../src/server/persistence/errors.js"
import {
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

const CREATED_AT = DateTime.makeUnsafe("2026-07-31T10:00:00.000Z")
const EXPIRES_AT = DateTime.makeUnsafe("2026-08-07T10:00:00.000Z")

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
      Effect.sync(() => {
        return input.artifacts.map(({ content, stream }) => {
          sequence += 1
          const artifactId = ReviewCommandArtifactId.make(
            `01890f6f-6d6a-7cc0-98d2-${String(sequence).padStart(12, "0")}`
          )
          const bytes = new TextEncoder().encode(content)
          const metadata = {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            jobId: input.jobId,
            attemptSequence: input.attemptSequence,
            commandSequence: input.commandSequence,
            artifactId,
            stream,
            byteLength: bytes.byteLength,
            createdAt: CREATED_AT,
            expiresAt: EXPIRES_AT
          } satisfies ReviewCommandArtifactMetadata
          artifacts.set(artifactId, { content: bytes, metadata })
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
