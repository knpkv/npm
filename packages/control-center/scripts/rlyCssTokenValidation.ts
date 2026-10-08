import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { inspectRlyCssTokens, type RlyCssTokenViolation } from "./rlyCssTokens.js"

/**
 * Every workspace package's `src` tree, found on disk rather than listed: a hand-kept list missed
 * the herdr packages, whose stylesheets referenced tokens rly never defined.
 */
const rlyCssTokenSourceRoots: (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  workspaceRoot: string
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("workspace.rlyCssSourceRoots")(
  function*(fileSystem, path, workspaceRoot) {
    const packages = path.join(workspaceRoot, "packages")
    const roots: Array<string> = []
    for (const entry of [...(yield* fileSystem.readDirectory(packages))].sort()) {
      // packages/ also holds loose files, such as notes; only a directory is a package.
      if ((yield* fileSystem.stat(path.join(packages, entry))).type !== "Directory") continue
      const source = path.join(packages, entry, "src")
      if (yield* fileSystem.exists(source)) roots.push(source)
    }
    return roots
  }
)

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
  readonly sourceRootsChecked: number
  readonly violations: ReadonlyArray<RlyCssTokenViolation>
}

/** Inspect every Rly stylesheet and application consumer against one generated token contract. */
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
    const sourceRoots = yield* rlyCssTokenSourceRoots(fileSystem, path, workspaceRoot)
    for (const sourceRoot of sourceRoots) {
      for (const file of yield* cssFiles(fileSystem, path, sourceRoot)) files.push(file)
    }

    const violations: Array<RlyCssTokenViolation> = []
    for (const file of files.sort()) {
      const sourcePath = path.relative(workspaceRoot, file).replaceAll("\\", "/")
      const source = yield* fileSystem.readFileString(file)
      for (const violation of inspectRlyCssTokens(sourcePath, source, generatedTokens)) violations.push(violation)
    }

    return { filesChecked: files.length, sourceRootsChecked: sourceRoots.length, violations }
  }
)
