import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"

import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// Release publishes every public package whose version is not on npm yet, so only the Version Packages
// pull request may move an existing package's version. Two modes, both on a full-history checkout:
// - pull request (GITHUB_EVENT_NAME, GITHUB_BASE_REF, GITHUB_HEAD_REF, GITHUB_REPOSITORY, GITHUB_EVENT_PATH):
//   fails when a version moved outside the repository's own changeset-release/main branch;
// - `--released-since <rev>` (Release workflow): writes `moved=true|false` to GITHUB_OUTPUT, saying whether
//   the push moved an existing package's version, which after the pull-request check means a Version
//   Packages merge.

class VersionBumpError extends Data.TaggedError("VersionBumpError") {
  get message() {
    return this.reason
  }
}

const fail = (reason) => new VersionBumpError({ reason })

export const releaseBranch = "changeset-release/main"

const PackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  private: Schema.optional(Schema.Boolean)
})

const PullRequestEvent = Schema.Struct({
  pull_request: Schema.Struct({ head: Schema.Struct({ repo: Schema.Struct({ full_name: Schema.String }) }) })
})

const decodeManifest = (file, text) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(text).pipe(
    Effect.mapError((cause) => fail(`${file} is not a readable package manifest: ${cause.message}`))
  )

const publishable = (manifest) => manifest.private !== true

/**
 * Compares workspace manifests by package name, since npm identity is the name and a package may move
 * directories. `changes` lists packages the base already had whose version moved while either side is
 * publishable (so going private in the same change hides nothing). `added` lists publishable packages
 * the base did not have: a first publish, allowed and reported.
 */
export const compareVersions = (base, head) => {
  const before = new Map(base.map((entry) => [entry.manifest.name, entry.manifest]))
  const changes = []
  const added = []
  for (const { file, manifest } of head) {
    const previous = before.get(manifest.name)
    if (previous === undefined) {
      if (publishable(manifest)) added.push({ file, name: manifest.name, version: manifest.version })
    } else if ((publishable(previous) || publishable(manifest)) && previous.version !== manifest.version) {
      changes.push({ file, name: manifest.name, from: previous.version, to: manifest.version })
    }
  }
  return { added, changes }
}

/** Only the Version Packages branch pushed to this repository itself is exempt; a fork can name any branch. */
export const isReleasePullRequest = ({ headRef, headRepository, repository }) =>
  headRef === releaseBranch && headRepository === repository

const git = Effect.fn("VersionBumps.git")(function* (args) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make("git", args, { extendEnv: true }))
  const [stdout, exitCode] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
    concurrency: 2
  })
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* fail(`git ${args.join(" ")} exited with ${exitCode}`)
  }
  return stdout
}, Effect.scoped)

const workspaceManifest = /^packages\/[^/]+\/package\.json$/u

// Every workspace package manifest at a revision.
const manifestsAt = Effect.fn("VersionBumps.manifestsAt")(function* (revision) {
  const files = (yield* git(["ls-tree", "-r", "--name-only", revision, "--", "packages"]))
    .split("\n")
    .filter((file) => workspaceManifest.test(file))
  return yield* Effect.forEach(files, (file) =>
    git(["show", `${revision}:${file}`]).pipe(
      Effect.flatMap((text) => decodeManifest(`${revision}:${file}`, text)),
      Effect.map((manifest) => ({ file, manifest }))
    )
  )
})

const describe = ({ file, name, from, to }) => `- ${name} (${file}): ${from ?? "(none)"} -> ${to ?? "(none)"}`

const checkPullRequest = Effect.gen(function* () {
  const baseRef = yield* Config.String("GITHUB_BASE_REF")
  const fileSystem = yield* FileSystem.FileSystem
  const pullRequest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequestEvent))(
    yield* fileSystem.readFileString(yield* Config.String("GITHUB_EVENT_PATH"))
  ).pipe(Effect.mapError((cause) => fail(`GITHUB_EVENT_PATH is not a pull request event: ${cause.message}`)))
  const exempt = isReleasePullRequest({
    headRef: yield* Config.String("GITHUB_HEAD_REF"),
    headRepository: pullRequest.pull_request.head.repo.full_name,
    repository: yield* Config.String("GITHUB_REPOSITORY")
  })
  const base = (yield* git(["merge-base", "HEAD", `origin/${baseRef}`])).trim()
  const head = yield* manifestsAt("HEAD")
  const { added, changes } = compareVersions(yield* manifestsAt(base), head)
  for (const { name, version } of added) {
    yield* Console.log(`New publishable package: ${name}@${version ?? "(no version)"}; Release publishes it on merge.`)
  }
  if (changes.length > 0 && !exempt) {
    return yield* fail(
      [
        `Only this repository's ${releaseBranch} (the Version Packages pull request) may change a package's version:`,
        ...changes.map(describe),
        "Fix: revert the version field and add a changeset (`pnpm changeset`) instead."
      ].join("\n")
    )
  }
  yield* Console.log(
    exempt
      ? `Version bumps: ${changes.length} version changes on the Version Packages branch`
      : `Version bumps: ${head.length} manifests checked, none changed outside ${releaseBranch}`
  )
})

const reportRelease = Effect.fn("VersionBumps.reportRelease")(function* (since) {
  // The range must be history main actually has; anything else fails rather than guessing.
  yield* git(["merge-base", "--is-ancestor", since, "HEAD"]).pipe(
    Effect.mapError(() => fail(`${since} is not an ancestor of HEAD; cannot tell what this push released`))
  )
  const { changes } = compareVersions(yield* manifestsAt(since), yield* manifestsAt("HEAD"))
  for (const change of changes) yield* Console.log(`Released by this push: ${describe(change).slice(2)}`)
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.writeFileString(yield* Config.String("GITHUB_OUTPUT"), `moved=${changes.length > 0}\n`, {
    flag: "a"
  })
})

const program = Effect.gen(function* () {
  const args = yield* (yield* Stdio.Stdio).args
  const sinceIndex = args.indexOf("--released-since")
  if (sinceIndex >= 0) {
    const since = args[sinceIndex + 1]
    if (since === undefined || since === "") return yield* fail("--released-since needs a revision")
    return yield* reportRelease(since)
  }
  const event = yield* Config.String("GITHUB_EVENT_NAME")
  if (event !== "pull_request") {
    // Pushes to main include Version Packages merges, which are the one place versions move.
    yield* Console.log(`Version bumps: not checked on a ${event} event; pull requests are checked`)
    return
  }
  yield* checkPullRequest
})

// A version-bump failure prints its reason alone; anything else (a git or config failure, a defect) prints its full cause.
const main = program.pipe(
  Effect.tapCause((cause) => {
    const failure = Cause.squash(cause)
    return Console.error(Predicate.isTagged(failure, "VersionBumpError") ? failure.reason : Cause.pretty(cause))
  }),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
