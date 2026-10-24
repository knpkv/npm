import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { posix } from "node:path"
import { URL } from "node:url"
import * as TypeScript from "typescript"

import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

class TsconfigReferencesError extends Data.TaggedError("TsconfigReferencesError") {
  get message() {
    return this.reason
  }
}

const fail = (reason) => new TsconfigReferencesError({ reason })

/**
 * The project references in one package tsconfig that point into another package. `tsc -b` follows them and
 * rebuilds that package's dist, which races the other package builds and checks reading it in parallel. A
 * package consumes its workspace dependencies through their built exports instead.
 * `file` is repository-relative (`packages/<name>/tsconfig*.json`).
 */
export const crossPackageReferences = (file, config) => {
  const packageDirectory = file.split("/").slice(0, 2).join("/")
  return (config.references ?? [])
    .filter(({ path }) => {
      const target = posix.normalize(posix.join(posix.dirname(file), path))
      return target !== packageDirectory && !target.startsWith(`${packageDirectory}/`)
    })
    .map(({ path }) => ({ file, reference: path }))
}

/**
 * Checks every package tsconfig (`tsconfig*.json` at any depth under `packages/`) under `repositoryRoot`, never one under
 * `node_modules`; returns the failures and the file count.
 */
export const checkTsconfigReferences = Effect.fn("TsconfigReferences.check")(function* (repositoryRoot) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const failures = []
  let files = 0
  const packages = path.join(repositoryRoot, "packages")
  const entries = (yield* fs.readDirectory(packages, { recursive: true }))
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => !entry.split("/").includes("node_modules") && /(^|\/)tsconfig[^/]*\.json$/u.test(entry))
    .toSorted()
  for (const entry of entries) {
    if (entry.split("/").length < 2) continue
    const file = `packages/${entry}`
    const parsed = TypeScript.parseConfigFileTextToJson(file, yield* fs.readFileString(path.join(packages, entry)))
    if (parsed.error !== undefined) return yield* fail(`${file} is not valid JSON with comments`)
    files += 1
    for (const failure of crossPackageReferences(file, parsed.config)) failures.push(failure)
  }
  return { failures, files }
})

const program = Effect.gen(function* () {
  const path = yield* Path.Path
  const repositoryRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const result = yield* checkTsconfigReferences(repositoryRoot)
  if (result.failures.length > 0) {
    const listed = result.failures.map(({ file, reference }) => `- ${file} -> ${reference}`).join("\n")
    return yield* fail(
      [
        "tsconfig references leave their package (tsc -b would rebuild the other package beside parallel builds):",
        listed,
        "Fix: drop the reference; the package resolves its workspace dependencies through their built exports."
      ].join("\n")
    )
  }
  yield* Console.log(`tsconfig references: ${result.files} package tsconfigs reference only their own package`)
}).pipe(Effect.mapError((cause) => (cause._tag === "TsconfigReferencesError" ? cause : fail(String(cause)))))

// Report a failure as its message alone (no stack), then exit non-zero.
const main = program.pipe(
  Effect.tapError((error) => Console.error(error.reason)),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
