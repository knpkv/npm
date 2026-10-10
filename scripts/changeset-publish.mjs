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
// again, and npm answers E409 "Cannot publish over previously staged version". That run is only a retry of
// a release that already happened, so it exits 0 and logs each version as staged, not yet visible, when all
// of these hold:
// - every failure is that conflict for the exact package and version being released;
// - changesets listed what it planned, and every planned release either published or was staged (it stops
//   after a failing batch, so a later batch may never have been attempted);
// - nothing follows the failure block but tag results and changesets' exit line, so a failed tag step fails;
// - each staged version's git tag is on origin. The run that staged it reported success and tagged it; when
//   that tag is missing, this fails and names the tag and GitHub release to create by hand.
// Anything else keeps the failure.
//
// Publishing runs no lifecycle scripts. `changeset:publish` builds the whole workspace first, then changesets
// publishes up to ten packages at once, ordering them only by runtime dependencies. A `prepack` that rebuilds
// (`pnpm build` starts with `rimraf dist`) can then delete a dist that another package's concurrent prepack is
// reading through a devDependency: codecommit-web's `tsc -b && vite build` read rly's and relay-product's while
// they were rebuilt, and failed with exit 2 and no output. The packages ship what the build just made.

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

/**
 * The "Some packages failed to publish" block: each failed release with npm's code and message when given,
 * and the lines that follow the block.
 */
const failuresIn = (lines) => {
  const start = lines.findIndex((line) => line.includes("Some packages failed to publish:"))
  if (start < 0) return { failures: [], after: [] }
  const failures = []
  let end = start + 1
  for (; end < lines.length; end += 1) {
    const release = releaseLine.exec(lines[end])
    const error = errorLine.exec(lines[end])
    if (release !== null) failures.push({ name: release[1], version: release[2], code: null, message: null })
    else if (error !== null && failures.length > 0) {
      failures[failures.length - 1] = { ...failures[failures.length - 1], code: error[1], message: error[2] }
    } else break
  }
  return { failures, after: lines.slice(end) }
}

// After the failure block changesets prints only its tag results (successes are tagged) and then exits through
// ExitError. A tag step that throws prints its stack there instead, before the same exit line.
const tagResultLine =
  /^(?:[◒◐◓◑◇]\s*)?(?:Creating git tags\.\.\.|Created git tags[.:]|Skipped tags \(already exist\):|- \S+@\S+)$/
const exitLine = /^🦋 Exited with code \d+$/
const endsCleanly = (after) => {
  const remaining = after.filter((line) => line.length > 0)
  return (
    remaining.length > 0 &&
    exitLine.test(remaining[remaining.length - 1]) &&
    remaining.slice(0, -1).every((line) => tagResultLine.test(line))
  )
}

/** npm's answer to publishing a version it already holds in staging, for exactly this package and version. */
export const isStagedConflict = ({ code, message, name, version }) =>
  code === "E409" &&
  message !== null &&
  message.startsWith("409 Conflict - PUT ") &&
  message.endsWith(`/${name.replace("/", "%2f")} - Cannot publish over previously staged version "${version}".`)

/**
 * Reads `changeset publish` output. `staged` lists the releases npm holds in staging; it is null when the run
 * failed for any other reason (see the conditions above), or when the output is not the shape this expects.
 */
export const readPublishOutput = (output) => {
  const lines = output
    .replace(ansi, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
  const planned = releasesAfter(lines, "These packages will be published")
  const published = releasesAfter(lines, "Successfully published:")
  const { after, failures } = failuresIn(lines)
  const key = ({ name, version }) => `${name}@${version}`
  const plannedKeys = new Set(planned.map(key))
  const settled = new Set([...published, ...failures.filter(isStagedConflict)].map(key))
  return planned.length > 0 &&
    failures.length > 0 &&
    failures.every((failure) => isStagedConflict(failure) && plannedKeys.has(key(failure))) &&
    planned.every((release) => settled.has(key(release))) &&
    endsCleanly(after)
    ? { staged: failures.map(({ name, version }) => ({ name, version })) }
    : { staged: null }
}

/** Whether origin has the release tag `name@version`: `git ls-remote --exit-code` exits 2 when it does not. */
const tagOnOrigin = Effect.fn("tagOnOrigin")(function* (tag) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], {
      extendEnv: true,
      stdout: "ignore"
    })
  )
  if (exitCode === ChildProcessSpawner.ExitCode(0)) return true
  if (exitCode === ChildProcessSpawner.ExitCode(2)) return false
  return yield* new PublishFailed({ reason: `git ls-remote could not check ${tag} (exit code ${exitCode})` })
})

/**
 * Skips every lifecycle script of the `pnpm publish` changesets runs per package: pnpm 11 reads
 * `pnpm_config_*`, earlier pnpm and npm read `npm_config_*`.
 */
export const publishEnv = { npm_config_ignore_scripts: "true", pnpm_config_ignore_scripts: "true" }

const publishLifecycle = ["prepare", "prepack", "postpack", "prepublish", "prepublishOnly", "publish", "postpublish"]
const buildOfWorkspacePackage = /^pnpm --filter @knpkv\/[a-z0-9-]+ build && (.+)$/

/**
 * Why a published package's lifecycle script would be lost by publishing with scripts off, or null. A
 * script may only repeat what `changeset:publish`'s workspace build already did: the package's own
 * `build`, `pnpm build`, or another workspace package's build followed by its own.
 */
export const publishLifecycleViolation = (name, scripts) => {
  for (const hook of publishLifecycle) {
    const script = scripts[hook]
    if (script === undefined) continue
    const ownBuild = scripts.build
    const repeatsBuild =
      script === "pnpm build" ||
      (ownBuild !== undefined && script === ownBuild) ||
      (ownBuild !== undefined && buildOfWorkspacePackage.exec(script)?.[1] === ownBuild)
    if (hook === "prepare" || !repeatsBuild) {
      return `${name}: "${hook}": "${script}" does more than build, and publish runs with ignore-scripts; move this work into build`
    }
  }
  return null
}

const main = Effect.gen(function* () {
  const stdout = (yield* Stdio.Stdio).stdout({ endOnDone: false })
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make("changeset", ["publish"], { env: publishEnv, extendEnv: true, stderr: "inherit" })
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
  const untagged = []
  for (const release of staged) {
    if (!(yield* tagOnOrigin(`${release.name}@${release.version}`))) untagged.push(release)
  }
  if (untagged.length > 0) {
    const tags = untagged.map(({ name, version }) => `${name}@${version}`).join(", ")
    return yield* new PublishFailed({
      reason: `${tags} staged on npm but never tagged: create each git tag and its GitHub release by hand`
    })
  }
  for (const { name, version } of staged) {
    yield* Console.log(
      `::notice title=Staged, not yet visible::${name}@${version} staged, not yet visible: ` +
        "npm already accepted this version and it is tagged; npm has not listed it yet."
    )
  }
}).pipe(
  Effect.scoped,
  Effect.tapError((error) => Console.error(error.message)),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
