import type { Path } from "effect"
import { Effect, FileSystem, Option, Result, Stream } from "effect"

import type { BlobDigest } from "./BlobDigest.js"
import { BlobContainmentError, BlobNotFoundError, blobStoreIoError, BlobUnexpectedEofError } from "./BlobStoreError.js"
import type { BlobStoreError } from "./BlobStoreError.js"
import { resolveDescriptorAlias } from "./PinnedDirectory.js"

const READ_CHUNK_BYTES = 64 * 1024

/** Expected contained path and digest for an opened blob. */
export interface BlobFileReference {
  readonly digest: BlobDigest
  readonly filePath: string
}

/** File identity captured from a verified descriptor. */
export interface PinnedBlobLocation extends BlobFileReference {
  readonly info: FileSystem.File.Info
}

const streamStep = (
  bytes: Uint8Array,
  nextOffset: number
): readonly [Uint8Array, number] => [bytes, nextOffset]

const concatenate = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const bytes = new Uint8Array(size)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}

/** Builds descriptor-first readers around captured filesystem and path services. */
export const makeOpenedBlobReader = (
  fs: FileSystem.FileSystem,
  path: Path.Path
) => {
  const openExpected = Effect.fn("BlobStore.openExpected")(function*(
    operation: string,
    reference: BlobFileReference,
    expectedInfo?: FileSystem.File.Info
  ) {
    const opened = yield* fs.open(reference.filePath, { flag: "r" }).pipe(Effect.result)

    if (Result.isFailure(opened)) {
      if (opened.failure.reason._tag === "NotFound") {
        return yield* new BlobNotFoundError({ digest: reference.digest })
      }
      return yield* blobStoreIoError(operation, opened.failure)
    }

    const file = opened.success
    yield* resolveDescriptorAlias(fs, path, file.fd, reference.filePath, operation)
    const openedInfo = yield* file.stat.pipe(
      Effect.mapError((cause) => blobStoreIoError(operation, cause))
    )

    if (openedInfo.type !== "File" || (openedInfo.mode & 0o077) !== 0) {
      return yield* new BlobContainmentError({
        operation,
        message: "opened blob is not a supported regular file"
      })
    }

    if (expectedInfo !== undefined) {
      const sameInode = Option.isSome(expectedInfo.ino) &&
        Option.isSome(openedInfo.ino) &&
        expectedInfo.ino.value === openedInfo.ino.value

      if (
        openedInfo.dev !== expectedInfo.dev ||
        !sameInode ||
        openedInfo.size !== expectedInfo.size
      ) {
        return yield* new BlobContainmentError({
          operation,
          message: "opened blob no longer matches its contained path"
        })
      }
    }

    return { file, info: openedInfo }
  })

  const inspect = Effect.fn("BlobStore.inspectOpened")(function*(
    operation: string,
    reference: BlobFileReference
  ) {
    return yield* Effect.scoped(
      openExpected(operation, reference).pipe(Effect.map((opened) => opened.info))
    )
  })

  const streamFromFile = (
    operation: string,
    file: FileSystem.File,
    bytesToRead: number
  ): Stream.Stream<Uint8Array, BlobStoreError> =>
    Stream.unfold(0, (totalBytesRead) => {
      if (totalBytesRead >= bytesToRead) return Effect.succeed(undefined)

      const remaining = bytesToRead - totalBytesRead
      return file.readAlloc(Math.min(READ_CHUNK_BYTES, remaining)).pipe(
        Effect.mapError((cause) => blobStoreIoError(operation, cause)),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              new BlobUnexpectedEofError({
                operation,
                expectedBytes: bytesToRead,
                actualBytes: totalBytesRead
              }),
            onSome: (bytes) =>
              bytes.byteLength === 0
                ? new BlobUnexpectedEofError({
                  operation,
                  expectedBytes: bytesToRead,
                  actualBytes: totalBytesRead
                })
                : Effect.succeed(streamStep(bytes, totalBytesRead + bytes.byteLength))
          })
        )
      )
    })

  const stream = (
    operation: string,
    location: PinnedBlobLocation,
    offset: number,
    length: number
  ): Stream.Stream<Uint8Array, BlobStoreError> =>
    Stream.unwrap(
      Effect.gen(function*() {
        const opened = yield* openExpected(operation, location, location.info)

        if (offset > 0) yield* opened.file.seek(FileSystem.Size(offset), "start")

        return streamFromFile(operation, opened.file, length)
      })
    )

  const read = Effect.fn("BlobStore.readPinned")(function*(
    operation: string,
    location: PinnedBlobLocation,
    offset: number,
    length: number
  ) {
    const chunks = yield* stream(operation, location, offset, length).pipe(Stream.runCollect)
    const bytes = concatenate(chunks)

    if (bytes.byteLength !== length) {
      return yield* new BlobUnexpectedEofError({
        operation,
        expectedBytes: length,
        actualBytes: bytes.byteLength
      })
    }
    return bytes
  })

  return { inspect, read, stream }
}
