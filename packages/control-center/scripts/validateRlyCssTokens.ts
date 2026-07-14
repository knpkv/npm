import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { declaredRlyCssTokens, inspectRlyCssTokens } from "./rlyCssTokens.js"

class RlyCssTokenValidationError extends Data.TaggedError("RlyCssTokenValidationError")<{
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

const cssFiles: (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("controlCenter.cssFiles")(
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

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const workspaceRoot = path.dirname(path.dirname(packageRoot))
  const generatedTokenPath = path.join(workspaceRoot, "packages", "rly", "src", "styles", "generated-tokens.css")
  const generatedTokenSource = yield* fileSystem.readFileString(generatedTokenPath)
  const generatedTokens = declaredRlyCssTokens(generatedTokenSource)
  if (generatedTokens.size === 0) {
    return yield* new RlyCssTokenValidationError({ reason: "The generated rly token contract contains no tokens" })
  }

  const files = [...(yield* cssFiles(fileSystem, path, path.join(packageRoot, "src")))].sort()
  const violations = []
  for (const file of files) {
    const sourcePath = path.relative(packageRoot, file).replaceAll("\\", "/")
    const source = yield* fileSystem.readFileString(file)
    for (const violation of inspectRlyCssTokens(sourcePath, source, generatedTokens)) violations.push(violation)
  }

  if (violations.length > 0) {
    return yield* new RlyCssTokenValidationError({
      reason: violations
        .map(({ column, line, sourcePath, token }) =>
          `${sourcePath}:${line}:${column} unresolved rly custom property ${token}`
        )
        .join("\n")
    })
  }

  yield* Console.log(`Control Center rly token references checked ${files.length} stylesheets`)
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
