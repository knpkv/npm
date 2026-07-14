import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import {
  inspectSourceBoundaries,
  inspectStylesheetBoundaries,
  type SourceBoundaryViolation
} from "./source-boundaries.js"

const PRODUCTION_SOURCE_EXTENSION = /\.(?:css|[cm]?[jt]s|[jt]sx)$/iu

const sourceFiles: (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("controlCenter.sourceFiles")(
  function*(fileSystem, path, directory) {
    const files: Array<string> = []
    for (const entry of yield* fileSystem.readDirectory(directory)) {
      const absolute = path.join(directory, entry)
      const info = yield* fileSystem.stat(absolute)
      if (info.type === "Directory") {
        for (const file of yield* sourceFiles(fileSystem, path, absolute)) files.push(file)
      } else if (info.type === "File" && PRODUCTION_SOURCE_EXTENSION.test(entry)) {
        files.push(absolute)
      }
    }
    return files
  }
)

/** Recursively inspect every supported production source file below a package's src directory. */
export const inspectProductionSourceBoundaries = Effect.fn("controlCenter.inspectProductionSourceBoundaries")(
  function*(
    packageRoot: string
  ): Effect.fn.Return<
    ReadonlyArray<SourceBoundaryViolation>,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sourceRoot = path.join(packageRoot, "src")
    const violations: Array<SourceBoundaryViolation> = []

    for (const file of yield* sourceFiles(fileSystem, path, sourceRoot)) {
      const sourcePath = path.relative(packageRoot, file).replaceAll("\\", "/")
      const source = yield* fileSystem.readFileString(file)
      const fileViolations = sourcePath.endsWith(".css")
        ? inspectStylesheetBoundaries(sourcePath, source)
        : inspectSourceBoundaries(sourcePath, source)
      for (const violation of fileViolations) violations.push(violation)
    }

    return violations
  }
)
