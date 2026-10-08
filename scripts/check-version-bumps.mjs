import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"

import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// Release publishes every public package whose version is not on npm yet, so a pull request may change
// an existing publishable package's version only as the Version Packages pull request. Runs in CI on
// pull requests (GITHUB_EVENT_NAME, GITHUB_BASE_REF, GITHUB_HEAD_REF), against a full-history checkout.

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

const decodeManifest = (file, text) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(text).pipe(
    Effect.mapError((cause) => fail(`${file} is not a readable package manifest: ${cause.message}`))
  )

const publishable = (manifest) => manifest.private !== true

/**
 * Compares each workspace manifest with its base. `changes` lists existing publishable packages whose
 * version moved; they are violations unless `branch` is the Version Packages branch. `added` lists
 * publishable packages the base did not have: allowed, and reported so a first publish is visible.
 */
export const compareVersions = (branch, manifests) => {
  const changes = manifests
    .filter(({ base, head }) => base !== undefined && publishable(head) && base.version !== head.version)
    .map(({ base, file, head }) => ({ file, name: head.name, from: base.version, to: head.version }))
  const added = manifests
    .filter(({ base, head }) => base === undefined && publishable(head))
    .map(({ file, head }) => ({ file, name: head.name, version: head.version }))
  return { added, violations: branch === releaseBranch ? [] : changes }
}

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

// The base side of a file, or none when the base commit does not have it. Any git failure fails the check.
const baseText = Effect.fn("VersionBumps.baseText")(function* (base, file) {
  const listed = (yield* git(["ls-tree", "--name-only", base, "--", file])).trim()
  return listed === "" ? Option.none() : Option.some(yield* git(["show", `${base}:${file}`]))
})

const program = Effect.gen(function* () {
  const event = yield* Config.String("GITHUB_EVENT_NAME")
  if (event !== "pull_request") {
    // Pushes to main include Version Packages merges, which are the one place versions move.
    yield* Console.log(`Version bumps: not checked on a ${event} event; pull requests are checked`)
    return
  }
  const baseRef = yield* Config.String("GITHUB_BASE_REF")
  const branch = yield* Config.String("GITHUB_HEAD_REF")
  const base = (yield* git(["merge-base", "HEAD", `origin/${baseRef}`])).trim()
  const files = (yield* git(["ls-files", "--", "packages/*/package.json"])).split("\n").filter((file) => file !== "")
  const manifests = yield* Effect.forEach(files, (file) =>
    Effect.gen(function* () {
      const head = yield* decodeManifest(file, yield* git(["show", `HEAD:${file}`]))
      const baseManifest = yield* baseText(base, file)
      return {
        file,
        head,
        base: Option.isSome(baseManifest) ? yield* decodeManifest(file, baseManifest.value) : undefined
      }
    })
  )
  const { added, violations } = compareVersions(branch, manifests)
  for (const { name, version } of added) {
    yield* Console.log(`New publishable package: ${name}@${version ?? "(no version)"}; Release publishes it on merge.`)
  }
  if (violations.length > 0) {
    return yield* fail(
      [
        `Only ${releaseBranch} (the Version Packages pull request) may change a published package's version:`,
        ...violations.map(({ file, from, to }) => `- ${file}: ${from ?? "(none)"} -> ${to ?? "(none)"}`),
        "Fix: revert the version field and add a changeset (`pnpm changeset`) instead."
      ].join("\n")
    )
  }
  yield* Console.log(`Version bumps: ${files.length} manifests checked, none changed outside ${releaseBranch}`)
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
