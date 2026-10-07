import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { URL } from "node:url"
import ts from "typescript"

import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

class TestTypecheckCoverageError extends Data.TaggedError("TestTypecheckCoverageError") {
  get message() {
    return this.reason
  }
}

const fail = (reason) => new TestTypecheckCoverageError({ reason })

const allowlistPath = "scripts/test-typecheck-allowlist.json"

// tsc options (compared lowercased, as tsc does) that keep a run a full typecheck of its projects. Anything else,
// such as --noCheck, --showConfig or a source file argument, may check less, so it credits nothing (fail closed).
const checkingFlags = new Set(["--noemit", "--pretty", "--incremental", "--verbose", "--force"])
const projectFlags = new Set(["-p", "--project"])
const buildFlags = new Set(["-b", "--build"])

const configName = (project) => {
  const name = project.replaceAll(/["']/gu, "").replace(/^\.\//u, "")
  return name.endsWith(".json") ? name : `${name === "." ? "" : `${name}/`}tsconfig.json`
}

// The projects one tsc argument list checks, or [] when any argument is outside the allowlist.
const invocationProjects = (args) => {
  const tokens = args.split(/\s+/u).filter((token) => token !== "")
  const build = tokens.some((token) => buildFlags.has(token.toLowerCase()))
  const projects = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const flag = token.toLowerCase()
    if (projectFlags.has(flag) && !build) {
      const project = tokens[++index]
      if (project === undefined || project.startsWith("-")) return []
      projects.push(project)
    } else if (buildFlags.has(flag) || checkingFlags.has(flag)) {
      continue
    } else if (build && !token.startsWith("-")) {
      projects.push(token)
    } else {
      return []
    }
  }
  if (!build && projects.length > 1) return []
  return (projects.length === 0 ? ["tsconfig.json"] : projects).map((project) => ({
    project: configName(project),
    build
  }))
}

const sourceFile = /\.(?:[cm]?ts|tsx)$/u
const declarationFile = /\.d\.[cm]?ts$/u
const testDirectory = /(?:^|\/)(?:test|e2e|dtslint)\//u
const testFileName = /\.(?:test|spec)\.(?:[cm]?ts|tsx)$/u

/** Whether a package-relative path is test code that a typechecked project must include. */
export const isTestSource = (relativePath) =>
  sourceFile.test(relativePath) &&
  !declarationFile.test(relativePath) &&
  !relativePath
    .split("/")
    .some((segment) => segment === "node_modules" || segment === "dist" || segment === "generated") &&
  (testDirectory.test(relativePath) || testFileName.test(relativePath))

/**
 * The TypeScript projects a package's `check` script typechecks, as paths relative to the package.
 * `tsc -p X`/`--project X` names X, `tsc -b X`/`--build X` names X, and a bare `tsc` or `tsc -b` is
 * `tsconfig.json`; only an allowlisted argument list counts. `build` is true for build mode, the only mode in which tsc also checks the project's
 * references. Only commands that gate the script count: segments joined by `&&`. A segment that
 * contains `||`, `;`, a pipe or `&` can succeed while tsc fails, so it is not counted (fail closed).
 */
export const checkedProjects = (checkScript) => {
  const script = checkScript ?? ""
  // Any recovery or sequencing path (`||`, `;`, a pipe, a background `&`) anywhere in the script can let it
  // succeed while tsc fails, so such a script credits no coverage at all (fail closed).
  if (/\|\||;|(?<![&|])[&|](?![&|])/u.test(script)) return []
  return script.split("&&").flatMap((segment) => {
    // tsc must be the command itself, optionally behind `pnpm exec`/`npm exec`/`npx`; `echo tsc …` is not a check.
    const command = segment.trim().match(/^(?:(?:pnpm|npm)\s+exec\s+|npx\s+)?(?:tsc|tspc|tsgo)(?:\s+(.*))?$/u)
    if (command === null) return []
    return invocationProjects(command[1] ?? "")
  })
}

/** The directory that contains a config file, for POSIX and Windows paths alike. */
export const configDirectory = (configPath) => ts.getDirectoryPath(ts.normalizePath(configPath))

/** Allowlist entries that the base branch's allowlist does not have: the list may only shrink. */
export const allowlistAdditions = (current, base) =>
  base === undefined
    ? []
    : Object.keys(current)
        .filter((name) => !Object.hasOwn(base, name))
        .sort()

/**
 * Packages whose test files are not all typechecked, and allowlisted packages whose tests now are.
 * `coverage` maps each package to its uncovered test files (package-relative).
 */
export const coverageFailures = (coverage, allowlist, baseAllowlist) => {
  const failures = allowlistAdditions(allowlist, baseAllowlist).map((name) => ({
    _tag: "AllowlistGrew",
    package: name
  }))
  for (const [name, uncovered] of [...coverage].sort(([left], [right]) => left.localeCompare(right))) {
    const listed = Object.hasOwn(allowlist, name)
    if (uncovered.length > 0 && !listed) failures.push({ _tag: "Uncovered", package: name, files: uncovered })
    if (uncovered.length === 0 && listed) failures.push({ _tag: "AllowlistStale", package: name })
  }
  for (const name of Object.keys(allowlist).sort()) {
    if (!coverage.has(name)) failures.push({ _tag: "AllowlistUnknown", package: name })
  }
  return failures
}

const describeFailure = (failure) => {
  switch (failure._tag) {
    case "Uncovered":
      return [
        `${failure.package}: ${failure.files.length} test file(s) are not in any project its check script typechecks:`,
        ...failure.files.slice(0, 10).map((file) => `    ${file}`),
        ...(failure.files.length > 10 ? [`    … and ${failure.files.length - 10} more`] : []),
        `    Fix: add test/tsconfig.json (extends ../tsconfig.json, noEmit, includes the tests) and append \`tsc -p test/tsconfig.json --noEmit\` to the package's check script.`
      ].join("\n")
    case "AllowlistStale":
      return `${failure.package}: every test file is typechecked now. Fix: remove it from ${allowlistPath}.`
    case "AllowlistGrew":
      return `${failure.package}: added to ${allowlistPath}, which may only shrink. Fix: typecheck its tests instead (add test/tsconfig.json to its check script).`
    case "AllowlistUnknown":
      return `${failure.package}: listed in ${allowlistPath} but not a workspace package with test files. Fix: remove the entry.`
  }
}

const Allowlist = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ owner: Schema.String, reason: Schema.String }))
)

const Manifest = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) })
)

/**
 * Every file a project includes, as normalized absolute paths. References are followed only when
 * `build` is true, because only `tsc -b` checks them.
 */
export const projectFiles = (configPath, build, seen = new Set()) => {
  const normalized = ts.normalizePath(configPath)
  if (seen.has(normalized) || !ts.sys.fileExists(normalized)) return []
  seen.add(normalized)
  const read = ts.readConfigFile(normalized, ts.sys.readFile)
  if (read.error !== undefined) return []
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, configDirectory(normalized))
  // A project that turns checking off (directly or through `extends`) typechecks nothing.
  if (parsed.options.noCheck === true) return []
  const references = build
    ? (parsed.projectReferences ?? []).flatMap((reference) =>
        projectFiles(ts.resolveProjectReferencePath(reference), build, seen)
      )
    : []
  return [...parsed.fileNames.map((file) => ts.normalizePath(file)), ...references]
}

const trackedFiles = Effect.fn("TestTypecheckCoverage.trackedFiles")(function* (repositoryRoot) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make("git", ["ls-files", "-z", "packages"], { cwd: repositoryRoot }))
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.decodeText(handle.stdout).pipe(Stream.mkString),
      Stream.decodeText(handle.stderr).pipe(Stream.mkString),
      handle.exitCode
    ],
    { concurrency: "unbounded" }
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) return yield* fail(`git ls-files failed: ${stderr.trim()}`)
  return stdout.split("\0").filter((file) => file.length > 0)
})

const git = Effect.fn("TestTypecheckCoverage.git")(function* (repositoryRoot, args) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: repositoryRoot }))
  const [stdout, exitCode] = yield* Effect.all(
    [Stream.decodeText(handle.stdout).pipe(Stream.mkString), handle.exitCode],
    {
      concurrency: "unbounded"
    }
  )
  return exitCode === ChildProcessSpawner.ExitCode(0) ? stdout : undefined
})

// The allowlist on the merge base with the target branch, or undefined when it has none yet (bootstrap).
const baseAllowlist = Effect.fn("TestTypecheckCoverage.baseAllowlist")(function* (repositoryRoot) {
  const configuredBase = Option.getOrUndefined(yield* Config.option(Config.String("TEST_TYPECHECK_BASE")))
  const githubBase = Option.getOrUndefined(yield* Config.option(Config.String("GITHUB_BASE_REF")))
  const candidates = [
    configuredBase,
    githubBase === undefined ? undefined : `origin/${githubBase}`,
    "origin/main",
    "main"
  ]
  for (const candidate of candidates.filter((value) => value !== undefined)) {
    const mergeBase = (yield* git(repositoryRoot, ["merge-base", "HEAD", candidate]))?.trim()
    if (mergeBase === undefined || mergeBase === "") continue
    const text = yield* git(repositoryRoot, ["show", `${mergeBase}:${allowlistPath}`])
    if (text === undefined) return undefined
    return yield* Schema.decodeEffect(Allowlist)(text).pipe(
      Effect.mapError((cause) => fail(`${allowlistPath} on ${candidate} is not valid: ${cause.message}`))
    )
  }
  return yield* fail(
    `No base branch to compare ${allowlistPath} against. Fix: set TEST_TYPECHECK_BASE to the target branch.`
  )
})

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const repositoryRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const allowlist = yield* fs.readFileString(path.join(repositoryRoot, allowlistPath)).pipe(
    Effect.flatMap(Schema.decodeEffect(Allowlist)),
    Effect.mapError((cause) => fail(`${allowlistPath} is not valid: ${cause.message}`))
  )
  const testsByPackage = new Map()
  for (const file of yield* trackedFiles(repositoryRoot)) {
    const [, name, ...rest] = file.split("/")
    const relative = rest.join("/")
    if (name === undefined || !isTestSource(relative)) continue
    testsByPackage.set(name, [...(testsByPackage.get(name) ?? []), relative])
  }
  const coverage = new Map()
  for (const [name, tests] of testsByPackage) {
    const packageDirectory = path.join(repositoryRoot, "packages", name)
    const manifest = yield* fs.readFileString(path.join(packageDirectory, "package.json")).pipe(
      Effect.flatMap(Schema.decodeEffect(Manifest)),
      Effect.mapError((cause) => fail(`packages/${name}/package.json is not valid: ${cause.message}`))
    )
    const covered = new Set(
      checkedProjects(manifest.scripts?.check).flatMap(({ build, project }) =>
        projectFiles(path.join(packageDirectory, project), build)
      )
    )
    coverage.set(
      name,
      tests.filter((test) => !covered.has(ts.normalizePath(path.join(packageDirectory, test))))
    )
  }
  const failures = coverageFailures(coverage, allowlist, yield* baseAllowlist(repositoryRoot))
  if (failures.length > 0) {
    return yield* fail(`Test typecheck coverage failed:\n- ${failures.map(describeFailure).join("\n- ")}`)
  }
  const pending = Object.keys(allowlist).length
  yield* Console.log(
    `Test typecheck coverage: ${coverage.size} packages checked, ${pending} allowlisted until their owners typecheck them`
  )
})

// Report a coverage failure as its message alone (no stack), then exit non-zero.
const main = program.pipe(
  Effect.tapError((error) =>
    error._tag === "TestTypecheckCoverageError" ? Console.error(error.reason) : Console.error(error)
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
