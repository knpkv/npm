import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { inspectRlyCssTokens, type RlyCssTokenViolation } from "./rlyCssTokens.js"

export const RLY_CSS_TOKEN_SOURCE_ROOTS: ReadonlyArray<string> = [
  "packages/control-center/src",
  "packages/rly/src"
]

const cssFiles: (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("workspace.rlyCssFiles")(
  function*(fileSystem, path, directory) {
    const files: Array<string> = []
    for (const entry of yield* fileSystem.readDirectory(directory)) {
      const absolute = path.join(directory, entry)
      const info = yield* fileSystem.stat(absolute)
      if (info.type === "Directory") {
        for (const file of yield* cssFiles(fileSystem, path, absolute)) files.push(file)
      } else if (info.type === "File" && entry.endsWith(".css")) {
        files.push(absolute)
      }
    }
    return files
  }
)

export interface RlyCssTokenWorkspaceInspection {
  readonly filesChecked: number
  readonly violations: ReadonlyArray<RlyCssTokenViolation>
}

/** Inspect every rly and Control Center production stylesheet against one generated token contract. */
export const inspectRlyCssTokenWorkspace = Effect.fn("workspace.inspectRlyCssTokenWorkspace")(
  function*(
    workspaceRoot: string,
    generatedTokens: ReadonlySet<string>
  ): Effect.fn.Return<
    RlyCssTokenWorkspaceInspection,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const files: Array<string> = []
    for (const sourceRoot of RLY_CSS_TOKEN_SOURCE_ROOTS) {
      for (const file of yield* cssFiles(fileSystem, path, path.join(workspaceRoot, sourceRoot))) files.push(file)
    }

    const violations: Array<RlyCssTokenViolation> = []
    for (const file of files.sort()) {
      const sourcePath = path.relative(workspaceRoot, file).replaceAll("\\", "/")
      const source = yield* fileSystem.readFileString(file)
      for (const violation of inspectRlyCssTokens(sourcePath, source, generatedTokens)) violations.push(violation)
    }

    return { filesChecked: files.length, violations }
  }
)
