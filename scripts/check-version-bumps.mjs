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
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parse as parseYaml } from "yaml"

// Release publishes every public package whose version is not on npm yet, so only the Version Packages
// pull request may move an existing package's version. Two modes:
// - pull request (GITHUB_EVENT_NAME, GITHUB_BASE_REF, GITHUB_HEAD_REF, GITHUB_REPOSITORY, GITHUB_EVENT_PATH),
//   on a full-history checkout: fails when a version moved outside the repository's own
//   changeset-release/main branch;
// - `--prepare-release` (Release workflow): asks npm which publishable versions on main it lacks. A version is
//   ready when npm already has the package (only Version Packages moves a version), or when npm has never
//   seen the package and no pending changeset names it (Version Packages already consumed its changeset).
//   A new package a pending changeset still names is held: its version is a placeholder. When something
//   is ready it sets the pending changesets aside and marks held packages private in this checkout, so the
//   publish pass releases exactly the ready versions; the workflow restores both from git afterwards.
//   Writes `outstanding=true|false` and `pending=true|false` to GITHUB_OUTPUT. Asking npm, not a push's
//   diff, keeps a release ready through skipped or failed runs.

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

const Packument = Schema.Struct({ versions: Schema.Record(Schema.String, Schema.Unknown) })

/**
 * Splits the publishable versions npm lacks into `ready` and `held`. `published` maps a package name to the
 * versions npm has, or to undefined when npm has no such package; `pendingNames` are the packages pending
 * changesets name. Packages whose version npm already has are in neither list.
 */
export const planRelease = (manifests, published, pendingNames) => {
  const ready = []
  const held = []
  for (const { file, manifest } of manifests) {
    if (!publishable(manifest) || manifest.version === undefined) continue
    const versions = published.get(manifest.name)
    const entry = { file, name: manifest.name, version: manifest.version }
    if (versions === undefined) (pendingNames.has(manifest.name) ? held : ready).push(entry)
    else if (!versions.has(manifest.version)) ready.push(entry)
  }
  return { held, ready }
}

const ChangesetReleases = Schema.Record(Schema.String, Schema.String)
const frontmatter = /^---\r?\n((?:[\s\S]*?\r?\n)?)---(?:\r?\n|$)/u

// The package names a pending changeset releases, read from its front matter.
export const changesetPackages = (file, text) => {
  const match = frontmatter.exec(text)
  if (match === null) return Effect.fail(fail(`${file} has no changeset front matter`))
  return Effect.try({
    try: () => parseYaml(match[1] ?? ""),
    catch: (cause) => fail(`${file} front matter is not YAML: ${String(cause)}`)
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(ChangesetReleases)(value ?? {})),
    Effect.mapError((cause) =>
      Predicate.isTagged(cause, "VersionBumpError") ? cause : fail(`${file}: ${cause.message}`)
    ),
    Effect.map((releases) => Object.keys(releases))
  )
}

// The versions npm has for a package, or undefined when npm has no such package. Any other answer fails.
const publishedVersions = Effect.fn("VersionBumps.publishedVersions")(function* (registry, name) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(
    HttpClientRequest.get(`${registry}/${name.replace("/", "%2F")}`).pipe(
      HttpClientRequest.setHeaders({ accept: "application/vnd.npm.install-v1+json" })
    )
  )
  if (response.status === 404) return undefined
  if (response.status !== 200) return yield* fail(`npm answered ${response.status} for ${name}`)
  const packument = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Packument))(yield* response.text).pipe(
    Effect.mapError((cause) => fail(`npm's metadata for ${name} is unreadable: ${cause.message}`))
  )
  return new Set(Object.keys(packument.versions))
})

const prepareRelease = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const registry = yield* Config.String("NPM_REGISTRY_URL").pipe(Config.withDefault("https://registry.npmjs.org"))
  const pendingFiles = (yield* fileSystem.readDirectory(".changeset"))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => `.changeset/${name}`)
  const pendingNames = new Set(
    (yield* Effect.forEach(pendingFiles, (file) =>
      fileSystem.readFileString(file).pipe(Effect.flatMap((text) => changesetPackages(file, text)))
    )).flat()
  )
  const manifests = (yield* manifestsAt("HEAD")).filter((entry) => publishable(entry.manifest))
  const published = new Map(
    yield* Effect.forEach(
      manifests,
      ({ manifest }) =>
        publishedVersions(registry, manifest.name).pipe(Effect.map((versions) => [manifest.name, versions])),
      { concurrency: 4 }
    )
  )
  const { held, ready } = planRelease(manifests, published, pendingNames)
  for (const { name, version } of ready) yield* Console.log(`Ready to publish: ${name}@${version}`)
  for (const { name, version } of held) yield* Console.log(`Held until its changeset is versioned: ${name}@${version}`)
  if (ready.length > 0) {
    for (const file of pendingFiles) yield* fileSystem.remove(file)
    for (const { file } of held) {
      const text = yield* fileSystem.readFileString(file)
      const manifest = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
      )(text).pipe(Effect.mapError((cause) => fail(`${file} is not a JSON object: ${cause.message}`)))
      yield* fileSystem.writeFileString(file, `${JSON.stringify({ ...manifest, private: true }, null, 2)}\n`)
    }
  }
  yield* fileSystem.writeFileString(
    yield* Config.String("GITHUB_OUTPUT"),
    `outstanding=${ready.length > 0}\npending=${pendingFiles.length > 0}\n`,
    { flag: "a" }
  )
}).pipe(Effect.provide(FetchHttpClient.layer))

const program = Effect.gen(function* () {
  const args = yield* (yield* Stdio.Stdio).args
  if (args.includes("--prepare-release")) return yield* prepareRelease
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
