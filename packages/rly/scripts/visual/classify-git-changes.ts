import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { classifyVisualChanges, type VisualClassification } from "./classify-changes.js"
import { parseGitNameStatus } from "./git-changes.js"

class VisualGitError extends Data.TaggedError("VisualGitError")<{
  readonly reason: string
}> {}

const VisualCatalogJson = Schema.fromJsonString(Schema.Struct({
  components: Schema.Array(Schema.Struct({
    name: Schema.String,
    paths: Schema.Struct({
      source: Schema.String,
      story: Schema.String,
      styles: Schema.Array(Schema.String),
      tests: Schema.Array(Schema.String)
    }),
    storyId: Schema.String
  })),
  schemaVersion: Schema.Literal(1)
}))

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024
const failClosed: VisualClassification = { reasons: ["git-or-catalog-failure"], scope: "full" }

const option = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  const base = option(args, "--base")
  const head = option(args, "--head")
  if (base === undefined || head === undefined) {
    return yield* Effect.fail(new VisualGitError({ reason: "Usage: --base <ref> --head <ref>" }))
  }

  const packageRoot = path.dirname(path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)))))
  const workspaceRoot = path.dirname(path.dirname(packageRoot))
  const runGit = (gitArgs: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make("git", gitArgs, { cwd: workspaceRoot })).pipe(
      Effect.flatMap((output) =>
        output.length > MAX_GIT_OUTPUT_BYTES
          ? Effect.fail(new VisualGitError({ reason: "Git output exceeded the classifier bound" }))
          : Effect.succeed(output)
      ),
      Effect.mapError(() => new VisualGitError({ reason: "Git command failed" }))
    )
  const resolveRef = (ref: string) =>
    runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).pipe(
      Effect.flatMap((output) => {
        const revision = output.trim()
        return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)
          ? Effect.succeed(revision)
          : Effect.fail(new VisualGitError({ reason: "Git returned an invalid object id" }))
      })
    )

  const baseRevision = yield* resolveRef(base)
  const headRevision = yield* resolveRef(head)
  const diff = yield* runGit([
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--find-copies",
    "--diff-filter=ACDMRTUXB",
    `${baseRevision}...${headRevision}`,
    "--"
  ])
  const changes = yield* Effect.try({
    try: () => parseGitNameStatus(diff),
    catch: () => new VisualGitError({ reason: "Git change output is malformed" })
  })

  const currentSource = yield* fs.readFileString(path.join(packageRoot, "generated", "visual-catalog.json"))
  const currentCatalog = yield* Schema.decodeUnknownEffect(VisualCatalogJson)(currentSource).pipe(
    Effect.mapError(() => new VisualGitError({ reason: "Current visual catalog is malformed" }))
  )
  const baseSource = yield* runGit([
    "show",
    `${baseRevision}:packages/rly/generated/visual-catalog.json`
  ])
  const baseCatalog = yield* Schema.decodeUnknownEffect(VisualCatalogJson)(baseSource).pipe(
    Effect.mapError(() => new VisualGitError({ reason: "Base visual catalog is malformed" }))
  )

  return classifyVisualChanges({ baseCatalog, changes, currentCatalog })
})

NodeRuntime.runMain(
  program.pipe(
    Effect.catchCause(() => Effect.succeed(failClosed)),
    Effect.flatMap((classification) => Console.log(JSON.stringify(classification)))
  ).pipe(Effect.provide(NodeServices.layer)),
  { disableErrorReporting: true }
)
