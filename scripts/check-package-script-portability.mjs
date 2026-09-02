import assert from "node:assert/strict"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { parse } from "yaml"

const environmentAssignment = /^\s*[A-Za-z_][A-Za-z0-9_]*=/u
const buildLifecycleNames = new Set(["build", "prebuild", "postbuild"])
const ignoredWorkspaceSegments = new Set(["generated", "node_modules", "vendor"])
const safeWorkspaceSegment = /^[A-Za-z0-9._-]+$/u
const isBuildScript = (name) => name.split(":").some((segment) => buildLifecycleNames.has(segment))
const browserPairingBuild = /^pnpm\s+--filter\s+"?@knpkv\/browser-pairing"?\s+build(?=\s|$)/u
const codeCommitWebRoleCheck = /^tsc\s+-p\s+tsconfig\.roles\.json\s+--noEmit(?=\s|$)/u
const codeCommitWebLifecycleRequirements = [
  {
    script: "predev",
    description: "a browser-pairing build",
    matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
  },
  {
    script: "prestart",
    description: "a browser-pairing build",
    matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
  },
  {
    script: "pretest",
    description: "a browser-pairing build",
    matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
  },
  {
    script: "test:browser",
    description: "a browser-pairing build",
    matches: (command) => hasExecutableLifecycleCommand(command, browserPairingBuild)
  },
  {
    script: "check",
    description: "the role-aware tsc check",
    matches: (command) => hasExecutableLifecycleCommand(command, codeCommitWebRoleCheck)
  }
]

const hasDirectEnvironmentAssignment = (command) => {
  let quote
  let escaped = false
  const boundaries = [0]
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === ";" || character === "\n" || character === "|" || character === "(") {
      boundaries.push(index + 1)
    }
    if (
      character === "{" &&
      /\s/u.test(command[index + 1] ?? "") &&
      boundaries.some((boundary) => command.slice(boundary, index).trim() === "")
    ) {
      boundaries.push(index + 1)
    }
    if (character === "&") boundaries.push(index + (command[index + 1] === "&" ? 2 : 1))
  }
  return boundaries.some((index) => environmentAssignment.test(command.slice(index)))
}

const shellCommandSegments = (command) => {
  const segments = []
  let segmentStart = 0
  let quote
  let escaped = false
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === ";" || character === "\n" || character === "|" || character === "&" || character === "(") {
      segments.push(command.slice(segmentStart, index))
      if ((character === "|" || character === "&") && command[index + 1] === character) index++
      segmentStart = index + 1
    }
  }
  segments.push(command.slice(segmentStart))
  return segments
}

const hasExecutableLifecycleCommand = (command, matcher) =>
  shellCommandSegments(command).some((segment) => matcher.test(segment.trim()))

class PackageScriptPortabilityError extends Data.TaggedError("PackageScriptPortabilityError") {
  get message() {
    return this.reason
  }
}

const PackageManifest = Schema.fromJsonString(
  Schema.Struct({
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
  })
)
const WorkspaceConfig = Schema.Struct({ packages: Schema.Array(Schema.String) })

const classifyWorkspacePattern = (pattern) => {
  const segments = pattern.split("/")
  if (
    pattern.startsWith("!") ||
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined
  }
  const wildcard = segments.at(-1) === "*"
  const directories = wildcard ? segments.slice(0, -1) : segments
  if (directories.length === 0 || directories.some((segment) => !safeWorkspaceSegment.test(segment))) {
    return undefined
  }
  return { directories, wildcard }
}

export const findNonPortableBuildScripts = (manifestPath, scripts) =>
  Object.entries(scripts ?? {})
    .filter(
      ([name, command]) => isBuildScript(name) && Predicate.isString(command) && hasDirectEnvironmentAssignment(command)
    )
    .map(([name]) => `${manifestPath}: scripts.${name} uses a POSIX-only environment assignment`)

export const findCodeCommitWebLifecycleGaps = (manifestPath, scripts, dependencies, devDependencies) => {
  if (
    manifestPath !== "packages/codecommit-web/package.json" ||
    !("@knpkv/browser-pairing" in { ...dependencies, ...devDependencies })
  ) {
    return []
  }
  return codeCommitWebLifecycleRequirements
    .filter(({ script, matches }) => !matches(scripts?.[script] ?? ""))
    .map(({ script, description }) => `${manifestPath}: scripts.${script} must include ${description}`)
}

assert.deepEqual(
  findNonPortableBuildScripts("scripts/package.json", {
    postbuild: "OUTPUT=dist publish",
    prebuild: "CACHE=warm prepare",
    "storybook:build": "NODE_OPTIONS=--disable-warning=DEP0205 storybook build"
  }),
  [
    "scripts/package.json: scripts.postbuild uses a POSIX-only environment assignment",
    "scripts/package.json: scripts.prebuild uses a POSIX-only environment assignment",
    "scripts/package.json: scripts.storybook:build uses a POSIX-only environment assignment"
  ]
)
assert.equal(hasDirectEnvironmentAssignment("prepare | FOO=1 tool"), true)
assert.equal(hasDirectEnvironmentAssignment("prepare\nFOO=1 tool"), true)
assert.equal(hasDirectEnvironmentAssignment("prepare | cross-env FOO=1 tool"), false)
assert.equal(hasDirectEnvironmentAssignment("printf 'prepare | FOO=1 tool'"), false)
assert.equal(hasDirectEnvironmentAssignment("prepare & FOO=1 tool"), true)
assert.equal(hasDirectEnvironmentAssignment("prepare & cross-env FOO=1 tool"), false)
assert.equal(hasDirectEnvironmentAssignment("printf 'prepare & FOO=1 tool'"), false)
assert.equal(hasDirectEnvironmentAssignment("(FOO=1 tool)"), true)
assert.equal(hasDirectEnvironmentAssignment("(cross-env FOO=1 tool)"), false)
assert.equal(hasDirectEnvironmentAssignment("{ FOO=1 tool; }"), true)
assert.equal(hasDirectEnvironmentAssignment("tool {FOO=1}"), false)
assert.equal(hasDirectEnvironmentAssignment("tool { FOO=1 }"), false)
assert.equal(hasDirectEnvironmentAssignment("'(FOO=1 tool)'"), false)
assert.equal(hasDirectEnvironmentAssignment("\\(FOO=1 tool\\)"), false)
assert.deepEqual(
  findNonPortableBuildScripts("scratchpad/package.json", {
    "storybook:build": "tsx scripts/build-storybook.ts"
  }),
  []
)
assert.deepEqual(classifyWorkspacePattern("packages/*"), { directories: ["packages"], wildcard: true })
assert.deepEqual(classifyWorkspacePattern("scripts"), { directories: ["scripts"], wildcard: false })
assert.equal(classifyWorkspacePattern("!packages/legacy"), undefined)
assert.equal(classifyWorkspacePattern("packages/**"), undefined)
const codeCommitWebScripts = {
  predev: "pnpm --filter @knpkv/browser-pairing build",
  prestart: "pnpm --filter @knpkv/browser-pairing build",
  pretest: "pnpm --filter @knpkv/browser-pairing build",
  "test:browser": 'pnpm --filter "@knpkv/browser-pairing" build',
  check: "tsc -b tsconfig.json && tsc -p tsconfig.roles.json --noEmit"
}
const browserPairingDependency = { "@knpkv/browser-pairing": "workspace:^" }
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    codeCommitWebScripts,
    browserPairingDependency
  ),
  []
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: 'echo "pnpm --filter @knpkv/browser-pairing build"',
      check: 'echo "tsc -p tsconfig.roles.json --noEmit"'
    },
    browserPairingDependency
  ),
  [
    "packages/codecommit-web/package.json: scripts.predev must include a browser-pairing build",
    "packages/codecommit-web/package.json: scripts.check must include the role-aware tsc check"
  ]
)
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    {
      ...codeCommitWebScripts,
      predev: 'printf "pnpm --filter @knpkv/browser-pairing build"; pnpm --filter @knpkv/browser-pairing build',
      check: 'printf "tsc -p tsconfig.roles.json --noEmit" && tsc -p tsconfig.roles.json --noEmit'
    },
    browserPairingDependency
  ),
  []
)
for (const requirement of codeCommitWebLifecycleRequirements) {
  const invalidCommand =
    requirement.script === "check"
      ? "tsc -p tsconfig.roles.json --noEmit-extra"
      : "pnpm --filter @knpkv/browser-pairing build:docs"
  const invalidScripts = { ...codeCommitWebScripts, [requirement.script]: invalidCommand }
  assert.deepEqual(
    findCodeCommitWebLifecycleGaps("packages/codecommit-web/package.json", invalidScripts, browserPairingDependency),
    [`packages/codecommit-web/package.json: scripts.${requirement.script} must include ${requirement.description}`]
  )
}
assert.deepEqual(
  findCodeCommitWebLifecycleGaps(
    "packages/codecommit-web/package.json",
    { ...codeCommitWebScripts, prestart: "pnpm --filter @knpkv/browser-pairing build:docs" },
    browserPairingDependency
  ),
  ["packages/codecommit-web/package.json: scripts.prestart must include a browser-pairing build"]
)
assert.deepEqual(findCodeCommitWebLifecycleGaps("packages/other/package.json", {}, browserPairingDependency), [])

const workspaceManifestPaths = Effect.fn("PackageScriptPortability.workspaceManifestPaths")(
  function* (fileSystem, path, repositoryRoot, patterns) {
    const manifests = [path.join(repositoryRoot, "package.json")]
    for (const pattern of patterns) {
      const classified = classifyWorkspacePattern(pattern)
      if (classified === undefined) {
        return yield* Effect.fail(
          new PackageScriptPortabilityError({
            reason: `pnpm-workspace.yaml: unsupported workspace pattern ${JSON.stringify(pattern)}`
          })
        )
      }
      if (classified.directories.some((segment) => ignoredWorkspaceSegments.has(segment))) continue
      const directory = path.join(repositoryRoot, ...classified.directories)
      if (!classified.wildcard) {
        manifests.push(path.join(directory, "package.json"))
        continue
      }
      for (const entry of (yield* fileSystem.readDirectory(directory)).toSorted()) {
        if (ignoredWorkspaceSegments.has(entry)) continue
        const child = path.join(directory, entry)
        if ((yield* fileSystem.stat(child)).type === "Directory") manifests.push(path.join(child, "package.json"))
      }
    }
    return [...new Set(manifests)].toSorted()
  }
)

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  const repositoryRoot = path.dirname(path.dirname(scriptPath))
  const workspacePath = path.join(repositoryRoot, "pnpm-workspace.yaml")
  const workspaceSource = yield* fileSystem.readFileString(workspacePath)
  const workspace = yield* Effect.try({
    try: () => parse(workspaceSource),
    catch: (cause) => new PackageScriptPortabilityError({ cause, reason: "pnpm-workspace.yaml: invalid YAML" })
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceConfig)),
    Effect.mapError(
      (cause) => new PackageScriptPortabilityError({ cause, reason: "pnpm-workspace.yaml: invalid workspace list" })
    )
  )
  const manifestPaths = yield* workspaceManifestPaths(fileSystem, path, repositoryRoot, workspace.packages)

  const diagnostics = []
  let checked = 0
  for (const manifestPath of manifestPaths) {
    if (!(yield* fileSystem.exists(manifestPath))) continue
    const location = path.relative(repositoryRoot, manifestPath)
    const manifest = yield* Schema.decodeUnknownEffect(PackageManifest)(
      yield* fileSystem.readFileString(manifestPath)
    ).pipe(
      Effect.mapError(
        (cause) => new PackageScriptPortabilityError({ cause, reason: `${location}: invalid package manifest` })
      )
    )
    diagnostics.push(
      ...findNonPortableBuildScripts(location, manifest.scripts),
      ...findCodeCommitWebLifecycleGaps(location, manifest.scripts, manifest.dependencies, manifest.devDependencies)
    )
    checked += 1
  }

  if (diagnostics.length > 0) {
    return yield* Effect.fail(new PackageScriptPortabilityError({ reason: diagnostics.join("\n") }))
  }
  yield* Console.log(`Package-script portability checked ${checked} manifests`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
