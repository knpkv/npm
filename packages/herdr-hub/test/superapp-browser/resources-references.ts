import { Data, Effect, FileSystem, Path, Result } from "effect"
import { resourcesStates } from "./resources-fixture.js"

export class ResourcesReferenceInventoryError extends Data.TaggedError("ResourcesReferenceInventoryError")<{
  readonly directory: string
  readonly reason: "missing_directory" | "missing_files"
  readonly missingFiles: ReadonlyArray<string>
}> {
  override get message() {
    return this.reason === "missing_directory"
      ? `Design reference directory missing: ${this.directory}`
      : `Design references missing from ${this.directory}: ${this.missingFiles.join(", ")}`
  }
}

const requiredReferences = resourcesStates.flatMap((state) =>
  [390, 1280].flatMap((width) => ["light", "dark"].map((theme) => `host-resources--${state}--${width}-${theme}.png`))
)

/** A null listing means the configured directory is absent; unrelated entries are allowed. */
export const validateResourcesReferences = (
  directory: string,
  listing: ReadonlyArray<string> | null
): Result.Result<void, ResourcesReferenceInventoryError> => {
  if (listing === null) {
    return Result.fail(
      new ResourcesReferenceInventoryError({ directory, reason: "missing_directory", missingFiles: [] })
    )
  }
  const entries = new Set(listing)
  const missingFiles = requiredReferences.filter((name) => !entries.has(name))
  return missingFiles.length === 0 ?
    Result.succeed(undefined) :
    Result.fail(new ResourcesReferenceInventoryError({ directory, reason: "missing_files", missingFiles }))
}

/** Checks configured references before collection; filesystem checks follow symlinks. */
export const checkResourcesReferences = Effect.fn("ResourcesTest.checkReferences")(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const listing = yield* fs.readDirectory(directory).pipe(
    Effect.catchTag(
      "PlatformError",
      (error) => error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error)
    )
  )
  yield* Effect.fromResult(validateResourcesReferences(directory, listing))
  const inspected = yield* Effect.forEach(requiredReferences, (name) =>
    fs.stat(paths.join(directory, name)).pipe(
      Effect.map((info) => info.type === "File" ? null : name),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(name) : Effect.fail(error))
    ), { concurrency: 4 })
  const missingFiles = inspected.filter((name) => name !== null)
  if (missingFiles.length > 0) {
    return yield* new ResourcesReferenceInventoryError({ directory, reason: "missing_files", missingFiles })
  }
})
