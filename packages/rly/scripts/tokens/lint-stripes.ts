/**
 * Fails when any rly or prototype stylesheet draws a one-sided accent stripe (see
 * accent-stripes.ts). Run with `pnpm lint:stripes`; part of `pnpm lint`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { findAccentStripes } from "./accent-stripes.js"

class StripeLintError extends Data.TaggedError("StripeLintError")<{
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
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("rly.listStripeSources")(
  function*(fs, path, directory) {
    const files: Array<string> = []
    if (!(yield* fs.exists(directory))) return files
    for (const entry of yield* fs.readDirectory(directory)) {
      const absolute = path.join(directory, entry)
      const info = yield* fs.stat(absolute)
      if (info.type === "Directory") {
        for (const file of yield* listSources(fs, path, absolute)) files.push(file)
      } else if (info.type === "File" && /\.css$/.test(entry)) files.push(absolute)
    }
    return files
  }
)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)))))
  const roots = [
    ...["foundations", "primitives", "patterns", "diff", "styles"].map((directory) =>
      path.join(packageRoot, "src", directory)
    ),
    path.join(packageRoot, "stories")
  ]
  const files: Array<string> = []
  for (const root of roots) for (const file of yield* listSources(fs, path, root)) files.push(file)
  const violations = []
  for (const file of files.sort()) {
    const source = yield* fs.readFileString(file)
    for (const violation of findAccentStripes(path.relative(packageRoot, file), source)) {
      violations.push(violation)
    }
  }
  if (violations.length > 0) {
    return yield* new StripeLintError({
      reason: violations.map((violation) =>
        `${violation.path}:${violation.line}:${violation.column} one-sided accent stripe: ${violation.declaration}`
      ).join("\n")
    })
  }
  yield* Console.log(`rly stripe policy checked ${files.length} stylesheets`)
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    // The lint script is the executable boundary for Node services.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
