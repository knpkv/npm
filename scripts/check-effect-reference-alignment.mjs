import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"
import { URL } from "node:url"

import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const canonicalUpstreamUrl = "https://github.com/Effect-TS/effect.git"

const alignedPackages = new Set([
  "@effect/ai-openai-compat",
  "@effect/atom-react",
  "@effect/openapi-generator",
  "@effect/platform-browser",
  "@effect/platform-bun",
  "@effect/platform-node",
  "@effect/sql-libsql",
  "@effect/vitest",
  "effect"
])

const referenceManifests = [
  "repos/effect/packages/ai/openai-compat/package.json",
  "repos/effect/packages/atom/react/package.json",
  "repos/effect/packages/tools/openapi-generator/package.json",
  "repos/effect/packages/platform/browser/package.json",
  "repos/effect/packages/platform/bun/package.json",
  "repos/effect/packages/platform/node/package.json",
  "repos/effect/packages/sql/libsql/package.json",
  "repos/effect/packages/vitest/package.json",
  "repos/effect/packages/effect/package.json"
]

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]

const Metadata = Schema.fromJsonString(
  Schema.Struct({
    tag: Schema.String,
    upstreamCommit: Schema.String,
    tree: Schema.String,
    version: Schema.String
  })
)

const ReferenceManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    version: Schema.String
  })
)

const WorkspaceManifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
  })
)

class EffectReferenceAlignmentError extends Data.TaggedError("EffectReferenceAlignmentError") {
  get message() {
    return this.reason
  }
}

const fail = (reason, cause) => Effect.fail(new EffectReferenceAlignmentError({ cause, reason }))

const validateUpstreamUrl = (url) =>
  url === canonicalUpstreamUrl
    ? []
    : [`effect-upstream resolves to ${url}; expected the canonical ${canonicalUpstreamUrl}`]

const parseRemoteTagCommit = (tag, output) => {
  const tagRef = `refs/tags/${tag}`
  const peeledRef = `${tagRef}^{}`
  const entries = output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter((entry) => entry.length === 2 && (entry[1] === tagRef || entry[1] === peeledRef))
  const base = entries.filter((entry) => entry[1] === tagRef)
  const peeled = entries.filter((entry) => entry[1] === peeledRef)
  const violations = []

  if (base.length !== 1 || peeled.length > 1) {
    violations.push(`Canonical Effect tag ${tag} did not resolve uniquely`)
  }
  const commit = peeled[0]?.[0] ?? base[0]?.[0]
  if (commit === undefined || !/^[0-9a-f]{40}$/u.test(commit)) {
    violations.push(`Canonical Effect tag ${tag} did not peel to a full commit ID`)
  }
  return { commit, violations }
}

const matchingSubtreeProvenance = (metadata, candidates) =>
  candidates.filter((candidate) => candidate.split === metadata.upstreamCommit && candidate.tree === metadata.tree)

const validateAlignment = ({ metadata, provenance, referenceVersions, tagCommit, tree, workspaceVersions }) => {
  const violations = []

  if (metadata.tag !== `effect@${metadata.version}`) {
    violations.push("Effect reference tag must match the pinned version")
  }
  if (metadata.upstreamCommit.length !== 40 || metadata.tree.length !== 40) {
    violations.push("Effect reference commit and tree must use full Git object IDs")
  }
  if (tagCommit !== metadata.upstreamCommit) {
    violations.push(
      `Canonical Effect tag ${metadata.tag} resolves to ${tagCommit ?? "no commit"} instead of ${metadata.upstreamCommit}`
    )
  }
  if (tree !== metadata.tree) {
    violations.push(`Effect reference tree ${tree} does not match pinned tree ${metadata.tree}`)
  }
  if (provenance.split !== metadata.upstreamCommit) {
    violations.push(`Effect subtree provenance resolves to ${provenance.split} instead of ${metadata.upstreamCommit}`)
  }
  if (provenance.tree !== metadata.tree || provenance.tree !== tree) {
    violations.push(
      `Effect subtree provenance tree ${provenance.tree} does not match the pinned and staged tree ${metadata.tree}`
    )
  }

  for (const [name, version] of referenceVersions) {
    if (version !== metadata.version) {
      violations.push(`${name} reference version ${version} does not match ${metadata.version}`)
    }
  }
  for (const [location, name, version] of workspaceVersions) {
    if (version !== metadata.version) {
      violations.push(`${location} pins ${name}@${version} instead of ${metadata.version}`)
    }
  }

  return violations
}

const runSelfTest = () => {
  const releaseCommit = "b5946ece2b33a4468ef927a39821d7c3db463af3"
  const releaseTree = "d0308e864242aab0c8b03a0e8811e99a3e7919b7"
  const metadata = {
    tag: "effect@4.0.0-rc.109",
    upstreamCommit: releaseCommit,
    tree: releaseTree,
    version: "4.0.0-rc.109"
  }
  const valid = {
    metadata,
    provenance: { split: releaseCommit, tree: releaseTree },
    referenceVersions: [["effect", "4.0.0-rc.109"]],
    tagCommit: releaseCommit,
    tree: releaseTree,
    workspaceVersions: [["package.json", "effect", "4.0.0-rc.109"]]
  }

  assert.deepEqual(validateAlignment(valid), [], "a shared RC export such as Effect.succeed must remain valid")
  assert.match(
    validateAlignment({
      ...valid,
      metadata: { ...metadata, tree: "c".repeat(40) },
      tree: "c".repeat(40)
    }).join("\n"),
    /provenance tree/u,
    "a post-release reference change such as restoring Effect.head must fail"
  )
  assert.match(
    validateAlignment({
      ...valid,
      metadata: { ...metadata, upstreamCommit: "d".repeat(40), tree: "c".repeat(40) },
      provenance: { split: "d".repeat(40), tree: "c".repeat(40) },
      tree: "c".repeat(40)
    }).join("\n"),
    /Canonical Effect tag/u,
    "a self-consistent post-release commit carrying the same version must fail"
  )
  assert.match(
    validateAlignment({
      ...valid,
      workspaceVersions: [["package.json", "effect", "4.0.0-rc.108"]]
    }).join("\n"),
    /instead of 4\.0\.0-rc\.109/u,
    "a nearby workspace release mismatch must fail"
  )
  assert.deepEqual(validateUpstreamUrl(canonicalUpstreamUrl), [], "the canonical Effect remote must pass")
  assert.match(
    validateUpstreamUrl("https://example.invalid/Effect-TS/effect.git").join("\n"),
    /expected the canonical/u,
    "a same-path remote on an untrusted host must fail"
  )

  const tagRef = `refs/tags/${metadata.tag}`
  assert.deepEqual(
    parseRemoteTagCommit(metadata.tag, `${releaseCommit}\t${tagRef}`),
    { commit: releaseCommit, violations: [] },
    "a lightweight release tag must resolve to its commit"
  )
  assert.deepEqual(
    parseRemoteTagCommit(metadata.tag, `${"a".repeat(40)}\t${tagRef}\n${releaseCommit}\t${tagRef}^{}`),
    { commit: releaseCommit, violations: [] },
    "an annotated release tag must resolve to its peeled commit"
  )
  assert.match(
    parseRemoteTagCommit(metadata.tag, "").violations.join("\n"),
    /did not resolve uniquely/u,
    "a missing release tag must fail closed"
  )

  const validProvenance = { commit: "1".repeat(40), split: releaseCommit, tree: releaseTree }
  const unrelatedNewerProvenance = {
    commit: "2".repeat(40),
    split: "d".repeat(40),
    tree: "c".repeat(40)
  }
  assert.deepEqual(
    matchingSubtreeProvenance(metadata, [unrelatedNewerProvenance, validProvenance]),
    [validProvenance],
    "a newer unrelated subtree import must not hide the current provenance"
  )
  assert.equal(
    matchingSubtreeProvenance(metadata, [validProvenance, { ...validProvenance, commit: "3".repeat(40) }]).length,
    2,
    "multiple matching imports must remain ambiguous"
  )
}

const makeGit = Effect.fn("EffectReferenceAlignment.makeGit")(function* (repositoryRoot) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  return Effect.fn("EffectReferenceAlignment.git")(function* (args) {
    const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: repositoryRoot }))
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.decodeText(handle.stdout).pipe(Stream.mkString),
        Stream.decodeText(handle.stderr).pipe(Stream.mkString),
        handle.exitCode
      ],
      { concurrency: "unbounded" }
    )
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* fail(
        `git ${args.join(" ")} failed with exit code ${exitCode}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`
      )
    }
    return stdout.trim()
  })
})

const resolveSubtreeProvenance = Effect.fn("EffectReferenceAlignment.resolveSubtreeProvenance")(
  function* (git, metadata) {
    const mergeParents = (yield* git(["log", "--merges", "--format=%P"])).split("\n").filter(Boolean)
    const candidates = []
    const inspected = new Set()

    for (const parents of mergeParents) {
      for (const candidate of parents.split(" ").slice(1)) {
        if (inspected.has(candidate)) continue
        inspected.add(candidate)
        const message = yield* git(["show", "-s", "--format=%B", candidate])
        const directories = [...message.matchAll(/^git-subtree-dir: (.+)$/gmu)].map((match) => match[1])
        if (!directories.includes("repos/effect")) continue

        const splits = [...message.matchAll(/^git-subtree-split: ([0-9a-f]{40})$/gmu)].map((match) => match[1])
        const tree = yield* git(["rev-parse", `${candidate}^{tree}`])
        if (directories.length !== 1 || splits.length !== 1) {
          if (tree === metadata.tree) {
            return yield* fail(`Effect subtree provenance commit ${candidate} has ambiguous trailers`)
          }
          continue
        }
        candidates.push({ commit: candidate, split: splits[0], tree })
      }
    }

    const matching = matchingSubtreeProvenance(metadata, candidates)
    if (matching.length === 1) return matching[0]
    if (matching.length > 1) {
      return yield* fail(
        `Effect subtree provenance is ambiguous across matching commits ${matching.map((candidate) => candidate.commit).join(", ")}`
      )
    }
    if (candidates.length > 0) {
      return yield* fail(
        `No Effect subtree provenance matches pinned commit ${metadata.upstreamCommit} and tree ${metadata.tree}`
      )
    }
    return yield* fail(
      "Effect subtree provenance is missing; retain the subtree merge parents and use a full-history checkout"
    )
  }
)

const readJson = Effect.fn("EffectReferenceAlignment.readJson")(function* (fileSystem, path, schema) {
  const source = yield* fileSystem
    .readFileString(path)
    .pipe(Effect.mapError((cause) => new EffectReferenceAlignmentError({ cause, reason: `Could not read ${path}` })))
  return yield* Schema.decodeUnknownEffect(schema)(source).pipe(
    Effect.mapError((cause) => new EffectReferenceAlignmentError({ cause, reason: `Invalid JSON in ${path}` }))
  )
})

const program = Effect.gen(function* () {
  yield* Effect.try({
    try: runSelfTest,
    catch: (cause) =>
      new EffectReferenceAlignmentError({ cause, reason: "Effect reference alignment self-test failed" })
  })

  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  if (args.includes("--self-test")) {
    yield* Console.log("Effect reference alignment fixtures passed")
    return
  }

  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  const repositoryRoot = path.dirname(path.dirname(scriptPath))
  const metadataPath = path.join(repositoryRoot, "scripts", "effect-reference.json")
  const git = yield* makeGit(repositoryRoot)
  const remoteUrl = yield* git(["remote", "get-url", "effect-upstream"])
  const remoteViolations = validateUpstreamUrl(remoteUrl)
  if (remoteViolations.length > 0) return yield* fail(remoteViolations.join("\n"))
  if (args.includes("--check-remote")) {
    yield* Console.log(`Effect upstream remote verified at ${canonicalUpstreamUrl}`)
    return
  }
  const metadata = yield* readJson(fileSystem, metadataPath, Metadata)
  const remoteTag = parseRemoteTagCommit(
    metadata.tag,
    yield* git([
      "ls-remote",
      "--exit-code",
      "effect-upstream",
      `refs/tags/${metadata.tag}`,
      `refs/tags/${metadata.tag}^{}`
    ])
  )
  if (remoteTag.violations.length > 0) return yield* fail(remoteTag.violations.join("\n"))
  const provenance = yield* resolveSubtreeProvenance(git, metadata)

  const worktreeStatus = yield* git(["status", "--porcelain=v1", "--untracked-files=all", "--", "repos/effect"])
  const unstagedReferenceChange = worktreeStatus
    .split("\n")
    .filter(Boolean)
    .some((line) => line.startsWith("??") || line[1] !== " ")
  if (unstagedReferenceChange) {
    return yield* fail("Effect reference alignment requires subtree changes to be staged")
  }

  const rootTree = yield* git(["write-tree"])
  const tree = yield* git(["rev-parse", `${rootTree}:repos/effect`])
  const referenceVersions = []
  for (const manifestPath of referenceManifests) {
    const manifest = yield* readJson(fileSystem, path.join(repositoryRoot, manifestPath), ReferenceManifest)
    referenceVersions.push([manifest.name, manifest.version])
  }

  const manifestPaths = (yield* git([
    "ls-files",
    "-z",
    "--",
    "package.json",
    "packages/*/package.json",
    "scripts/package.json"
  ]))
    .split("\0")
    .filter(Boolean)
  const workspaceVersions = []
  for (const manifestPath of manifestPaths) {
    const manifest = yield* readJson(fileSystem, path.join(repositoryRoot, manifestPath), WorkspaceManifest)
    for (const scope of dependencySections) {
      for (const [name, version] of Object.entries(manifest[scope] ?? {})) {
        if (alignedPackages.has(name)) workspaceVersions.push([`${manifestPath}#${scope}`, name, version])
      }
    }
  }

  const violations = validateAlignment({
    metadata,
    provenance,
    referenceVersions,
    tagCommit: remoteTag.commit,
    tree,
    workspaceVersions
  })
  if (violations.length > 0) {
    return yield* fail(violations.map((violation) => `- ${violation}`).join("\n"))
  }

  yield* Console.log(`Effect reference alignment checked ${alignedPackages.size} packages at ${metadata.tag}`)
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
