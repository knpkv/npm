import type { Crypto, FileSystem, Path } from "effect"
import { Effect, Result } from "effect"

import { type BlobStoreError, blobStoreIoError } from "./BlobStoreError.js"
import type { PinnedDirectory } from "./PinnedDirectory.js"

export const BLOB_FILE_MODE = 0o600
const TEMPORARY_NAME_ATTEMPTS = 4

const openFailure = <E>(error: E): { readonly _tag: "OpenFailure"; readonly error: E } => ({
  _tag: "OpenFailure",
  error
})

const linkResult = <A>(linked: A): { readonly _tag: "LinkResult"; readonly linked: A } => ({
  _tag: "LinkResult",
  linked
})

/** Builds crash-safe exclusive publication around captured platform services. */
export const makeBlobPublisher = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cryptoService: Crypto.Crypto
) => {
  const temporaryName = Effect.fn("BlobStore.temporaryName")(function*(directory: string) {
    const random = yield* cryptoService.randomBytes(16).pipe(
      Effect.mapError((cause) => blobStoreIoError("create temporary name", cause))
    )
    const suffix = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")
    return path.join(directory, `.incoming-${suffix}`)
  })

  return Effect.fn("BlobStore.publish")(function*(
    directory: PinnedDirectory,
    destinationName: string,
    bytes: Uint8Array,
    mode: "exclusive" | "replace" = "exclusive",
    commit?: ((destination: string) => Effect.Effect<void, BlobStoreError>) | undefined
  ) {
    const destination = path.join(directory.path, destinationName)
    for (let attempt = 0; attempt < TEMPORARY_NAME_ATTEMPTS; attempt += 1) {
      const temporary = yield* temporaryName(directory.path)
      const outcome = yield* Effect.scoped(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function*() {
            const opened = yield* fs.open(temporary, { flag: "wx", mode: BLOB_FILE_MODE }).pipe(Effect.result)

            if (Result.isFailure(opened)) {
              return openFailure(opened.failure)
            }

            yield* Effect.addFinalizer(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore))
            yield* restore(opened.success.writeAll(bytes)).pipe(
              Effect.mapError((cause) => blobStoreIoError("write temporary blob", cause))
            )
            yield* restore(opened.success.sync).pipe(
              Effect.mapError((cause) => blobStoreIoError("sync temporary blob", cause))
            )

            const linked = yield* (mode === "replace"
              ? fs.rename(temporary, destination)
              : fs.link(temporary, destination)).pipe(Effect.result)
            if (Result.isSuccess(linked) && commit !== undefined) yield* commit(destination)
            return linkResult(linked)
          })
        )
      )

      if (outcome._tag === "LinkResult") {
        return outcome.linked
      }

      if (outcome.error.reason._tag !== "AlreadyExists") {
        return yield* blobStoreIoError("open temporary blob", outcome.error)
      }
    }

    return yield* blobStoreIoError("open temporary blob", "temporary filename collision limit reached")
  })
}
