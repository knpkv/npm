import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { inspectPackageContract } from "./package-contract.js"
import {
  inspectSourceBoundaries,
  inspectStylesheetBoundaries,
  type SourceBoundaryViolation
} from "./source-boundaries.js"

class BoundaryValidationError extends Data.TaggedError("BoundaryValidationError")<{
  readonly reason: string
}> {}

const sourceFiles: (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("controlCenter.sourceFiles")(
  function*(fs, path, directory) {
    const files: Array<string> = []
    for (const entry of yield* fs.readDirectory(directory)) {
      const absolute = path.join(directory, entry)
      const info = yield* fs.stat(absolute)
      if (info.type === "Directory") {
        for (const file of yield* sourceFiles(fs, path, absolute)) files.push(file)
      } else if (info.type === "File" && /\.(?:css|tsx?)$/.test(entry)) files.push(absolute)
    }
    return files
  }
)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const packageSource = yield* fs.readFileString(path.join(packageRoot, "package.json"))
  const packageData = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(packageSource).pipe(
    Effect.mapError(() => new BoundaryValidationError({ reason: "package.json is not valid JSON" }))
  )
  const packageViolations = inspectPackageContract(packageData)
  if (packageViolations.length > 0) {
    return yield* Effect.fail(
      new BoundaryValidationError({
        reason: `Control Center package-contract violations:\n${packageViolations.join("\n")}`
      })
    )
  }

  const sourceRoot = path.join(packageRoot, "src")
  const violations: Array<SourceBoundaryViolation> = []
  for (const file of yield* sourceFiles(fs, path, sourceRoot)) {
    const sourcePath = path.relative(packageRoot, file).replaceAll("\\", "/")
    const source = yield* fs.readFileString(file)
    const fileViolations = sourcePath.endsWith(".css")
      ? inspectStylesheetBoundaries(sourcePath, source)
      : inspectSourceBoundaries(sourcePath, source)
    for (const violation of fileViolations) violations.push(violation)
  }

  if (violations.length > 0) {
    const details = violations
      .map(({ importPath, reason, sourcePath }) => `${sourcePath}: ${reason} (${JSON.stringify(importPath)})`)
      .join("\n")
    return yield* Effect.fail(
      new BoundaryValidationError({ reason: `Control Center source-boundary violations:\n${details}` })
    )
  }
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
