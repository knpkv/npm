import type { FileSystem, Path } from "effect"
import { Effect, Result } from "effect"

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

/** Resolve a verified alias for the exact object already held by a descriptor. */
export const resolveDescriptorAlias = Effect.fn("BlobStore.resolveDescriptorAlias")(function*(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  descriptor: FileSystem.File.Descriptor,
  expectedPath: string,
  operation: string
) {
  for (const alias of descriptorAliases(path, descriptor)) {
    const resolved = yield* fs.realPath(alias).pipe(Effect.result)
    if (Result.isSuccess(resolved) && resolved.success === expectedPath) return alias
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

  const alias = yield* resolveDescriptorAlias(fs, path, handle.fd, directory, "publish blob")
  const assertIdentity = fs.realPath(alias).pipe(
    Effect.result,
    Effect.flatMap((current) =>
      Result.isSuccess(current) && current.success === directory
        ? Effect.void
        : new BlobContainmentError({
          operation: "publish blob",
          message: "pinned object directory identity changed"
        })
    )
  )
  return {
    path: alias,
    sync: handle.sync.pipe(
      Effect.mapError((cause) => blobStoreIoError("sync pinned object directory", cause))
    ),
    assertIdentity
  } satisfies PinnedDirectory
})
