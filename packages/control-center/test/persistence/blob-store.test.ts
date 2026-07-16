import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import type { Scope } from "effect"
import { Crypto, Deferred, Effect, Fiber, FileSystem, Path, PlatformError, Ref, Result, Schema, Stream } from "effect"

import { WorkspaceId } from "../../src/domain/identifiers.js"
import { BlobDigest } from "../../src/server/persistence/object-store/BlobDigest.js"
import { blobPath } from "../../src/server/persistence/object-store/BlobPath.js"
import { makeBlobStore } from "../../src/server/persistence/object-store/BlobStore.js"
import {
  BlobContainmentError,
  BlobIntegrityError,
  BlobNotFoundError,
  BlobStoreInputError,
  BlobStoreIoError,
  BlobTooLargeError,
  BlobUnexpectedEofError
} from "../../src/server/persistence/object-store/BlobStoreError.js"
import { BlobRoot } from "../../src/server/persistence/PersistenceConfig.js"

const WORKSPACE_A = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000001")
const WORKSPACE_B = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000002")
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const CONCURRENT_DIGEST = Schema.decodeSync(BlobDigest)(
  "28232a9d9b97d766b648b065a60b955a85f6e0fa7c4a42a486c2161cf56bf0aa"
)

const withSyncProbe = (
  file: FileSystem.File,
  onSync: Effect.Effect<void>
): FileSystem.File => ({
  [FileSystem.FileTypeId]: FileSystem.FileTypeId,
  fd: file.fd,
  stat: file.stat,
  seek: (offset, from) => file.seek(offset, from),
  sync: onSync.pipe(Effect.andThen(file.sync)),
  read: (buffer) => file.read(buffer),
  readAlloc: (size) => file.readAlloc(size),
  truncate: (length) => file.truncate(length),
  write: (buffer) => file.write(buffer),
  writeAll: (buffer) => file.writeAll(buffer)
})

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

const withWriteAllProbe = (
  file: FileSystem.File,
  beforeWriteAll: Effect.Effect<void, PlatformError.PlatformError>
): FileSystem.File => ({
  [FileSystem.FileTypeId]: FileSystem.FileTypeId,
  fd: file.fd,
  stat: file.stat,
  seek: (offset, from) => file.seek(offset, from),
  sync: file.sync,
  read: (buffer) => file.read(buffer),
  readAlloc: (size) => file.readAlloc(size),
  truncate: (length) => file.truncate(length),
  write: (buffer) => file.write(buffer),
  writeAll: (buffer) => beforeWriteAll.pipe(Effect.andThen(file.writeAll(buffer)))
})

const withBlobStore = <A, E>(
  use: (
    store: Effect.Success<ReturnType<typeof makeBlobStore>>,
    root: BlobRoot
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-blob-store-" })
    const root = Schema.decodeSync(BlobRoot)(directory)
    const store = yield* makeBlobStore({
      blobRoot: root,
      maximumBlobBytes: 64,
      maximumReadAllBytes: 64,
      maximumRangeBytes: 16
    })

    return yield* use(store, root)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("BlobDigest", () => {
  it("accepts only exact lowercase SHA-256 hex", () => {
    const canonical = "a".repeat(64)

    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(BlobDigest)(canonical)))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(BlobDigest)(canonical.toUpperCase())))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(BlobDigest)(canonical.slice(1))))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(BlobDigest)(`../${canonical.slice(3)}`)))
  })
})

describe("BlobStore", () => {
  it.effect("rejects a symbolic-link root before mutating its target", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-blob-link-parent-" })
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-blob-link-target-" })
      const linkedRoot = path.join(parent, "blobs")
      yield* fs.chmod(outside, 0o755)
      const modeBefore = (yield* fs.stat(outside)).mode & 0o777
      yield* fs.symlink(outside, linkedRoot)

      const result = yield* makeBlobStore({ blobRoot: Schema.decodeSync(BlobRoot)(linkedRoot) }).pipe(
        Effect.result
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, BlobContainmentError)
      assert.strictEqual((yield* fs.stat(outside)).mode & 0o777, modeBefore)
      assert.deepEqual(yield* fs.readDirectory(outside), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("publishes synced owner-only bytes in the two-level content tree", () =>
    withBlobStore((store, root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const bytes = encoder.encode("release evidence")
        const result = yield* store.put(WORKSPACE_A, bytes, "durable")
        const derived = blobPath(path, root, WORKSPACE_A, result.ref.digest)
        const fileInfo = yield* fs.stat(derived.file)
        const directoryInfo = yield* fs.stat(derived.objectDirectory)

        assert.isTrue(result.stored)
        assert.strictEqual(result.ref.sizeBytes, bytes.byteLength)
        assert.strictEqual(
          path.relative(root, derived.file),
          path.join(
            "objects",
            WORKSPACE_A,
            "sha256",
            result.ref.digest.slice(0, 2),
            result.ref.digest.slice(2, 4),
            result.ref.digest
          )
        )
        assert.strictEqual(fileInfo.mode & 0o777, 0o600)
        assert.strictEqual(directoryInfo.mode & 0o777, 0o700)
        assert.deepEqual(yield* fs.readFile(derived.file), bytes)
        assert.deepEqual(yield* fs.readDirectory(derived.objectDirectory), [result.ref.digest])
      })
    ))

  it.effect("deduplicates concurrent first writes while creating shared directories", () =>
    withBlobStore((store) =>
      Effect.gen(function*() {
        const results = yield* Effect.forEach(
          Array.from({ length: 100 }),
          () => store.put(WORKSPACE_A, encoder.encode("concurrent release evidence"), "durable"),
          { concurrency: "unbounded" }
        )

        assert.lengthOf(results.filter(({ stored }) => stored), 1)
        assert.lengthOf(results.filter(({ stored }) => !stored), 99)
        assert.lengthOf(new Set(results.map(({ ref }) => ref.digest)), 1)
      })
    ))

  it.effect("syncs the published directory before a concurrent link loser returns", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-loser-sync-" })
      const root = Schema.decodeSync(BlobRoot)(directory)
      const derived = blobPath(path, root, WORKSPACE_A, CONCURRENT_DIGEST)
      const bothAtLink = yield* Deferred.make<void>()
      const releaseWinner = yield* Deferred.make<void>()
      const linkAttempts = yield* Ref.make(0)
      const linkPublished = yield* Ref.make(false)
      const postLinkDirectorySyncs = yield* Ref.make(0)
      const faultingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        link: (fromPath, toPath) =>
          Effect.gen(function*() {
            const attempts = yield* Ref.updateAndGet(linkAttempts, (count) => count + 1)
            if (attempts === 2) yield* Deferred.succeed(bothAtLink, undefined)
            yield* Deferred.await(bothAtLink)
            yield* fs.link(fromPath, toPath)
            yield* Ref.set(linkPublished, true)
            yield* Deferred.await(releaseWinner)
          }),
        open: (requestedPath, options) =>
          fs.open(requestedPath, options).pipe(
            Effect.map((file) =>
              requestedPath === derived.objectDirectory && options?.flag === "r"
                ? withSyncProbe(
                  file,
                  Ref.get(linkPublished).pipe(
                    Effect.flatMap((published) =>
                      published ? Ref.update(postLinkDirectorySyncs, (count) => count + 1) : Effect.void
                    )
                  )
                )
                : file
            )
          )
      })
      const store = yield* makeBlobStore({ blobRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, faultingFileSystem)
      )
      const bytes = encoder.encode("concurrent release evidence")
      const first = yield* store.put(WORKSPACE_A, bytes, "durable").pipe(Effect.forkScoped)
      const second = yield* store.put(WORKSPACE_A, bytes, "durable").pipe(Effect.forkScoped)

      const loser = yield* Effect.raceFirst(Fiber.join(first), Fiber.join(second))
      const syncsBeforeWinnerContinues = yield* Ref.get(postLinkDirectorySyncs)
      yield* Deferred.succeed(releaseWinner, undefined)
      const results = yield* Fiber.joinAll([first, second])

      assert.isFalse(loser.stored)
      assert.lengthOf(results.filter(({ stored }) => stored), 1)
      assert.lengthOf(results.filter(({ stored }) => !stored), 1)
      assert.strictEqual(syncsBeforeWinnerContinues, 1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("deduplicates verified hits, repairs reproducible corruption, and rejects durable replacement", () =>
    withBlobStore((store, root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const bytes = encoder.encode("same bytes")
        const first = yield* store.put(WORKSPACE_A, bytes, "reproducible-cache")
        const second = yield* store.put(WORKSPACE_A, bytes, "reproducible-cache")

        assert.isFalse(second.stored)
        assert.strictEqual(second.ref.digest, first.ref.digest)

        const derived = blobPath(path, root, WORKSPACE_A, first.ref.digest)
        yield* fs.writeFile(derived.file, encoder.encode("corrupted"), { mode: 0o600 })

        const corruptPut = yield* store.put(WORKSPACE_A, bytes, "reproducible-cache").pipe(Effect.result)
        assert.isTrue(Result.isFailure(corruptPut))
        if (Result.isFailure(corruptPut)) {
          assert.strictEqual(corruptPut.failure._tag, "BlobIntegrityError")
        }

        const repaired = yield* store.repairReproducible(WORKSPACE_A, bytes)
        assert.isTrue(repaired.stored)
        assert.deepStrictEqual(yield* store.readAll(WORKSPACE_A, first.ref.digest), bytes)

        yield* fs.writeFile(derived.file, encoder.encode("corrupted"), { mode: 0o600 })
        const durable = yield* store.put(WORKSPACE_A, bytes, "durable").pipe(Effect.result)
        assert.isTrue(Result.isFailure(durable))
        if (Result.isFailure(durable)) {
          assert.strictEqual(durable.failure._tag, "BlobIntegrityError")
          assert.instanceOf(durable.failure, BlobIntegrityError)
        }
      })
    ))

  it.effect("finishes replacement durability before honoring repair interruption", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-repair-commit-" })
      const root = Schema.decodeSync(BlobRoot)(directory)
      const bytes = encoder.encode("restart-visible cache")
      const initial = yield* makeBlobStore({ blobRoot: root })
      const stored = yield* initial.put(WORKSPACE_A, bytes, "reproducible-cache")
      const derived = blobPath(path, root, WORKSPACE_A, stored.ref.digest)
      yield* fs.writeFile(derived.file, encoder.encode("corrupt cache bytes"), { mode: 0o600 })

      const commitStarted = yield* Deferred.make<void>()
      const releaseCommit = yield* Deferred.make<void>()
      const blockCommit = yield* Ref.make(true)
      const probingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (requestedPath, options) =>
          fs.open(requestedPath, options).pipe(
            Effect.map((file) =>
              requestedPath === derived.objectDirectory && options?.flag === "r"
                ? withSyncProbe(
                  file,
                  Ref.get(blockCommit).pipe(
                    Effect.flatMap((blocked) =>
                      blocked
                        ? Deferred.succeed(commitStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseCommit))
                        )
                        : Effect.void
                    )
                  )
                )
                : file
            )
          )
      })
      const repairing = yield* makeBlobStore({ blobRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, probingFileSystem)
      )
      const repairFiber = yield* repairing.repairReproducible(WORKSPACE_A, bytes).pipe(
        Effect.provideService(FileSystem.FileSystem, probingFileSystem),
        Effect.forkScoped
      )
      yield* Deferred.await(commitStarted)

      const interruptFinished = yield* Deferred.make<void>()
      const interruptFiber = yield* Fiber.interrupt(repairFiber).pipe(
        Effect.andThen(Deferred.succeed(interruptFinished, undefined)),
        Effect.forkScoped
      )
      yield* Effect.yieldNow
      assert.isFalse(yield* Deferred.isDone(interruptFinished))

      yield* Ref.set(blockCommit, false)
      yield* Deferred.succeed(releaseCommit, undefined)
      yield* Fiber.join(interruptFiber)

      const reopened = yield* makeBlobStore({ blobRoot: root })
      assert.deepStrictEqual(yield* reopened.readAll(WORKSPACE_A, stored.ref.digest), bytes)
      assert.deepStrictEqual(yield* fs.readDirectory(derived.objectDirectory), [stored.ref.digest])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("interrupts temporary repair writes without replacing existing bytes", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-repair-write-" })
      const root = Schema.decodeSync(BlobRoot)(directory)
      const bytes = encoder.encode("interruptible cache")
      const corrupt = encoder.encode("existing corruption")
      const initial = yield* makeBlobStore({ blobRoot: root })
      const stored = yield* initial.put(WORKSPACE_A, bytes, "reproducible-cache")
      const derived = blobPath(path, root, WORKSPACE_A, stored.ref.digest)
      yield* fs.writeFile(derived.file, corrupt, { mode: 0o600 })

      const writeStarted = yield* Deferred.make<void>()
      const blockingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (requestedPath, options) =>
          fs.open(requestedPath, options).pipe(
            Effect.map((file) =>
              requestedPath.includes(".incoming-")
                ? withWriteAllProbe(
                  file,
                  Deferred.succeed(writeStarted, undefined).pipe(Effect.andThen(Effect.never))
                )
                : file
            )
          )
      })
      const repairing = yield* makeBlobStore({ blobRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, blockingFileSystem)
      )
      const repairFiber = yield* repairing.repairReproducible(WORKSPACE_A, bytes).pipe(
        Effect.provideService(FileSystem.FileSystem, blockingFileSystem),
        Effect.forkScoped
      )
      yield* Deferred.await(writeStarted)
      yield* Fiber.interrupt(repairFiber)

      assert.deepStrictEqual(yield* fs.readFile(derived.file), corrupt)
      assert.deepStrictEqual(yield* fs.readDirectory(derived.objectDirectory), [stored.ref.digest])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("does not resolve a digest through another workspace", () =>
    withBlobStore((store) =>
      Effect.gen(function*() {
        const stored = yield* store.put(WORKSPACE_A, encoder.encode("private workspace bytes"), "durable")
        const crossWorkspaceRead = yield* store.readAll(WORKSPACE_B, stored.ref.digest).pipe(Effect.result)

        assert.isTrue(Result.isFailure(crossWorkspaceRead))
        if (Result.isFailure(crossWorkspaceRead)) {
          assert.instanceOf(crossWorkspaceRead.failure, BlobNotFoundError)
        }
      })
    ))

  it.effect("checks the allocation bound before readAll and verifies returned bytes", () =>
    withBlobStore((store, root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const bytes = encoder.encode("0123456789")
        const stored = yield* store.put(WORKSPACE_A, bytes, "durable")
        const bounded = yield* store.readAll(WORKSPACE_A, stored.ref.digest, 5).pipe(Effect.result)

        assert.isTrue(Result.isFailure(bounded))
        if (Result.isFailure(bounded)) {
          assert.instanceOf(bounded.failure, BlobTooLargeError)
        }

        assert.deepEqual(yield* store.readAll(WORKSPACE_A, stored.ref.digest, 10), bytes)

        const derived = blobPath(path, root, WORKSPACE_A, stored.ref.digest)
        yield* fs.writeFile(derived.file, encoder.encode("abcdefghij"), { mode: 0o600 })
        const corrupted = yield* store.readAll(WORKSPACE_A, stored.ref.digest, 10).pipe(Effect.result)

        assert.isTrue(Result.isFailure(corrupted))
        if (Result.isFailure(corrupted)) {
          assert.instanceOf(corrupted.failure, BlobIntegrityError)
        }
      })
    ))

  it.effect("provides bounded range and streaming reads without claiming whole-object verification", () =>
    withBlobStore((store) =>
      Effect.gen(function*() {
        const stored = yield* store.put(WORKSPACE_A, encoder.encode("abcdefghijklmnop"), "durable")
        const range = yield* store.readRange(WORKSPACE_A, stored.ref.digest, { offset: 4, length: 6 })
        const opened = yield* store.readStream(WORKSPACE_A, stored.ref.digest, { offset: 10, length: 6 })
        const chunks = yield* opened.bytes.pipe(Stream.runCollect)
        const streamed = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
        let offset = 0

        for (const chunk of chunks) {
          streamed.set(chunk, offset)
          offset += chunk.byteLength
        }

        assert.strictEqual(range.integrity, "not-verified")
        assert.strictEqual(decoder.decode(range.bytes), "efghij")
        assert.strictEqual(opened.integrity, "not-verified")
        assert.strictEqual(decoder.decode(streamed), "klmnop")
      })
    ))

  it.effect("pins a lazy stream to the validated inode before reading bytes", () =>
    withBlobStore((store, root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const stored = yield* store.put(WORKSPACE_A, encoder.encode("trusted release bytes"), "durable")
        const opened = yield* store.readStream(WORKSPACE_A, stored.ref.digest)
        const derived = blobPath(path, root, WORKSPACE_A, stored.ref.digest)
        const outsideDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-swap-" })
        const outsideFile = path.join(outsideDirectory, "outside-secret")

        yield* fs.writeFile(outsideFile, encoder.encode("must never be emitted"), { mode: 0o600 })
        yield* fs.remove(derived.file)
        yield* fs.symlink(outsideFile, derived.file)

        const result = yield* opened.bytes.pipe(Stream.runCollect, Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, BlobContainmentError)
        }
      })
    ))

  it.effect("opens before validation and never returns bytes from a swapped outside path", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-read-swap-" })
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-read-secret-" })
      const root = Schema.decodeSync(BlobRoot)(directory)
      const attackEnabled = yield* Ref.make(false)
      const swapped = yield* Ref.make(false)
      const trusted = encoder.encode("TRUSTED")
      const secret = encoder.encode("SECRET!")
      const secretPath = path.join(outside, "secret")
      yield* fs.writeFile(secretPath, secret, { mode: 0o600 })

      const swapOnce = Effect.fn("test.swapReadPath")(function*(derivedFile: string) {
        if (!(yield* Ref.get(attackEnabled)) || (yield* Ref.getAndSet(swapped, true))) return
        yield* fs.remove(derivedFile)
        yield* fs.symlink(secretPath, derivedFile)
      })
      const faultingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (requestedPath, options) =>
          Effect.gen(function*() {
            yield* swapOnce(requestedPath)
            return yield* fs.open(requestedPath, options)
          }),
        realPath: (requestedPath) =>
          Effect.gen(function*() {
            const resolved = yield* fs.realPath(requestedPath)
            yield* swapOnce(requestedPath)
            return resolved
          })
      })
      const store = yield* makeBlobStore({ blobRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, faultingFileSystem)
      )
      const stored = yield* store.put(WORKSPACE_A, trusted, "durable")
      const derived = blobPath(path, root, WORKSPACE_A, stored.ref.digest)
      yield* Ref.set(attackEnabled, true)

      const result = yield* store.readRange(WORKSPACE_A, stored.ref.digest, {
        offset: 0,
        length: secret.byteLength
      }).pipe(Effect.result)

      assert.isTrue(yield* Ref.get(swapped))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, BlobContainmentError)
      assert.notInclude(JSON.stringify(result), decoder.decode(secret))
      assert.strictEqual(yield* fs.realPath(derived.file), secretPath)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("fails a range when the opened descriptor reaches premature EOF", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-range-eof-" })
      const root = Schema.decodeSync(BlobRoot)(directory)
      const truncateEnabled = yield* Ref.make(false)
      const truncated = yield* Ref.make(false)
      const bytes = encoder.encode("abcdefghijklmnop")
      const faultingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (requestedPath, options) =>
          fs.open(requestedPath, options).pipe(
            Effect.map((file) =>
              withReadAllocProbe(
                file,
                Effect.gen(function*() {
                  if (!(yield* Ref.get(truncateEnabled)) || (yield* Ref.getAndSet(truncated, true))) return
                  yield* fs.truncate(requestedPath, 0)
                })
              )
            )
          )
      })
      const store = yield* makeBlobStore({ blobRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, faultingFileSystem)
      )
      const stored = yield* store.put(WORKSPACE_A, bytes, "durable")
      yield* Ref.set(truncateEnabled, true)
      const result = yield* store.readRange(WORKSPACE_A, stored.ref.digest, {
        offset: 0,
        length: bytes.byteLength
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, BlobUnexpectedEofError)
      assert.isTrue(yield* Ref.get(truncated))
      assert.isTrue(yield* fs.exists(blobPath(path, root, WORKSPACE_A, stored.ref.digest).file))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("fails a stream when the opened descriptor reaches premature EOF", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-stream-eof-" })
      const root = Schema.decodeSync(BlobRoot)(directory)
      const truncateEnabled = yield* Ref.make(false)
      const truncated = yield* Ref.make(false)
      const bytes = encoder.encode("abcdefghijklmnop")
      const faultingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (requestedPath, options) =>
          fs.open(requestedPath, options).pipe(
            Effect.map((file) =>
              withReadAllocProbe(
                file,
                Effect.gen(function*() {
                  if (!(yield* Ref.get(truncateEnabled)) || (yield* Ref.getAndSet(truncated, true))) return
                  yield* fs.truncate(requestedPath, 0)
                })
              )
            )
          )
      })
      const store = yield* makeBlobStore({ blobRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, faultingFileSystem)
      )
      const stored = yield* store.put(WORKSPACE_A, bytes, "durable")
      const opened = yield* store.readStream(WORKSPACE_A, stored.ref.digest)
      yield* Ref.set(truncateEnabled, true)
      const result = yield* opened.bytes.pipe(Stream.runCollect, Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, BlobUnexpectedEofError)
      assert.isTrue(yield* Ref.get(truncated))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects oversized writes and oversized corruption before verification reads", () =>
    withBlobStore((store, root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const oversizedPut = yield* store.put(WORKSPACE_A, new Uint8Array(65), "durable").pipe(Effect.result)

        assert.isTrue(Result.isFailure(oversizedPut))
        if (Result.isFailure(oversizedPut)) {
          assert.instanceOf(oversizedPut.failure, BlobTooLargeError)
        }

        const stored = yield* store.put(WORKSPACE_A, encoder.encode("small"), "durable")
        const derived = blobPath(path, root, WORKSPACE_A, stored.ref.digest)
        yield* fs.writeFile(derived.file, new Uint8Array(65), { mode: 0o600 })

        const oversizedVerify = yield* store.verify(WORKSPACE_A, stored.ref.digest).pipe(Effect.result)
        assert.isTrue(Result.isFailure(oversizedVerify))
        if (Result.isFailure(oversizedVerify)) {
          assert.instanceOf(oversizedVerify.failure, BlobTooLargeError)
        }
      })
    ))

  it.effect("rejects oversized input before requesting a SHA-256 digest", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const cryptoService = yield* Crypto.Crypto
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-oversize-first-" })
      const root = Schema.decodeSync(BlobRoot)(directory)
      const digestCalls = yield* Ref.make(0)
      const probingCrypto = Crypto.Crypto.of({
        ...cryptoService,
        digest: (algorithm, bytes) =>
          Ref.update(digestCalls, (count) => count + 1).pipe(
            Effect.andThen(cryptoService.digest(algorithm, bytes))
          )
      })
      const store = yield* makeBlobStore({
        blobRoot: root,
        maximumBlobBytes: 64,
        maximumReadAllBytes: 64,
        maximumRangeBytes: 16
      }).pipe(Effect.provideService(Crypto.Crypto, probingCrypto))
      const result = yield* store.put(WORKSPACE_A, new Uint8Array(65), "durable").pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, BlobTooLargeError)
        assert.isNull(result.failure.digest)
      }
      assert.strictEqual(yield* Ref.get(digestCalls), 0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects oversized and out-of-bounds range reads", () =>
    withBlobStore((store) =>
      Effect.gen(function*() {
        const stored = yield* store.put(WORKSPACE_A, encoder.encode("abcdefghijklmnop"), "durable")
        const oversized = yield* store.readRange(WORKSPACE_A, stored.ref.digest, {
          offset: 0,
          length: 17
        }).pipe(Effect.result)
        const outOfBounds = yield* store.readRange(WORKSPACE_A, stored.ref.digest, {
          offset: 16,
          length: 1
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(oversized))
        if (Result.isFailure(oversized)) {
          assert.instanceOf(oversized.failure, BlobStoreInputError)
        }
        assert.isTrue(Result.isFailure(outOfBounds))
        if (Result.isFailure(outOfBounds)) {
          assert.instanceOf(outOfBounds.failure, BlobStoreInputError)
        }
      })
    ))

  it.effect("rejects a symbolic-link shard before writing outside blobRoot", () =>
    withBlobStore((store, root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const bytes = encoder.encode("link guarded")
        const known = yield* store.put(WORKSPACE_B, bytes, "durable")
        const target = blobPath(path, root, WORKSPACE_A, known.ref.digest)
        const shaDirectory = path.join(target.workspaceDirectory, "sha256")
        const firstShard = path.dirname(target.objectDirectory)
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-outside-" })

        yield* fs.makeDirectory(shaDirectory, { recursive: true, mode: 0o700 })
        yield* fs.symlink(outside, firstShard)

        const result = yield* store.put(WORKSPACE_A, bytes, "durable").pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, BlobContainmentError)
        }
        assert.deepEqual(yield* fs.readDirectory(outside), [])
      })
    ))

  it.effect("pins publication when a validated shard is actively replaced", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-active-swap-" })
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-active-outside-" })
      const root = Schema.decodeSync(BlobRoot)(directory)
      const derived = blobPath(path, root, WORKSPACE_A, CONCURRENT_DIGEST)
      const displacedShard = `${derived.objectDirectory}-displaced`
      const swapped = yield* Ref.make(false)
      const faultingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (requestedPath, options) =>
          Effect.gen(function*() {
            if (requestedPath.includes(".incoming-") && !(yield* Ref.getAndSet(swapped, true))) {
              yield* fs.rename(derived.objectDirectory, displacedShard)
              yield* fs.symlink(outside, derived.objectDirectory)
            }
            return yield* fs.open(requestedPath, options)
          })
      })
      const store = yield* makeBlobStore({ blobRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, faultingFileSystem)
      )
      const result = yield* store.put(
        WORKSPACE_A,
        encoder.encode("concurrent release evidence"),
        "durable"
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, BlobContainmentError)
      assert.deepEqual(yield* fs.readDirectory(outside), [])
      assert.deepEqual(yield* fs.readDirectory(displacedShard), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("fails closed when directory descriptor aliases are unavailable", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-no-fd-alias-" })
      const root = Schema.decodeSync(BlobRoot)(directory)
      const derived = blobPath(path, root, WORKSPACE_A, CONCURRENT_DIGEST)
      const faultingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        realPath: (requestedPath) =>
          requestedPath.startsWith("/proc/self/fd/") || requestedPath.startsWith("/dev/fd/")
            ? Effect.fail(PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "realPath"
            }))
            : fs.realPath(requestedPath)
      })
      const store = yield* makeBlobStore({ blobRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, faultingFileSystem)
      )
      const result = yield* store.put(
        WORKSPACE_A,
        encoder.encode("concurrent release evidence"),
        "durable"
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, BlobContainmentError)
      assert.deepEqual(yield* fs.readDirectory(derived.objectDirectory), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("closes file handles so the object root is removable after use", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectory({ prefix: "control-center-blob-teardown-" })
      const root = Schema.decodeSync(BlobRoot)(directory)
      const store = yield* makeBlobStore({ blobRoot: root })

      yield* store.put(WORKSPACE_A, encoder.encode("close every handle"), "durable")
      yield* fs.remove(root, { recursive: true })

      assert.isFalse(yield* fs.exists(root))
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("redacts absolute paths from platform failure errors", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const file = yield* fs.makeTempFileScoped({ prefix: "control-center-secret-path-" })
      const root = Schema.decodeSync(BlobRoot)(file)
      const result = yield* makeBlobStore({ blobRoot: root }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.notInclude(JSON.stringify(result.failure), file)
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("fails initialization when the blob-root directory cannot be synced", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "control-center-sync-fault-" })
      const root = Schema.decodeSync(BlobRoot)(directory)
      const faultingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (requestedPath, options) =>
          requestedPath === root && options?.flag === "r"
            ? Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "open"
            }))
            : fs.open(requestedPath, options)
      })
      const result = yield* makeBlobStore({ blobRoot: root }).pipe(
        Effect.provideService(FileSystem.FileSystem, faultingFileSystem),
        Effect.result
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, BlobStoreIoError)
        assert.strictEqual(result.failure.operation, "open directory for sync")
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
