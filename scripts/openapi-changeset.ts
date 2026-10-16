/**
 * Writes the changeset for a regenerated OpenAPI client, released as the spec diff
 * demands. Run by the API update workflows after `regenerate`, while HEAD still holds
 * the previous specs:
 *
 *   node scripts/openapi-changeset.ts --package @knpkv/clockify-api-client \
 *     --spec packages/clockify-api-client/.specs/clockify-v1.json \
 *     --patch @knpkv/jira-clockify \
 *     --summary "Update the generated Clockify API client." \
 *     --out ".changeset/clockify-api-spec-update-${GITHUB_RUN_ID}.md" \
 *     --github-output "$GITHUB_OUTPUT"
 *
 * Each `--spec` is compared with its HEAD version (`openapi-spec-diff.ts`); the client
 * gets the highest release any of them needs and every `--patch` consumer a patch.
 * `--github-output` also exports `bump` and `release-notes` for the pull request body.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Schema from "effect/Schema"

import { type Change, type Classification, classify, releaseNotes } from "./openapi-spec-diff.ts"

class OpenApiChangesetError extends Data.TaggedError("OpenApiChangesetError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const RANK = { patch: 0, minor: 1, major: 2 } satisfies Record<Classification["bump"], number>

const readSpecs = Effect.fn("OpenApiChangeset.readSpecs")(function*(spec: string) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const previous = yield* spawner.string(ChildProcess.make("git", ["show", `HEAD:${spec}`])).pipe(
    Effect.flatMap(decodeJson),
    Effect.mapError((cause) => new OpenApiChangesetError({ reason: `could not read ${spec} at HEAD`, cause }))
  )
  const updated = yield* fs.readFileString(spec).pipe(
    Effect.flatMap(decodeJson),
    Effect.mapError((cause) => new OpenApiChangesetError({ reason: `could not read ${spec}`, cause }))
  )
  return classify(previous, updated)
})

/** One classification for several specs: the highest bump, changes located by spec file. */
const combine = (
  classified: ReadonlyArray<readonly [string, Classification]>,
  prefix: boolean
): Classification => {
  const changes = classified.flatMap(([file, { changes }]) =>
    changes.map((entry): Change => prefix ? { ...entry, at: `${file}${entry.at}` } : entry)
  )
  const bump = classified.reduce<Classification["bump"]>(
    (highest, [, { bump }]) => RANK[bump] > RANK[highest] ? bump : highest,
    "patch"
  )
  return { bump, changes }
}

const changeset = (
  client: string,
  bump: Classification["bump"],
  consumers: ReadonlyArray<string>,
  summary: string,
  notes: string
): string =>
  [
    "---",
    `${JSON.stringify(client)}: ${bump}`,
    ...consumers.map((consumer) => `${JSON.stringify(consumer)}: patch`),
    "---",
    "",
    summary,
    "",
    notes,
    ""
  ].join("\n")

/** GitHub's multi-line output syntax. Of n + 1 candidates at least one is not among the n note lines. */
const githubOutput = (bump: Classification["bump"], notes: string): string => {
  const lines = new Set(notes.split("\n"))
  const delimiter = ["RELEASE_NOTES_END", ...notes.split("\n").map((_, index) => `RELEASE_NOTES_END_${index}`)].find(
    (candidate) => !lines.has(candidate)
  ) ?? "RELEASE_NOTES_END"
  return `bump=${bump}\nrelease-notes<<${delimiter}\n${notes}\n${delimiter}\n`
}

const client = Flag.String("package").pipe(Flag.withDescription("The regenerated client package"))
const specs = Flag.String("spec").pipe(
  Flag.withDescription("A regenerated spec file, compared with its HEAD version"),
  Flag.atLeast(1)
)
const consumers = Flag.String("patch").pipe(
  Flag.withDescription("A consumer package released as a patch"),
  Flag.atLeast(0)
)
const summary = Flag.String("summary").pipe(Flag.withDescription("The changeset's first paragraph"))
const out = Flag.String("out").pipe(Flag.withDescription("The changeset file to write"))
const outputFile = Flag.String("github-output").pipe(
  Flag.withDescription("Append bump and release-notes outputs to this file"),
  Flag.optional
)

const command = Command.make("openapi-changeset", { client, specs, consumers, summary, out, outputFile }).pipe(
  Command.withHandler(
    Effect.fn("OpenApiChangeset.write")(function*({ client, consumers, out, outputFile, specs, summary }) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const classified = yield* Effect.forEach(
        specs,
        (spec) =>
          readSpecs(spec).pipe(Effect.map((result): readonly [string, Classification] => [path.basename(spec), result]))
      )
      const classification = combine(classified, specs.length > 1)
      const notes = releaseNotes(classification)
      yield* fs.makeDirectory(path.dirname(out), { recursive: true })
      yield* fs.writeFileString(out, changeset(client, classification.bump, consumers, summary, notes))
      if (Option.isSome(outputFile)) {
        yield* fs.writeFileString(outputFile.value, githubOutput(classification.bump, notes), { flag: "a" })
      }
      yield* Console.log(`${out}: ${client} ${classification.bump}\n${notes}`)
    })
  )
)

Command.run(command, { version: "1.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
