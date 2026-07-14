import { Context, Crypto, Effect, FileSystem, Layer, Path, Result, Schema } from "effect"

import { WorkspaceId } from "../../../domain/identifiers.js"
import { BlobRoot } from "../PersistenceConfig.js"
import { BlobDigest } from "./BlobDigest.js"
import { blobPath } from "./BlobPath.js"
import { BLOB_FILE_MODE, makeBlobPublisher } from "./BlobPublisher.js"
import { BlobClassification, BlobRef } from "./BlobRef.js"
import {
  BlobContainmentError,
  BlobIntegrityError,
  type BlobStoreError,
  BlobStoreInputError,
  blobStoreIoError,
  BlobTooLargeError
} from "./BlobStoreError.js"
import type { BlobRange, BlobRangeRead, BlobReadStream, BlobVerification } from "./BlobStoreTypes.js"
import { makeOpenedBlobReader } from "./OpenedBlob.js"
import { pinDirectory } from "./PinnedDirectory.js"

const DIRECTORY_MODE = 0o700
const DEFAULT_MAXIMUM_READ_ALL_BYTES = 8 * 1024 * 1024
const DEFAULT_MAXIMUM_RANGE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAXIMUM_BLOB_BYTES = 256 * 1024 * 1024
const INTEGRITY_NOT_VERIFIED: "not-verified" = "not-verified"

const NonNegativeSafeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const PositiveSafeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))

/** Options used when constructing the owner-only object directory. */
export interface BlobStoreOptions {
  readonly blobRoot: BlobRoot
  readonly maximumBlobBytes?: number | undefined
  readonly maximumReadAllBytes?: number | undefined
  readonly maximumRangeBytes?: number | undefined
}

/** Result of a content-addressed write. */
export interface BlobPutResult {
  readonly ref: BlobRef
  readonly stored: boolean
}

interface BlobStoreService {
  readonly put: (
    workspaceId: WorkspaceId,
    bytes: Uint8Array,
    classification: BlobClassification
  ) => Effect.Effect<BlobPutResult, BlobStoreError>
  readonly readAll: (
    workspaceId: WorkspaceId,
    digest: BlobDigest,
    maximumBytes?: number | undefined
  ) => Effect.Effect<Uint8Array, BlobStoreError>
  readonly readRange: (
    workspaceId: WorkspaceId,
    digest: BlobDigest,
    range: BlobRange
  ) => Effect.Effect<BlobRangeRead, BlobStoreError>
  readonly readStream: (
    workspaceId: WorkspaceId,
    digest: BlobDigest,
    range?: BlobRange | undefined
  ) => Effect.Effect<BlobReadStream, BlobStoreError>
  /** Replace corrupt bytes only after ContentStore authorizes persisted reproducible-cache metadata. */
  readonly repairReproducible: (
    workspaceId: WorkspaceId,
    bytes: Uint8Array
  ) => Effect.Effect<BlobPutResult, BlobStoreError>
  readonly verify: (
    workspaceId: WorkspaceId,
    digest: BlobDigest
  ) => Effect.Effect<BlobVerification, BlobStoreError>
}

/** Workspace-isolated, content-addressed byte storage. */
export class BlobStore extends Context.Service<BlobStore, BlobStoreService>()(
  "@knpkv/control-center/server/persistence/BlobStore"
) {
  static readonly layer = (
    options: BlobStoreOptions
  ): Layer.Layer<BlobStore, BlobStoreError, Crypto.Crypto | FileSystem.FileSystem | Path.Path> =>
    Layer.effect(BlobStore, makeBlobStore(options))
}

const decodeInput = <S extends Schema.ConstraintDecoder<unknown>>(
  operation: string,
  schema: S,
  input: unknown
): Effect.Effect<S["Type"], BlobStoreInputError> => {
  const result = Schema.decodeUnknownResult(schema)(input)

  return Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(new BlobStoreInputError({ operation, message: "input failed schema validation" }))
}

/** Constructs a blob store while capturing the platform services in its layer. */
export const makeBlobStore: (
  options: BlobStoreOptions
) => Effect.Effect<
  BlobStore["Service"],
  BlobStoreError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> = Effect.fn("BlobStore.make")(function*(options: BlobStoreOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto
  const maximumBlobBytes = yield* decodeInput(
    "configure maximumBlobBytes",
    PositiveSafeInteger,
    options.maximumBlobBytes ?? DEFAULT_MAXIMUM_BLOB_BYTES
  )
  const maximumReadAllBytes = yield* decodeInput(
    "configure maximumReadAllBytes",
    PositiveSafeInteger,
    options.maximumReadAllBytes ?? DEFAULT_MAXIMUM_READ_ALL_BYTES
  )
  const maximumRangeBytes = yield* decodeInput(
    "configure maximumRangeBytes",
    PositiveSafeInteger,
    options.maximumRangeBytes ?? DEFAULT_MAXIMUM_RANGE_BYTES
  )
  const decodedBlobRoot = yield* decodeInput("configure blobRoot", BlobRoot, options.blobRoot)
  const configuredRoot = path.resolve(decodedBlobRoot)

  if (maximumReadAllBytes > maximumBlobBytes || maximumRangeBytes > maximumBlobBytes) {
    return yield* new BlobStoreInputError({
      operation: "configure blob limits",
      message: "read bounds cannot exceed the maximum blob size"
    })
  }

  const syncDirectory = Effect.fn("BlobStore.syncDirectory")(function*(directory: string) {
    yield* Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* fs.open(directory, { flag: "r" }).pipe(
          Effect.mapError((cause) => blobStoreIoError("open directory for sync", cause))
        )
        yield* handle.sync.pipe(
          Effect.mapError((cause) => blobStoreIoError("sync directory", cause))
        )
      })
    )
  })

  const missingDirectories: Array<string> = []
  let existingAncestor = configuredRoot

  while (
    !(yield* fs.exists(existingAncestor).pipe(
      Effect.mapError((cause) => blobStoreIoError("check blob root ancestor", cause))
    ))
  ) {
    missingDirectories.unshift(existingAncestor)
    const parent = path.dirname(existingAncestor)

    if (parent === existingAncestor) {
      break
    }
    existingAncestor = parent
  }

  for (const directory of missingDirectories) {
    yield* fs.makeDirectory(directory, { mode: DIRECTORY_MODE }).pipe(
      Effect.mapError((cause) => blobStoreIoError("create blob root directory", cause))
    )
    yield* fs.chmod(directory, DIRECTORY_MODE).pipe(
      Effect.mapError((cause) => blobStoreIoError("secure blob root directory", cause))
    )
    yield* syncDirectory(directory)
    yield* syncDirectory(path.dirname(directory))
  }

  yield* fs.chmod(configuredRoot, DIRECTORY_MODE).pipe(
    Effect.mapError((cause) => blobStoreIoError("secure blob root", cause))
  )
  yield* syncDirectory(configuredRoot)

  const canonicalRoot = yield* fs.realPath(configuredRoot).pipe(
    Effect.mapError((cause) => blobStoreIoError("resolve blob root", cause))
  )
  const rootInfo = yield* fs.stat(canonicalRoot).pipe(
    Effect.mapError((cause) => blobStoreIoError("inspect blob root", cause))
  )

  if (rootInfo.type !== "Directory") {
    return yield* new BlobContainmentError({
      operation: "initialize",
      message: "blobRoot must resolve to a directory"
    })
  }

  const isContained = (candidate: string): boolean =>
    candidate === canonicalRoot || candidate.startsWith(`${canonicalRoot}${path.sep}`)

  const digestBytes = Effect.fn("BlobStore.digestBytes")(function*(bytes: Uint8Array) {
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError((cause) => blobStoreIoError("digest", cause))
    )
    const encoded = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")

    return yield* decodeInput("digest", BlobDigest, encoded)
  })

  const secureDirectory = Effect.fn("BlobStore.secureDirectory")(function*(directory: string) {
    if (!isContained(directory)) {
      return yield* new BlobContainmentError({
        operation: "secure directory",
        message: "derived directory escaped blobRoot"
      })
    }

    const exists = yield* fs.exists(directory).pipe(
      Effect.mapError((cause) => blobStoreIoError("check object directory", cause))
    )

    if (!exists) {
      const created = yield* fs.makeDirectory(directory, { mode: DIRECTORY_MODE }).pipe(Effect.result)
      if (Result.isFailure(created) && created.failure.reason._tag !== "AlreadyExists") {
        return yield* blobStoreIoError("create object directory", created.failure)
      }
    }

    const canonicalDirectory = yield* fs.realPath(directory).pipe(
      Effect.mapError((cause) => blobStoreIoError("resolve object directory", cause))
    )

    if (canonicalDirectory !== directory || !isContained(canonicalDirectory)) {
      return yield* new BlobContainmentError({
        operation: "secure directory",
        message: "object directory crossed a symbolic link"
      })
    }

    const info = yield* fs.stat(canonicalDirectory).pipe(
      Effect.mapError((cause) => blobStoreIoError("inspect object directory", cause))
    )

    if (info.type !== "Directory") {
      return yield* new BlobContainmentError({
        operation: "secure directory",
        message: "object path is not a directory"
      })
    }

    yield* fs.chmod(canonicalDirectory, DIRECTORY_MODE).pipe(
      Effect.mapError((cause) => blobStoreIoError("secure object directory", cause))
    )

    if (!exists) {
      yield* syncDirectory(canonicalDirectory)
      yield* syncDirectory(path.dirname(canonicalDirectory))
    }
  })

  const decodeReference = Effect.fn("BlobStore.decodeReference")(function*(
    operation: string,
    workspaceId: WorkspaceId,
    digest: BlobDigest
  ) {
    const decodedWorkspaceId = yield* decodeInput(operation, WorkspaceId, workspaceId)
    const decodedDigest = yield* decodeInput(operation, BlobDigest, digest)
    const derived = blobPath(path, canonicalRoot, decodedWorkspaceId, decodedDigest)

    if (!isContained(derived.file)) {
      return yield* new BlobContainmentError({
        operation,
        message: "derived object path escaped blobRoot"
      })
    }

    return { workspaceId: decodedWorkspaceId, digest: decodedDigest, derived }
  })

  const openedBlobReader = makeOpenedBlobReader(fs, path)

  const locate = Effect.fn("BlobStore.locate")(function*(
    operation: string,
    workspaceId: WorkspaceId,
    digest: BlobDigest
  ) {
    const reference = yield* decodeReference(operation, workspaceId, digest)
    const info = yield* openedBlobReader.inspect(operation, {
      digest: reference.digest,
      filePath: reference.derived.file
    })

    if (
      info.size > BigInt(maximumBlobBytes) ||
      info.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      (info.mode & 0o077) !== 0
    ) {
      if (info.size > BigInt(maximumBlobBytes)) {
        return yield* new BlobTooLargeError({
          digest: reference.digest,
          actualBytes: info.size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(info.size),
          maximumBytes: maximumBlobBytes
        })
      }

      return yield* new BlobContainmentError({
        operation,
        message: "blob path is not a supported regular file"
      })
    }

    return { ...reference, info, sizeBytes: Number(info.size) }
  })

  const pinnedLocation = (located: Effect.Success<ReturnType<typeof locate>>) => ({
    digest: located.digest,
    filePath: located.derived.file,
    info: located.info
  })

  const verifyLocated = Effect.fn("BlobStore.verifyLocated")(function*(
    located: Effect.Success<ReturnType<typeof locate>>
  ) {
    const bytes = yield* openedBlobReader.read("verify blob", pinnedLocation(located), 0, located.sizeBytes)
    const actualDigest = yield* digestBytes(bytes)

    if (actualDigest !== located.digest) {
      return yield* new BlobIntegrityError({ expectedDigest: located.digest, actualDigest })
    }

    return bytes
  })

  const readLocatedBounded = Effect.fn("BlobStore.readLocatedBounded")(function*(
    located: Effect.Success<ReturnType<typeof locate>>,
    maximumBytes: number
  ) {
    const bytes = yield* openedBlobReader.read(
      "read bounded blob",
      pinnedLocation(located),
      0,
      located.sizeBytes
    )

    if (located.sizeBytes > maximumBytes || located.sizeBytes !== bytes.byteLength) {
      return yield* new BlobTooLargeError({
        digest: located.digest,
        actualBytes: located.sizeBytes,
        maximumBytes
      })
    }

    const actualDigest = yield* digestBytes(bytes)

    if (actualDigest !== located.digest) {
      return yield* new BlobIntegrityError({ expectedDigest: located.digest, actualDigest })
    }

    return bytes
  })

  const verify = Effect.fn("BlobStore.verify")(function*(workspaceId: WorkspaceId, digest: BlobDigest) {
    const located = yield* locate("verify blob", workspaceId, digest)
    const bytes = yield* verifyLocated(located)

    return {
      digest: located.digest,
      sizeBytes: bytes.byteLength
    }
  })

  const publish = makeBlobPublisher(fs, path, cryptoService)

  const put = Effect.fn("BlobStore.put")(function*(
    workspaceId: WorkspaceId,
    bytes: Uint8Array,
    classification: BlobClassification
  ) {
    const decodedWorkspaceId = yield* decodeInput("put blob", WorkspaceId, workspaceId)
    const decodedClassification = yield* decodeInput(
      "put blob",
      BlobClassification,
      classification
    )
    if (bytes.byteLength > maximumBlobBytes) {
      return yield* new BlobTooLargeError({
        digest: null,
        actualBytes: bytes.byteLength,
        maximumBytes: maximumBlobBytes
      })
    }

    const digest = yield* digestBytes(bytes)

    const derived = blobPath(path, canonicalRoot, decodedWorkspaceId, digest)

    yield* secureDirectory(path.join(canonicalRoot, "objects"))
    yield* secureDirectory(derived.workspaceDirectory)
    yield* secureDirectory(path.join(derived.workspaceDirectory, "sha256"))
    yield* secureDirectory(path.dirname(derived.objectDirectory))
    yield* secureDirectory(derived.objectDirectory)

    const existing = yield* fs.exists(derived.file).pipe(
      Effect.mapError((cause) => blobStoreIoError("check blob cache", cause))
    )

    if (existing) {
      yield* Effect.scoped(
        Effect.gen(function*() {
          const pinned = yield* pinDirectory(fs, path, derived.objectDirectory)
          yield* pinned.sync
          yield* pinned.assertIdentity
        })
      )
      const verification = yield* verify(decodedWorkspaceId, digest).pipe(Effect.result)
      if (Result.isSuccess(verification)) {
        return {
          ref: new BlobRef({
            workspaceId: decodedWorkspaceId,
            digest,
            sizeBytes: bytes.byteLength,
            classification: decodedClassification
          }),
          stored: false
        }
      }
      return yield* verification.failure
    }

    const linked = yield* Effect.scoped(
      Effect.gen(function*() {
        const pinned = yield* pinDirectory(fs, path, derived.objectDirectory)
        const pinnedDestination = path.join(pinned.path, digest)
        const result = yield* publish(pinned, digest, bytes)

        if (Result.isFailure(result)) {
          const wonByAnotherWriter = yield* fs.exists(pinnedDestination).pipe(
            Effect.mapError((cause) => blobStoreIoError("check concurrent blob write", cause))
          )

          if (!wonByAnotherWriter) {
            return yield* blobStoreIoError("publish blob", result.failure)
          }
        } else {
          yield* fs.chmod(pinnedDestination, BLOB_FILE_MODE).pipe(
            Effect.mapError((cause) => blobStoreIoError("secure blob", cause))
          )
        }

        // Every writer, including a hard-link loser, establishes publication
        // durability before SQL metadata is allowed to become visible.
        yield* pinned.sync
        const identity = yield* pinned.assertIdentity.pipe(Effect.result)

        if (Result.isFailure(identity)) {
          if (Result.isSuccess(result)) {
            yield* fs.remove(pinnedDestination, { force: true }).pipe(
              Effect.mapError((cause) => blobStoreIoError("remove displaced publication", cause))
            )
            yield* pinned.sync
          }
          return yield* identity.failure
        }
        return result
      })
    )

    yield* verify(decodedWorkspaceId, digest)

    return {
      ref: new BlobRef({
        workspaceId: decodedWorkspaceId,
        digest,
        sizeBytes: bytes.byteLength,
        classification: decodedClassification
      }),
      stored: Result.isSuccess(linked)
    }
  })

  const repairReproducible = Effect.fn("BlobStore.repairReproducible")(function*(
    workspaceId: WorkspaceId,
    bytes: Uint8Array
  ) {
    const decodedWorkspaceId = yield* decodeInput("repair blob", WorkspaceId, workspaceId)
    if (bytes.byteLength > maximumBlobBytes) {
      return yield* new BlobTooLargeError({
        digest: null,
        actualBytes: bytes.byteLength,
        maximumBytes: maximumBlobBytes
      })
    }
    const digest = yield* digestBytes(bytes)
    const derived = blobPath(path, canonicalRoot, decodedWorkspaceId, digest)
    yield* secureDirectory(derived.objectDirectory)
    yield* Effect.scoped(
      Effect.gen(function*() {
        const pinned = yield* pinDirectory(fs, path, derived.objectDirectory)
        const replaced = yield* publish(
          pinned,
          digest,
          bytes,
          "replace",
          (pinnedDestination) =>
            fs.chmod(pinnedDestination, BLOB_FILE_MODE).pipe(
              Effect.mapError((cause) => blobStoreIoError("secure repaired blob", cause)),
              Effect.andThen(pinned.sync),
              Effect.andThen(pinned.assertIdentity)
            )
        )
        if (Result.isFailure(replaced)) return yield* blobStoreIoError("repair blob", replaced.failure)
      })
    )
    yield* verify(decodedWorkspaceId, digest)
    return {
      ref: new BlobRef({
        workspaceId: decodedWorkspaceId,
        digest,
        sizeBytes: bytes.byteLength,
        classification: "reproducible-cache"
      }),
      stored: true
    }
  })

  const readAll = Effect.fn("BlobStore.readAll")(function*(
    workspaceId: WorkspaceId,
    digest: BlobDigest,
    requestedMaximumBytes?: number | undefined
  ) {
    const limit = yield* decodeInput(
      "read all blob",
      PositiveSafeInteger,
      requestedMaximumBytes ?? maximumReadAllBytes
    )

    if (limit > maximumReadAllBytes) {
      return yield* new BlobStoreInputError({
        operation: "read all blob",
        message: "requested bound exceeds the configured readAll maximum"
      })
    }

    const located = yield* locate("read all blob", workspaceId, digest)

    if (located.sizeBytes > limit) {
      return yield* new BlobTooLargeError({
        digest: located.digest,
        actualBytes: located.sizeBytes,
        maximumBytes: limit
      })
    }

    return yield* readLocatedBounded(located, limit)
  })

  const decodeRange = Effect.fn("BlobStore.decodeRange")(function*(range: BlobRange) {
    const offset = yield* decodeInput("read blob range", NonNegativeSafeInteger, range.offset)
    const length = yield* decodeInput("read blob range", PositiveSafeInteger, range.length)

    if (length > maximumRangeBytes) {
      return yield* new BlobStoreInputError({
        operation: "read blob range",
        message: `range length exceeds ${maximumRangeBytes} bytes`
      })
    }

    return { offset, length }
  })

  const readRange = Effect.fn("BlobStore.readRange")(function*(
    workspaceId: WorkspaceId,
    digest: BlobDigest,
    requestedRange: BlobRange
  ) {
    const range = yield* decodeRange(requestedRange)
    const located = yield* locate("read blob range", workspaceId, digest)

    if (range.offset > located.sizeBytes || range.length > located.sizeBytes - range.offset) {
      return yield* new BlobStoreInputError({
        operation: "read blob range",
        message: "range exceeds blob length"
      })
    }

    const bytes = yield* openedBlobReader.read(
      "read blob range",
      pinnedLocation(located),
      range.offset,
      range.length
    )

    return {
      digest: located.digest,
      sizeBytes: located.sizeBytes,
      integrity: INTEGRITY_NOT_VERIFIED,
      bytes
    }
  })

  const readStream = Effect.fn("BlobStore.readStream")(function*(
    workspaceId: WorkspaceId,
    digest: BlobDigest,
    requestedRange?: BlobRange | undefined
  ) {
    const located = yield* locate("stream blob", workspaceId, digest)
    const range = requestedRange === undefined ? undefined : yield* decodeRange(requestedRange)

    if (
      range !== undefined &&
      (range.offset > located.sizeBytes || range.length > located.sizeBytes - range.offset)
    ) {
      return yield* new BlobStoreInputError({
        operation: "stream blob",
        message: "range exceeds blob length"
      })
    }

    const offset = range?.offset ?? 0
    const length = range?.length ?? located.sizeBytes

    return {
      digest: located.digest,
      sizeBytes: located.sizeBytes,
      integrity: INTEGRITY_NOT_VERIFIED,
      bytes: openedBlobReader.stream("stream blob", pinnedLocation(located), offset, length)
    }
  })

  return BlobStore.of({ put, readAll, readRange, readStream, repairReproducible, verify })
})
