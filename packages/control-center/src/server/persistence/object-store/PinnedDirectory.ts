import type { FileSystem, Path } from "effect"
import { Effect, Option, Result } from "effect"

import { BlobContainmentError, blobStoreIoError } from "./BlobStoreError.js"

/** Descriptor-backed directory alias used for containment-safe publication. */
export interface PinnedDirectory {
  readonly path: string
  readonly sync: Effect.Effect<void, ReturnType<typeof blobStoreIoError>>
  readonly assertIdentity: Effect.Effect<void, BlobContainmentError>
}

const descriptorAliases = (path: Path.Path, descriptor: FileSystem.File.Descriptor) => [
  path.join("/proc/self/fd", String(descriptor)),
  path.join("/dev/fd", String(descriptor))
]

const sameIdentity = (left: FileSystem.File.Info, right: FileSystem.File.Info): boolean =>
  left.dev === right.dev &&
  Option.isSome(left.ino) &&
  Option.isSome(right.ino) &&
  left.ino.value === right.ino.value

const sameDescriptorAlias = (alias: FileSystem.File.Info, opened: FileSystem.File.Info): boolean =>
  alias.type === opened.type &&
  Option.isSome(alias.ino) &&
  Option.isSome(opened.ino) &&
  alias.ino.value === opened.ino.value

/** Resolve a verified alias for the exact object already held by a descriptor. */
export const resolveDescriptorAlias = Effect.fn("BlobStore.resolveDescriptorAlias")(function*(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  descriptor: FileSystem.File.Descriptor,
  openedInfo: FileSystem.File.Info,
  expectedPath: string,
  operation: string
) {
  for (const alias of descriptorAliases(path, descriptor)) {
    const aliasInfo = yield* fs.stat(alias).pipe(Effect.result)
    const expectedInfo = yield* fs.stat(expectedPath).pipe(Effect.result)
    const canonicalExpected = yield* fs.realPath(expectedPath).pipe(Effect.result)
    if (
      Result.isSuccess(aliasInfo) &&
      Result.isSuccess(expectedInfo) &&
      Result.isSuccess(canonicalExpected) &&
      canonicalExpected.success === expectedPath &&
      sameDescriptorAlias(aliasInfo.success, openedInfo) &&
      sameIdentity(openedInfo, expectedInfo.success)
    ) return alias
  }

  return yield* new BlobContainmentError({
    operation,
    message: "opened descriptor does not match its expected contained path"
  })
})

/**
 * Pin an already validated directory and fail closed when the platform cannot
 * address children through that exact descriptor.
 */
export const pinDirectory = Effect.fn("BlobStore.pinDirectory")(function*(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
) {
  const handle = yield* fs.open(directory, { flag: "r" }).pipe(
    Effect.mapError((cause) => blobStoreIoError("pin object directory", cause))
  )

  const openedInfo = yield* handle.stat.pipe(
    Effect.mapError((cause) => blobStoreIoError("inspect pinned object directory", cause))
  )
  const alias = yield* resolveDescriptorAlias(fs, path, handle.fd, openedInfo, directory, "publish blob")
  const traversedAlias = yield* fs.stat(`${alias}${path.sep}.`).pipe(Effect.result)
  if (Result.isFailure(traversedAlias) || !sameIdentity(openedInfo, traversedAlias.success)) {
    return yield* new BlobContainmentError({
      operation: "publish blob",
      message: "platform cannot address children through the pinned directory descriptor"
    })
  }
  const assertIdentity = Effect.gen(function*() {
    const current = yield* handle.stat.pipe(Effect.result)
    const pathInfo = yield* fs.stat(directory).pipe(Effect.result)
    if (
      Result.isFailure(current) ||
      Result.isFailure(pathInfo) ||
      !sameIdentity(openedInfo, current.success) ||
      !sameIdentity(openedInfo, pathInfo.success)
    ) {
      return yield* new BlobContainmentError({
        operation: "publish blob",
        message: "pinned object directory identity changed"
      })
    }
  })
  return {
    path: alias,
    sync: handle.sync.pipe(
      Effect.mapError((cause) => blobStoreIoError("sync pinned object directory", cause))
    ),
    assertIdentity
  } satisfies PinnedDirectory
})
