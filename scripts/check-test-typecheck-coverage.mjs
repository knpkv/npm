import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { URL } from "node:url"
import ts from "typescript"

import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
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
 * The TypeScript projects a package's `check` script typechecks, as paths relative to the package:
 * `tsc -p X`/`--project X` names X, `tsc -b X`/`--build X` names X, and a bare `tsc` or `tsc -b` is
 * `tsconfig.json`.
 */
export const checkedProjects = (checkScript) =>
  (checkScript ?? "").split(/&&|\|\||;/u).flatMap((segment) => {
    const command = segment.match(/(?:^|\s)(?:tsc|tspc|tsgo)(?:\s+(.*))?$/u)
    if (command === null) return []
    const args = command[1] ?? ""
    const project =
      args.match(/(?:^|\s)(?:-p|--project)\s+(\S+)/u)?.[1] ?? args.match(/(?:^|\s)(?:-b|--build)\s+([^\s-]\S*)/u)?.[1]
    const name = (project ?? "tsconfig.json").replaceAll(/["']/gu, "").replace(/^\.\//u, "")
    return [name.endsWith(".json") ? name : `${name === "." ? "" : `${name}/`}tsconfig.json`]
  })

/**
 * Packages whose test files are not all typechecked, and allowlisted packages whose tests now are.
 * `coverage` maps each package to its uncovered test files (package-relative).
 */
export const coverageFailures = (coverage, allowlist) => {
  const failures = []
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

// Every file a project includes, following project references, by absolute path.
const projectFiles = (configPath, seen = new Set()) => {
  if (seen.has(configPath) || !ts.sys.fileExists(configPath)) return []
  seen.add(configPath)
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error !== undefined) return []
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, configPath.slice(0, configPath.lastIndexOf("/")))
  const references = (parsed.projectReferences ?? []).flatMap((reference) =>
    projectFiles(ts.resolveProjectReferencePath(reference), seen)
  )
  return [...parsed.fileNames, ...references]
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
      checkedProjects(manifest.scripts?.check).flatMap((project) => projectFiles(path.join(packageDirectory, project)))
    )
    coverage.set(
      name,
      tests.filter((test) => !covered.has(path.join(packageDirectory, test)))
    )
  }
  const failures = coverageFailures(coverage, allowlist)
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
