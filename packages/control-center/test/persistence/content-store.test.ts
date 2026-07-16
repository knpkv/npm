import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Predicate, Ref, Result, Stream } from "effect"
import type { PlatformError } from "effect"

import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  ContentMetadataMismatchError,
  Persistence,
  persistenceLayer,
  type PutContentInput,
  RecordNotFoundError,
  ReproducibleContentUnavailableError
} from "../../src/server/persistence/index.js"
import { blobPath } from "../../src/server/persistence/object-store/BlobPath.js"
import { BlobNotFoundError, BlobUnexpectedEofError } from "../../src/server/persistence/object-store/BlobStoreError.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { fixtureTimestamps, fixtureWorkspaceIds, makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_A = fixtureWorkspaceIds.alpha
const WORKSPACE_B = fixtureWorkspaceIds.beta
const CREATED_AT = fixtureTimestamps.created
const VERIFIED_EARLIER = fixtureTimestamps.verifiedEarlier
const VERIFIED_LATER = fixtureTimestamps.verifiedLater

const withReadAllocProbe = (
  file: FileSystem.File,
  beforeRead: Effect.Effect<void, PlatformError.PlatformError>
): FileSystem.File => ({
  [FileSystem.FileTypeId]: FileSystem.FileTypeId,
  fd: file.fd,
  stat: file.stat,
  seek: (offset, from) => file.seek(offset, from),
  sync: file.sync,
  read: (buffer) => file.read(buffer),
  readAlloc: (size) => beforeRead.pipe(Effect.andThen(file.readAlloc(size))),
  truncate: (length) => file.truncate(length),
  write: (buffer) => file.write(buffer),
  writeAll: (buffer) => file.writeAll(buffer)
})

const assertRefetchFailure = (
  failure: { readonly _tag: string },
  reason: ReproducibleContentUnavailableError["reason"]
) => {
  assert.strictEqual(failure._tag, "ReproducibleContentUnavailableError")
  assert.instanceOf(failure, ReproducibleContentUnavailableError)
  if (Predicate.isTagged(failure, "ReproducibleContentUnavailableError")) {
    assert.strictEqual(failure.reason, reason)
    assert.strictEqual(failure.recovery, "refetch")
  }
}

describe("ContentStore", () => {
  it.effect("publishes bytes first, isolates workspaces, and preserves verification monotonicity", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-content-")
      yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        assert.strictEqual(typeof persistence.people.createRoleAssignment, "function")
        assert.strictEqual(typeof persistence.people.updateRoleAssignment, "function")
        const bytes = new Uint8Array([10, 20, 30, 40])
        const input: PutContentInput = {
          bytes,
          classification: "durable",
          mimeType: "application/octet-stream",
          createdAt: CREATED_AT
        }

        yield* persistence.workspaces.create(WORKSPACE_A, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: CREATED_AT
        })

        const orphaned = yield* persistence.content.put(WORKSPACE_B, input).pipe(Effect.result)
        assert.isTrue(Result.isFailure(orphaned))

        yield* persistence.workspaces.create(WORKSPACE_B, {
          displayName: WorkspaceName.make("Identity"),
          createdAt: CREATED_AT
        })
        const adopted = yield* persistence.content.put(WORKSPACE_B, input)
        assert.isFalse(adopted.stored)

        const published = yield* persistence.content.put(WORKSPACE_A, input)
        assert.isTrue(published.stored)
        assert.deepStrictEqual(
          Array.from(yield* persistence.content.readAll(WORKSPACE_A, published.metadata.digest)),
          Array.from(bytes)
        )

        const missing = yield* persistence.content.readAll(
          fixtureWorkspaceIds.missing,
          published.metadata.digest
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(missing))
        if (Result.isFailure(missing)) assert.instanceOf(missing.failure, RecordNotFoundError)

        const later = yield* persistence.content.verify(
          WORKSPACE_A,
          published.metadata.digest,
          VERIFIED_LATER
        )
        const earlier = yield* persistence.content.verify(
          WORKSPACE_A,
          published.metadata.digest,
          VERIFIED_EARLIER
        )
        assert.deepStrictEqual(later.metadata.lastVerifiedAt, VERIFIED_LATER)
        assert.deepStrictEqual(earlier.metadata.lastVerifiedAt, VERIFIED_LATER)

        const conflicting = yield* persistence.content.put(WORKSPACE_A, {
          ...input,
          mimeType: "text/plain"
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(conflicting))
        if (Result.isFailure(conflicting)) {
          assert.instanceOf(conflicting.failure, ContentMetadataMismatchError)
        }
      }).pipe(Effect.provide(persistenceLayer(config)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("does not certify bytes whose persisted length metadata is inconsistent", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-content-length-")
      const digest = yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* persistence.workspaces.create(WORKSPACE_A, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: CREATED_AT
        })
        const stored = yield* persistence.content.put(WORKSPACE_A, {
          bytes: new Uint8Array([1, 2, 3]),
          classification: "durable",
          mimeType: "application/octet-stream",
          createdAt: CREATED_AT
        })
        return stored.metadata.digest
      }).pipe(Effect.provide(persistenceLayer(config)), Effect.scoped)

      yield* Effect.gen(function*() {
        const database = yield* Database
        yield* database.sql`UPDATE content_blobs
          SET byte_length = 99
          WHERE workspace_id = ${WORKSPACE_A} AND digest = ${digest}`
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)

      const verified = yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        return yield* persistence.content.verify(WORKSPACE_A, digest, VERIFIED_LATER)
      }).pipe(Effect.provide(persistenceLayer(config)), Effect.scoped, Effect.result)
      assert.isTrue(Result.isFailure(verified))
      if (Result.isFailure(verified)) {
        assert.instanceOf(verified.failure, ContentMetadataMismatchError)
      }

      const rows = yield* Effect.gen(function*() {
        const database = yield* Database
        return yield* database.sql<{ readonly lastVerifiedAt: string | null }>`SELECT
          last_verified_at AS lastVerifiedAt
          FROM content_blobs
          WHERE workspace_id = ${WORKSPACE_A} AND digest = ${digest}`
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
      assert.deepStrictEqual(rows, [{ lastVerifiedAt: null }])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("maps missing reproducible cache reads while preserving healthy and durable behavior", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-content-missing-cache-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* persistence.workspaces.create(WORKSPACE_A, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: CREATED_AT
        })
        const cacheBytes = new Uint8Array([1, 2, 3, 4])
        const cached = yield* persistence.content.put(WORKSPACE_A, {
          bytes: cacheBytes,
          classification: "reproducible-cache",
          mimeType: "application/octet-stream",
          createdAt: CREATED_AT
        })
        const durable = yield* persistence.content.put(WORKSPACE_A, {
          bytes: new Uint8Array([9, 8, 7, 6]),
          classification: "durable",
          mimeType: "application/octet-stream",
          createdAt: CREATED_AT
        })

        const healthyRange = yield* persistence.content.readRange(
          WORKSPACE_A,
          cached.metadata.digest,
          { offset: 1, length: 2 }
        )
        assert.deepStrictEqual(healthyRange.bytes, new Uint8Array([2, 3]))
        const healthyVerification = yield* persistence.content.verify(
          WORKSPACE_A,
          cached.metadata.digest,
          VERIFIED_LATER
        )
        assert.strictEqual(healthyVerification.verification.sizeBytes, cacheBytes.byteLength)
        const healthyStream = yield* persistence.content.readStream(
          WORKSPACE_A,
          cached.metadata.digest
        )
        const healthyChunks = yield* healthyStream.bytes.pipe(Stream.runCollect)
        assert.deepStrictEqual(
          Array.from(healthyChunks).flatMap((chunk) => Array.from(chunk)),
          Array.from(cacheBytes)
        )

        yield* fileSystem.remove(
          blobPath(path, config.blobRoot, WORKSPACE_A, cached.metadata.digest).file
        )

        const missingRange = yield* persistence.content.readRange(
          WORKSPACE_A,
          cached.metadata.digest,
          { offset: 0, length: cacheBytes.byteLength }
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(missingRange))
        if (Result.isFailure(missingRange)) assertRefetchFailure(missingRange.failure, "missing")

        const missingVerification = yield* persistence.content.verify(
          WORKSPACE_A,
          cached.metadata.digest,
          VERIFIED_LATER
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(missingVerification))
        if (Result.isFailure(missingVerification)) {
          assertRefetchFailure(missingVerification.failure, "missing")
        }

        const missingStream = yield* persistence.content.readStream(
          WORKSPACE_A,
          cached.metadata.digest
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(missingStream))
        if (Result.isFailure(missingStream)) assertRefetchFailure(missingStream.failure, "missing")

        yield* fileSystem.remove(
          blobPath(path, config.blobRoot, WORKSPACE_A, durable.metadata.digest).file
        )
        const missingDurable = yield* persistence.content.verify(
          WORKSPACE_A,
          durable.metadata.digest,
          VERIFIED_LATER
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(missingDurable))
        if (Result.isFailure(missingDurable)) {
          assert.strictEqual(missingDurable.failure._tag, "BlobNotFoundError")
          assert.instanceOf(missingDurable.failure, BlobNotFoundError)
        }
      }).pipe(Effect.provide(persistenceLayer(config)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("maps premature EOF for reproducible ranges, verification, and lazy streams", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-content-truncated-cache-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const truncateOnRead = yield* Ref.make<string | null>(null)
      const faultingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        open: (requestedPath, options) =>
          fileSystem.open(requestedPath, options).pipe(
            Effect.map((file) =>
              withReadAllocProbe(
                file,
                Effect.gen(function*() {
                  const target = yield* Ref.get(truncateOnRead)
                  if (target !== requestedPath) return
                  yield* Ref.set(truncateOnRead, null)
                  yield* fileSystem.truncate(requestedPath, 0)
                })
              )
            )
          )
      })

      yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* persistence.workspaces.create(WORKSPACE_A, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: CREATED_AT
        })
        const put = (bytes: Uint8Array, classification: PutContentInput["classification"]) =>
          persistence.content.put(WORKSPACE_A, {
            bytes,
            classification,
            mimeType: "application/octet-stream",
            createdAt: CREATED_AT
          })
        const rangeBytes = new Uint8Array([1, 2, 3, 4])
        const cacheRange = yield* put(rangeBytes, "reproducible-cache")
        const cacheVerify = yield* put(new Uint8Array([2, 3, 4, 5]), "reproducible-cache")
        const cacheStream = yield* put(new Uint8Array([3, 4, 5, 6]), "reproducible-cache")
        const durableRangeBytes = new Uint8Array([7, 8, 9, 10])
        const durableRange = yield* put(durableRangeBytes, "durable")
        const durableVerify = yield* put(new Uint8Array([8, 9, 10, 11]), "durable")
        const durableStream = yield* put(new Uint8Array([9, 10, 11, 12]), "durable")

        yield* Ref.set(
          truncateOnRead,
          blobPath(path, config.blobRoot, WORKSPACE_A, cacheRange.metadata.digest).file
        )
        const truncatedRange = yield* persistence.content.readRange(
          WORKSPACE_A,
          cacheRange.metadata.digest,
          { offset: 0, length: rangeBytes.byteLength }
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(truncatedRange))
        if (Result.isFailure(truncatedRange)) assertRefetchFailure(truncatedRange.failure, "corrupt")

        yield* Ref.set(
          truncateOnRead,
          blobPath(path, config.blobRoot, WORKSPACE_A, cacheVerify.metadata.digest).file
        )
        const truncatedVerification = yield* persistence.content.verify(
          WORKSPACE_A,
          cacheVerify.metadata.digest,
          VERIFIED_LATER
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(truncatedVerification))
        if (Result.isFailure(truncatedVerification)) {
          assertRefetchFailure(truncatedVerification.failure, "corrupt")
        }

        const openedCacheStream = yield* persistence.content.readStream(
          WORKSPACE_A,
          cacheStream.metadata.digest
        )
        yield* Ref.set(
          truncateOnRead,
          blobPath(path, config.blobRoot, WORKSPACE_A, cacheStream.metadata.digest).file
        )
        const truncatedStream = yield* openedCacheStream.bytes.pipe(Stream.runCollect, Effect.result)
        assert.isTrue(Result.isFailure(truncatedStream))
        if (Result.isFailure(truncatedStream)) assertRefetchFailure(truncatedStream.failure, "corrupt")

        yield* Ref.set(
          truncateOnRead,
          blobPath(path, config.blobRoot, WORKSPACE_A, durableRange.metadata.digest).file
        )
        const truncatedDurableRange = yield* persistence.content.readRange(
          WORKSPACE_A,
          durableRange.metadata.digest,
          { offset: 0, length: durableRangeBytes.byteLength }
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(truncatedDurableRange))
        if (Result.isFailure(truncatedDurableRange)) {
          assert.strictEqual(truncatedDurableRange.failure._tag, "BlobUnexpectedEofError")
          assert.instanceOf(truncatedDurableRange.failure, BlobUnexpectedEofError)
        }

        yield* Ref.set(
          truncateOnRead,
          blobPath(path, config.blobRoot, WORKSPACE_A, durableVerify.metadata.digest).file
        )
        const truncatedDurableVerification = yield* persistence.content.verify(
          WORKSPACE_A,
          durableVerify.metadata.digest,
          VERIFIED_LATER
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(truncatedDurableVerification))
        if (Result.isFailure(truncatedDurableVerification)) {
          assert.strictEqual(truncatedDurableVerification.failure._tag, "BlobUnexpectedEofError")
          assert.instanceOf(truncatedDurableVerification.failure, BlobUnexpectedEofError)
        }

        const openedDurableStream = yield* persistence.content.readStream(
          WORKSPACE_A,
          durableStream.metadata.digest
        )
        yield* Ref.set(
          truncateOnRead,
          blobPath(path, config.blobRoot, WORKSPACE_A, durableStream.metadata.digest).file
        )
        const truncatedDurableStream = yield* openedDurableStream.bytes.pipe(
          Stream.runCollect,
          Effect.result
        )
        assert.isTrue(Result.isFailure(truncatedDurableStream))
        if (Result.isFailure(truncatedDurableStream)) {
          assert.strictEqual(truncatedDurableStream.failure._tag, "BlobUnexpectedEofError")
          assert.instanceOf(truncatedDurableStream.failure, BlobUnexpectedEofError)
        }
      }).pipe(
        Effect.provide(persistenceLayer(config)),
        Effect.provideService(FileSystem.FileSystem, faultingFileSystem),
        Effect.scoped
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("surfaces corrupt reproducible bytes as restart-visible refetch state", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-content-corrupt-cache-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const digest = yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* persistence.workspaces.create(WORKSPACE_A, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: CREATED_AT
        })
        const stored = yield* persistence.content.put(WORKSPACE_A, {
          bytes: new Uint8Array([1, 2, 3]),
          classification: "reproducible-cache",
          mimeType: "application/octet-stream",
          createdAt: CREATED_AT
        })
        return stored.metadata.digest
      }).pipe(Effect.provide(persistenceLayer(config)), Effect.scoped)

      yield* fileSystem.writeFile(
        blobPath(path, config.blobRoot, WORKSPACE_A, digest).file,
        new Uint8Array([3, 2, 1])
      )

      const result = yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        return yield* persistence.content.readAll(WORKSPACE_A, digest)
      }).pipe(Effect.provide(persistenceLayer(config)), Effect.scoped, Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "ReproducibleContentUnavailableError")
        assert.instanceOf(result.failure, ReproducibleContentUnavailableError)
        if (result.failure._tag === "ReproducibleContentUnavailableError") {
          assert.strictEqual(result.failure.reason, "corrupt")
          assert.strictEqual(result.failure.recovery, "refetch")
        }
      }

      yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        const repaired = yield* persistence.content.put(WORKSPACE_A, {
          bytes: new Uint8Array([1, 2, 3]),
          classification: "reproducible-cache",
          mimeType: "application/octet-stream",
          createdAt: CREATED_AT
        })
        assert.isTrue(repaired.stored)
      }).pipe(Effect.provide(persistenceLayer(config)), Effect.scoped)

      yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        assert.deepStrictEqual(yield* persistence.content.readAll(WORKSPACE_A, digest), new Uint8Array([1, 2, 3]))
      }).pipe(Effect.provide(persistenceLayer(config)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("never authorizes durable replacement from a cache-classified retry", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-content-durable-repair-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const expected = new Uint8Array([4, 5, 6])
      const corrupt = new Uint8Array([6, 5, 4])
      const digest = yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* persistence.workspaces.create(WORKSPACE_A, {
          displayName: WorkspaceName.make("Payments"),
          createdAt: CREATED_AT
        })
        const stored = yield* persistence.content.put(WORKSPACE_A, {
          bytes: expected,
          classification: "durable",
          mimeType: "application/octet-stream",
          createdAt: CREATED_AT
        })
        return stored.metadata.digest
      }).pipe(Effect.provide(persistenceLayer(config)), Effect.scoped)
      const file = blobPath(path, config.blobRoot, WORKSPACE_A, digest).file
      yield* fileSystem.writeFile(file, corrupt)

      const result = yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        return yield* persistence.content.put(WORKSPACE_A, {
          bytes: expected,
          classification: "reproducible-cache",
          mimeType: "application/octet-stream",
          createdAt: CREATED_AT
        })
      }).pipe(Effect.provide(persistenceLayer(config)), Effect.scoped, Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "ContentMetadataMismatchError")
        assert.instanceOf(result.failure, ContentMetadataMismatchError)
      }
      assert.deepStrictEqual(yield* fileSystem.readFile(file), corrupt)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
