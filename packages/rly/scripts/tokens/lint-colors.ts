import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { findColorPolicyViolations } from "./raw-colors.js"

class ColorLintError extends Data.TaggedError("ColorLintError")<{
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

const listSources: (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("rly.listColorSources")(
  function*(fs, path, directory) {
    const files: Array<string> = []
    if (!(yield* fs.exists(directory))) return files
    for (const entry of yield* fs.readDirectory(directory)) {
      const absolute = path.join(directory, entry)
      const info = yield* fs.stat(absolute)
      if (info.type === "Directory") {
        for (const file of yield* listSources(fs, path, absolute)) files.push(file)
      } else if (info.type === "File" && /\.(?:css|ts|tsx)$/.test(entry)) files.push(absolute)
    }
    return files
  }
)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)))))
  const roots = ["foundations", "primitives", "patterns", "diff"].map((directory) =>
    path.join(packageRoot, "src", directory)
  )
  const files: Array<string> = []
  for (const root of roots) for (const file of yield* listSources(fs, path, root)) files.push(file)
  const violations = []
  for (const file of files.sort()) {
    const source = yield* fs.readFileString(file)
    for (const violation of findColorPolicyViolations(path.relative(packageRoot, file), source)) {
      violations.push(violation)
    }
  }
  if (violations.length > 0) {
    return yield* Effect.fail(
      new ColorLintError({
        reason: violations.map((violation) =>
          `${violation.path}:${violation.line}:${violation.column} ${violation.rule}`
        ).join("\n")
      })
    )
  }
  yield* Console.log(`rly color policy checked ${files.length} component sources`)
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
