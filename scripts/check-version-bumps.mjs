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
//   changeset-release/main branch, or when a CHANGELOG.md gains a heading for its package's current version (that
//   heading is Release's proof that Version Packages produced a version);
// - `--prepare-release` (Release workflow): finds the publishable versions on main that npm lacks. One is
//   ready when its package's CHANGELOG.md has its `## <version>` heading: only `changeset version` writes
//   that, so Version Packages produced it. One without the heading is unversioned (a new package whose
//   changeset is still pending): publishing now would release a placeholder. When every version npm lacks
//   is ready, it sets the pending changesets aside so the publish pass releases them; when any is
//   unversioned it touches nothing and warns, leaving the release to the action's usual choice, because
//   `changeset publish` cannot release only part of the workspace safely. An unversioned package no pending
//   changeset names fails the step, since the usual publish would release it. A version npm's metadata
//   lacks but whose tarball npm already serves is still propagating, and the run publishes nothing.
//   Writes `outstanding`, `pending` and `propagating` (true|false) to GITHUB_OUTPUT. Asking npm, not a
//   push's diff, keeps a release ready through skipped or failed runs.

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

// A package's CHANGELOG.md at a revision, or "" when it has none.
const changelogAt = Effect.fn("VersionBumps.changelogAt")(function* (revision, manifestFile) {
  const file = manifestFile.replace(/package\.json$/u, "CHANGELOG.md")
  const listed = (yield* git(["ls-tree", "--name-only", revision, "--", file])).trim()
  return listed === "" ? "" : yield* git(["show", `${revision}:${file}`])
})

/**
 * Packages whose changelog gains a heading for their current version. Only `changeset version` may write
 * that heading, since Release treats it as proof that Version Packages produced the version; this catches a
 * new package with a copied changelog, a heading added later, and a private package going public with one.
 */
export const introducedHeadings = (entries) =>
  entries.filter(
    ({ base, head, version }) =>
      version !== undefined && changelogHasVersion(head, version) && !changelogHasVersion(base, version)
  )

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
  const baseManifests = yield* manifestsAt(base)
  const { added, changes } = compareVersions(baseManifests, head)
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
  // A private package's changelog is not release history: it proves nothing once the package goes public.
  const baseFiles = new Map(
    baseManifests.filter(({ manifest }) => publishable(manifest)).map(({ file, manifest }) => [manifest.name, file])
  )
  const headings = yield* Effect.forEach(
    head.filter(({ manifest }) => publishable(manifest)),
    ({ file, manifest }) =>
      Effect.gen(function* () {
        const baseFile = baseFiles.get(manifest.name)
        return {
          base: baseFile === undefined ? "" : yield* changelogAt(base, baseFile),
          file,
          head: yield* changelogAt("HEAD", file),
          name: manifest.name,
          version: manifest.version
        }
      })
  )
  const introduced = introducedHeadings(headings)
  if (introduced.length > 0 && !exempt) {
    return yield* fail(
      [
        "Only Version Packages may add a CHANGELOG.md heading for a package's current version:",
        ...introduced.map(({ file, name, version }) => `- ${name} (${file}): ## ${version}`),
        "Fix: remove the heading (or the copied changelog) and add a changeset (`pnpm changeset`)."
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
 * Splits the publishable versions npm lacks into `ready` (Version Packages produced them) and `unversioned`.
 * `published` maps a package name to the versions npm has, or to undefined when npm has no such package;
 * `versioned(entry)` says whether that package's changelog has a heading for its version.
 */
export const planRelease = (manifests, published, versioned) => {
  const ready = []
  const unversioned = []
  for (const entry of manifests) {
    const { manifest } = entry
    if (!publishable(manifest) || manifest.version === undefined) continue
    if (published.get(manifest.name)?.has(manifest.version) === true) continue
    const release = { file: entry.file, name: manifest.name, version: manifest.version }
    ;(versioned(entry) ? ready : unversioned).push(release)
  }
  return { ready, unversioned }
}

// Whether a changelog records a release of `version`, as `changeset version` writes it.
export const changelogHasVersion = (changelog, version) =>
  changelog.split("\n").some((line) => line.trim() === `## ${version}`)

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

// Whether npm serves a version's tarball. npm's metadata can lag a publish by many minutes while the
// tarball is already there, so a version missing from the metadata is checked here before it counts as
// unpublished: publishing it again would fail with "cannot publish over the previously published version".
const tarballPublished = Effect.fn("VersionBumps.tarballPublished")(function* (registry, name, version) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.execute(
    HttpClientRequest.head(`${registry}/${name}/-/${name.split("/").at(-1)}-${version}.tgz`)
  )
  if (response.status === 200) return true
  if (response.status === 404) return false
  return yield* fail(`npm answered ${response.status} for the ${name}@${version} tarball`)
})

// The files Changesets reads as changesets, mirroring @changesets/read 1.0.1: top-level `.md` files that
// are not dotfiles, any-case README.md, AGENTS.md, CLAUDE.md or GEMINI.md.
const ignoredChangesetFiles = [/^README\.md$/iu, /^AGENTS\.md$/u, /^CLAUDE\.md$/u, /^GEMINI\.md$/u]
export const isChangesetFile = (name) =>
  !name.startsWith(".") && name.endsWith(".md") && !ignoredChangesetFiles.some((pattern) => pattern.test(name))

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
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ChangesetReleases)(value ?? {}).pipe(
        Effect.mapError((cause) => fail(`${file}: ${cause.message}`))
      )
    ),
    Effect.map((releases) => Object.keys(releases))
  )
}

const prepareRelease = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const registry = yield* Config.String("NPM_REGISTRY_URL").pipe(Config.withDefault("https://registry.npmjs.org"))
  const pendingFiles = (yield* fileSystem.readDirectory(".changeset"))
    .filter(isChangesetFile)
    .map((name) => `.changeset/${name}`)
  const manifests = (yield* manifestsAt("HEAD")).filter((entry) => publishable(entry.manifest))
  const published = new Map(
    yield* Effect.forEach(
      manifests,
      ({ manifest }) =>
        publishedVersions(registry, manifest.name).pipe(Effect.map((versions) => [manifest.name, versions])),
      { concurrency: 4 }
    )
  )
  const changelogs = new Map(
    yield* Effect.forEach(manifests, ({ file }) => {
      const changelog = file.replace(/package\.json$/u, "CHANGELOG.md")
      // No changelog means changesets never versioned the package.
      return fileSystem.exists(changelog).pipe(
        Effect.flatMap((exists) => (exists ? fileSystem.readFileString(changelog) : Effect.succeed(""))),
        Effect.map((text) => [file, text])
      )
    })
  )
  const plan = planRelease(manifests, published, ({ file, manifest }) =>
    changelogHasVersion(changelogs.get(file) ?? "", manifest.version)
  )
  const served = new Set(
    (yield* Effect.forEach(
      [...plan.ready, ...plan.unversioned],
      ({ name, version }) =>
        tarballPublished(registry, name, version).pipe(Effect.map((exists) => (exists ? `${name}@${version}` : ""))),
      { concurrency: 4 }
    )).filter((key) => key !== "")
  )
  const unpublished = ({ name, version }) => !served.has(`${name}@${version}`)
  const ready = plan.ready.filter(unpublished)
  const unversioned = plan.unversioned.filter(unpublished)
  for (const key of served) yield* Console.log(`Published, npm metadata still catching up: ${key}`)
  for (const { name, version } of ready) yield* Console.log(`Ready to publish: ${name}@${version}`)
  for (const { name, version } of unversioned) yield* Console.log(`Not versioned yet: ${name}@${version}`)
  // An unversioned version no pending changeset names would be published by the action's usual publish.
  const pendingNames = new Set(
    (yield* Effect.forEach(pendingFiles, (file) =>
      fileSystem.readFileString(file).pipe(Effect.flatMap((text) => changesetPackages(file, text)))
    )).flat()
  )
  const orphaned = unversioned.filter(({ name }) => !pendingNames.has(name))
  if (orphaned.length > 0) {
    return yield* fail(
      [
        "Not versioned by Version Packages, and no pending changeset will version it:",
        ...orphaned.map(({ file, name, version }) => `- ${name}@${version} (${file})`),
        "Release stops rather than publish an unversioned package. Fix: add a changeset for it."
      ].join("\n")
    )
  }
  // While npm's metadata lags, `changeset publish` would also see those versions as missing and fail on
  // republishing them, so this run publishes nothing; the next run after the metadata catches up does.
  const propagating = served.size > 0
  const outstanding = ready.length > 0 && unversioned.length === 0 && !propagating
  if (propagating) {
    yield* Console.log(
      `::warning title=Release waits::npm's metadata does not list ${[...served].join(", ")} yet; ` +
        "this run publishes nothing, so the next run does not try to republish them."
    )
  } else if (ready.length > 0 && unversioned.length > 0) {
    yield* Console.log(
      `::warning title=Release waits::${ready.map(({ name, version }) => `${name}@${version}`).join(", ")} ` +
        `stay unpublished while ${unversioned.map(({ name }) => name).join(", ")} awaits its changeset; ` +
        "they publish with the next release once every unpublished version is versioned."
    )
  }
  if (outstanding) for (const file of pendingFiles) yield* fileSystem.remove(file)
  yield* fileSystem.writeFileString(
    yield* Config.String("GITHUB_OUTPUT"),
    `outstanding=${outstanding}\npending=${pendingFiles.length > 0}\npropagating=${propagating}\n`,
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
