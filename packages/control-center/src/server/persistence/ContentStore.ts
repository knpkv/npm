import { Context, Effect, Layer, Option, Result, Stream } from "effect"
import type { Success } from "effect/Effect"

import type { WorkspaceId } from "../../domain/identifiers.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { ContentMetadataMismatchError, ReproducibleContentUnavailableError } from "./errors.js"
import type { BlobDigest } from "./object-store/BlobDigest.js"
import type { BlobClassification } from "./object-store/BlobRef.js"
import { BlobStore } from "./object-store/BlobStore.js"
import type { BlobStoreError } from "./object-store/BlobStoreError.js"
import type { BlobRange } from "./object-store/BlobStoreTypes.js"
import { ContentBlobMetadataRepository } from "./repositories/contentBlobMetadataRepository.js"
import type { ContentBlobMetadata } from "./repositories/models.js"

/** Metadata supplied when content bytes cross into durable persistence. */
export interface PutContentInput {
  readonly bytes: Uint8Array
  readonly classification: BlobClassification
  readonly mimeType: string | null
  readonly createdAt: UtcTimestamp
}

/** Result of publishing bytes before their SQL metadata becomes visible. */
export interface PutContentResult {
  readonly metadata: ContentBlobMetadata
  readonly stored: boolean
}

const makeContentStore = Effect.gen(function*() {
  const blobs = yield* BlobStore
  const metadataRepository = yield* ContentBlobMetadataRepository

  const requireMetadata = (workspaceId: WorkspaceId, digest: BlobDigest) => metadataRepository.get(workspaceId, digest)

  const mapReadFailure = (
    metadata: ContentBlobMetadata,
    failure: BlobStoreError
  ): BlobStoreError | ReproducibleContentUnavailableError => {
    if (metadata.storageClass !== "reproducible-cache") return failure
    if (failure._tag === "BlobNotFoundError") {
      return new ReproducibleContentUnavailableError({
        digest: metadata.digest,
        workspaceId: metadata.workspaceId,
        reason: "missing",
        recovery: "refetch"
      })
    }
    if (failure._tag === "BlobIntegrityError" || failure._tag === "BlobUnexpectedEofError") {
      return new ReproducibleContentUnavailableError({
        digest: metadata.digest,
        workspaceId: metadata.workspaceId,
        reason: "corrupt",
        recovery: "refetch"
      })
    }
    return failure
  }

  const ensureMetadata = Effect.fn("ContentStore.ensureMetadata")(function*(
    workspaceId: WorkspaceId,
    digest: BlobDigest,
    input: PutContentInput
  ) {
    const existing = yield* metadataRepository.get(workspaceId, digest).pipe(
      Effect.map(Option.some),
      Effect.catchTag("RecordNotFoundError", () => Effect.succeed(Option.none()))
    )
    const metadata = Option.isSome(existing)
      ? existing.value
      : yield* metadataRepository.create(workspaceId, {
        digest,
        storageClass: input.classification,
        byteLength: input.bytes.byteLength,
        mimeType: input.mimeType,
        createdAt: input.createdAt,
        lastVerifiedAt: null
      }).pipe(
        Effect.catchTag("RecordAlreadyExistsError", () => metadataRepository.get(workspaceId, digest))
      )

    if (
      metadata.byteLength !== input.bytes.byteLength ||
      metadata.storageClass !== input.classification ||
      metadata.mimeType !== input.mimeType
    ) {
      return yield* new ContentMetadataMismatchError({ workspaceId, digest })
    }
    return metadata
  })

  const publish = Effect.fn("ContentStore.publish")(function*(
    workspaceId: WorkspaceId,
    input: PutContentInput
  ) {
    const attempted = yield* blobs.put(workspaceId, input.bytes, input.classification).pipe(Effect.result)
    if (Result.isSuccess(attempted)) return attempted.success
    if (attempted.failure._tag !== "BlobIntegrityError" || input.classification !== "reproducible-cache") {
      return yield* attempted.failure
    }
    const metadata = yield* metadataRepository.get(workspaceId, attempted.failure.expectedDigest)
    if (
      metadata.storageClass !== "reproducible-cache" ||
      metadata.byteLength !== input.bytes.byteLength ||
      metadata.mimeType !== input.mimeType
    ) {
      return yield* new ContentMetadataMismatchError({ workspaceId, digest: attempted.failure.expectedDigest })
    }
    return yield* blobs.repairReproducible(workspaceId, input.bytes)
  })

  return {
    put: Effect.fn("ContentStore.put")(function*(
      workspaceId: WorkspaceId,
      input: PutContentInput
    ) {
      // Publication is intentionally bytes-first: SQL can never advertise bytes
      // that were not durably linked and synced into the object directory.
      const published = yield* publish(workspaceId, input)
      const metadata = yield* ensureMetadata(workspaceId, published.ref.digest, input)
      return { metadata, stored: published.stored }
    }),
    getMetadata: requireMetadata,
    listMetadata: (workspaceId: WorkspaceId) => metadataRepository.list(workspaceId),
    readAll: Effect.fn("ContentStore.readAll")(function*(
      workspaceId: WorkspaceId,
      digest: BlobDigest,
      maximumBytes?: number | undefined
    ) {
      const metadata = yield* requireMetadata(workspaceId, digest)
      return yield* blobs.readAll(workspaceId, digest, maximumBytes).pipe(
        Effect.mapError((failure) => mapReadFailure(metadata, failure))
      )
    }),
    readRange: Effect.fn("ContentStore.readRange")(function*(
      workspaceId: WorkspaceId,
      digest: BlobDigest,
      range: BlobRange
    ) {
      const metadata = yield* requireMetadata(workspaceId, digest)
      return yield* blobs.readRange(workspaceId, digest, range).pipe(
        Effect.mapError((failure) => mapReadFailure(metadata, failure))
      )
    }),
    readStream: Effect.fn("ContentStore.readStream")(function*(
      workspaceId: WorkspaceId,
      digest: BlobDigest,
      range?: BlobRange | undefined
    ) {
      const metadata = yield* requireMetadata(workspaceId, digest)
      const result = yield* blobs.readStream(workspaceId, digest, range).pipe(
        Effect.mapError((failure) => mapReadFailure(metadata, failure))
      )
      return {
        ...result,
        bytes: result.bytes.pipe(Stream.mapError((failure) => mapReadFailure(metadata, failure)))
      }
    }),
    verify: Effect.fn("ContentStore.verify")(function*(
      workspaceId: WorkspaceId,
      digest: BlobDigest,
      verifiedAt: UtcTimestamp
    ) {
      const expected = yield* requireMetadata(workspaceId, digest)
      const verification = yield* blobs.verify(workspaceId, digest).pipe(
        Effect.mapError((failure) => mapReadFailure(expected, failure))
      )
      if (verification.sizeBytes !== expected.byteLength) {
        return yield* new ContentMetadataMismatchError({ workspaceId, digest })
      }
      const metadata = yield* metadataRepository.markVerified(workspaceId, digest, verifiedAt)
      return { metadata, verification }
    })
  }
})

/** Durable, workspace-scoped content whose SQL metadata never precedes its bytes. */
export interface ContentStoreService extends Success<typeof makeContentStore> {}

/** Public content service combining the owner-only object store and SQL metadata. */
export class ContentStore extends Context.Service<ContentStore, ContentStoreService>()(
  "@knpkv/control-center/ContentStore"
) {
  static readonly layer = Layer.effect(ContentStore, makeContentStore)
}
