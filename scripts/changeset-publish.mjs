import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"

import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"

// Release's publish step: runs `changeset publish`, passing its output through unchanged (changesets/action
// reads its `New tag:` lines). npm can accept a publish into staging and keep the version out of its
// metadata for an hour (npm/cli#9889). The next Release run then finds that version missing, publishes it
// again, and npm answers E409 "Cannot publish over previously staged version". When every failure is that
// conflict for the exact package and version being released, and every planned release either published or
// was staged, the release is complete: this logs each as staged, not yet visible, and exits 0. Any other
// failure, or a planned release that was never attempted (changesets stops after a failing batch), fails.

class PublishFailed extends Data.TaggedError("PublishFailed") {
  get message() {
    return this.reason
  }
}

const ansi = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, "g")
const releaseLine = /^(@?[^@\s]+)@(\S+)$/
const errorLine = /^└ (\S+): (.*)$/

/** The `name@version` lines after the first line containing `heading`, up to the first line that is not one. */
const releasesAfter = (lines, heading) => {
  const start = lines.findIndex((line) => line.includes(heading))
  if (start < 0) return []
  const releases = []
  for (const line of lines.slice(start + 1)) {
    const release = releaseLine.exec(line)
    if (release !== null) releases.push({ name: release[1], version: release[2] })
    else if (!errorLine.test(line) || releases.length === 0) break
  }
  return releases
}

/** Each failed release in the "Some packages failed to publish" block, with npm's code and message when given. */
const failuresIn = (lines) => {
  const start = lines.findIndex((line) => line.includes("Some packages failed to publish:"))
  if (start < 0) return []
  const failures = []
  for (const line of lines.slice(start + 1)) {
    const release = releaseLine.exec(line)
    const error = errorLine.exec(line)
    if (release !== null) failures.push({ name: release[1], version: release[2], code: null, message: null })
    else if (error !== null && failures.length > 0) {
      failures[failures.length - 1] = { ...failures[failures.length - 1], code: error[1], message: error[2] }
    } else break
  }
  return failures
}

/** npm's answer to publishing a version it already holds in staging, for exactly this package and version. */
export const isStagedConflict = ({ code, message, name, version }) =>
  code === "E409" &&
  message !== null &&
  message.startsWith("409 Conflict - PUT ") &&
  message.endsWith(`/${name.replace("/", "%2f")} - Cannot publish over previously staged version "${version}".`)

/**
 * Reads `changeset publish` output. `staged` lists the releases npm holds in staging; it is null when the run
 * failed for any other reason: another error, or a planned release that neither published nor was staged.
 */
export const readPublishOutput = (output) => {
  const lines = output
    .replace(ansi, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
  const planned = releasesAfter(lines, "These packages will be published")
  const published = releasesAfter(lines, "Successfully published:")
  const failures = failuresIn(lines)
  const key = ({ name, version }) => `${name}@${version}`
  const settled = new Set([...published, ...failures.filter(isStagedConflict)].map(key))
  return failures.length > 0 &&
    failures.every(isStagedConflict) &&
    planned.every((release) => settled.has(key(release)))
    ? { staged: failures.map(({ name, version }) => ({ name, version })) }
    : { staged: null }
}

const main = Effect.gen(function* () {
  const stdout = (yield* Stdio.Stdio).stdout({ endOnDone: false })
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make("changeset", ["publish"], { extendEnv: true, stderr: "inherit" })
  )
  const [output, exitCode] = yield* Effect.all(
    [
      handle.stdout.pipe(
        Stream.tap((chunk) => Stream.run(Stream.succeed(chunk), stdout)),
        Stream.decodeText(),
        Stream.mkString
      ),
      handle.exitCode
    ],
    { concurrency: "unbounded" }
  )
  if (exitCode === ChildProcessSpawner.ExitCode(0)) return
  const { staged } = readPublishOutput(output)
  if (staged === null) return yield* new PublishFailed({ reason: `changeset publish exited with code ${exitCode}` })
  for (const { name, version } of staged) {
    yield* Console.log(
      `::notice title=Staged, not yet visible::${name}@${version} staged, not yet visible: ` +
        "npm already accepted this version and has not listed it yet."
    )
  }
}).pipe(
  Effect.scoped,
  Effect.tapError((error) => Console.error(error.message)),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
