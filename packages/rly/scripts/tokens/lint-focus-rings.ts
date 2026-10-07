import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { findFocusRingViolations } from "./raw-colors.js"

/**
 * Every product draws the one rly focus ring: a stylesheet anywhere under `packages/*\/src` that
 * outlines in `--rly-color-focus` takes its width from `--rly-focus-ring-width`, and an inset ring
 * negates the width. rly's own sources get the same rules from `lint:colors`.
 */
class FocusRingLintError extends Data.TaggedError("FocusRingLintError")<{
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

const SKIPPED = new Set(["node_modules", "dist", "generated", "storybook-static", "test-results"])

const listStylesheets: (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("rly.listFocusRingStylesheets")(
  function*(fs, path, directory) {
    const files: Array<string> = []
    if (!(yield* fs.exists(directory))) return files
    for (const entry of yield* fs.readDirectory(directory)) {
      if (SKIPPED.has(entry)) continue
      const absolute = path.join(directory, entry)
      const info = yield* fs.stat(absolute)
      if (info.type === "Directory") {
        for (const file of yield* listStylesheets(fs, path, absolute)) files.push(file)
      } else if (info.type === "File" && entry.endsWith(".css")) files.push(absolute)
    }
    return files
  }
)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)))))
  const repoRoot = path.dirname(path.dirname(packageRoot))
  const packages = path.join(repoRoot, "packages")
  const files: Array<string> = []
  for (const name of yield* fs.readDirectory(packages)) {
    // packages/ also holds plain files (notes); only package directories have a src tree.
    if ((yield* fs.stat(path.join(packages, name))).type !== "Directory") continue
    const source = path.join(packages, name, "src")
    for (const file of yield* listStylesheets(fs, path, source)) files.push(file)
  }
  const violations = []
  for (const file of files.sort()) {
    const source = yield* fs.readFileString(file)
    for (const violation of findFocusRingViolations(path.relative(repoRoot, file), source)) violations.push(violation)
  }
  if (violations.length > 0) {
    return yield* Effect.fail(
      new FocusRingLintError({
        reason: violations.map((violation) =>
          `${violation.path}:${violation.line}:${violation.column} ${violation.rule}`
        ).join("\n")
      })
    )
  }
  yield* Console.log(`focus rings checked ${files.length} stylesheets`)
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
