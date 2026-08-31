import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"

import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as TypeScript from "typescript"
import { parse } from "yaml"

const releaseTypes = new Set(["major", "minor", "patch"])
const publicManifestFields = ["bin", "browser", "exports", "files", "main", "module", "types", "typesVersions"]
const runtimeDependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"]
const releaseManifestFields = [...publicManifestFields, ...runtimeDependencyFields]

const exportedCallableParameterProperties = (source, filePath) => {
  const sourceFile = TypeScript.createSourceFile(
    filePath,
    source,
    TypeScript.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? TypeScript.ScriptKind.TSX : TypeScript.ScriptKind.TS
  )
  const exports = new Map()
  const visit = (node) => {
    if (
      TypeScript.isVariableStatement(node) &&
      node.modifiers?.some(({ kind }) => kind === TypeScript.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        const initializer = declaration.initializer
        if (
          !TypeScript.isIdentifier(declaration.name) ||
          initializer === undefined ||
          !TypeScript.isArrowFunction(initializer)
        ) {
          continue
        }
        const firstParameter = initializer.parameters[0]
        if (firstParameter === undefined || !TypeScript.isObjectBindingPattern(firstParameter.name)) continue
        const properties = new Set()
        for (const element of firstParameter.name.elements) {
          if (!TypeScript.isBindingElement(element)) continue
          const propertyName = element.propertyName ?? element.name
          if (TypeScript.isIdentifier(propertyName)) properties.add(propertyName.text)
        }
        exports.set(declaration.name.text, properties)
      }
    }
    TypeScript.forEachChild(node, visit)
  }
  visit(sourceFile)
  return exports
}

const publicCallableAdditions = (previousSource, currentSource, filePath) => {
  const previous = exportedCallableParameterProperties(previousSource ?? "", filePath)
  const current = exportedCallableParameterProperties(currentSource, filePath)
  return [...current].flatMap(([name, properties]) => {
    const previousProperties = previous.get(name) ?? new Set()
    const added = [...properties].filter((property) => !previousProperties.has(property)).toSorted()
    return added.length === 0 ? [] : [{ filePath, name, properties: added }]
  })
}

const validatePublicCallableReleaseTypes = ({ additions, releaseTypes }) =>
  additions.flatMap(({ filePath, name, packageName, properties }) => {
    if (releaseTypes.get(packageName) !== "patch") return []
    const diagnostic = [
      `${packageName}: patch changeset cannot add public callable props`,
      properties.join(", "),
      `(${name} in ${filePath})`
    ].join(" ")
    return [diagnostic]
  })

class ChangesetCoverageError extends Data.TaggedError("ChangesetCoverageError") {
  get message() {
    return this.reason
  }
}

const fail = (reason, cause) => Effect.fail(new ChangesetCoverageError({ cause, reason }))

const splitLines = (output) => output.split(/\r?\n/u).filter((line) => line.length > 0)

const parseChangesetFrontmatter = (content, changesetPath) => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
  if (match === null) throw new ChangesetCoverageError({ reason: `${changesetPath}: changeset frontmatter is missing` })
  const frontmatter = parse(match[1])
  if (frontmatter === null || !Predicate.isObjectOrArray(frontmatter) || Array.isArray(frontmatter)) {
    throw new ChangesetCoverageError({
      reason: `${changesetPath}: changeset frontmatter must be a package-to-release map`
    })
  }
  const packages = new Set()
  for (const [name, releaseType] of Object.entries(frontmatter)) {
    if (!releaseTypes.has(releaseType)) {
      throw new ChangesetCoverageError({
        reason: `${changesetPath}: ${name} has invalid release type ${JSON.stringify(releaseType)}`
      })
    }
    packages.add(name)
  }
  return packages
}

const parseChangesetReleaseTypes = (content, changesetPath) => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
  if (match === null) throw new ChangesetCoverageError({ reason: `${changesetPath}: changeset frontmatter is missing` })
  const frontmatter = parse(match[1])
  if (frontmatter === null || !Predicate.isObjectOrArray(frontmatter) || Array.isArray(frontmatter)) {
    throw new ChangesetCoverageError({
      reason: `${changesetPath}: changeset frontmatter must be a package-to-release map`
    })
  }
  const releases = new Map()
  for (const [name, releaseType] of Object.entries(frontmatter)) {
    if (!releaseTypes.has(releaseType)) {
      throw new ChangesetCoverageError({
        reason: `${changesetPath}: ${name} has invalid release type ${JSON.stringify(releaseType)}`
      })
    }
    releases.set(name, releaseType)
  }
  return releases
}

const selectedReleaseManifestFields = (manifest) =>
  Object.fromEntries(releaseManifestFields.map((field) => [field, manifest?.[field]]))

const manifestsDifferForRelease = (current, previous) =>
  JSON.stringify(selectedReleaseManifestFields(current)) !== JSON.stringify(selectedReleaseManifestFields(previous))

const releaseBearingPackages = (paths, records) =>
  records.filter(
    ({ changedReleaseManifest, directory, publishable }) =>
      publishable &&
      (changedReleaseManifest || [...paths].some((changedPath) => changedPath.startsWith(`${directory}/src/`)))
  )

const validateCoverage = ({ changedChangesetNames, paths, records }) =>
  releaseBearingPackages(paths, records)
    .filter(({ name }) => !changedChangesetNames.has(name))
    .map(({ name }) => name)
    .toSorted()

const runSelfTest = () => {
  const records = [
    {
      changedReleaseManifest: false,
      directory: "packages/public",
      name: "@fixture/public",
      publishable: true
    },
    {
      changedReleaseManifest: false,
      directory: "packages/private",
      name: "@fixture/private",
      publishable: false
    }
  ]
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(["@fixture/public"]),
      paths: new Set(["packages/public/src/index.ts", ".changeset/current.md"]),
      records
    }),
    []
  )
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(),
      paths: new Set(["packages/public/src/index.ts"]),
      records
    }),
    ["@fixture/public"]
  )
  // The path set deliberately carries deleted paths too; a deleted public source
  // file in a surviving package must still be covered.
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(),
      paths: new Set(["packages/public/src/deleted.ts"]),
      records
    }),
    ["@fixture/public"]
  )
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(),
      paths: new Set(["packages/private/src/index.ts", "packages/public/test/index.test.ts"]),
      records
    }),
    []
  )
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(["@fixture/baseline-only"]),
      paths: new Set(["packages/public/src/index.ts"]),
      records
    }),
    ["@fixture/public"]
  )
  assert.deepEqual(
    validateCoverage({
      changedChangesetNames: new Set(["@fixture/public"]),
      paths: new Set(["packages/public/package.json"]),
      records: [{ ...records[0], changedReleaseManifest: true }]
    }),
    []
  )
  assert.equal(
    manifestsDifferForRelease(
      { dependencies: { effect: "4.0.0-rc.109" } },
      { dependencies: { effect: "4.0.0-beta.98" } }
    ),
    true
  )
  assert.equal(
    manifestsDifferForRelease(
      { devDependencies: { effect: "4.0.0-rc.109" } },
      { devDependencies: { effect: "4.0.0-beta.98" } }
    ),
    false
  )
  assert.deepEqual(
    [...parseChangesetFrontmatter('---\n"@fixture/public": patch\n---\n\nSummary.\n', ".changeset/valid.md")],
    ["@fixture/public"]
  )
  assert.throws(
    () => parseChangesetFrontmatter('---\n"@fixture/public": invalid\n---\n', ".changeset/invalid.md"),
    /invalid release type/u
  )
  const previousSource = "export const Public = ({ value }) => value\nconst Local = ({ value }) => value"
  const currentSource =
    "export const Public = ({ value, terminalViewportRef }) => value\nconst Local = ({ value, terminalViewportRef }) => value"
  const additions = publicCallableAdditions(previousSource, currentSource, "packages/public/src/index.ts").map(
    (addition) => ({
      ...addition,
      packageName: "@fixture/public"
    })
  )
  assert.deepEqual(additions, [
    {
      filePath: "packages/public/src/index.ts",
      name: "Public",
      packageName: "@fixture/public",
      properties: ["terminalViewportRef"]
    }
  ])
  assert.deepEqual(
    validatePublicCallableReleaseTypes({ additions, releaseTypes: new Map([["@fixture/public", "patch"]]) }),
    [
      "@fixture/public: patch changeset cannot add public callable props terminalViewportRef (Public in packages/public/src/index.ts)"
    ]
  )
  assert.deepEqual(
    validatePublicCallableReleaseTypes({ additions, releaseTypes: new Map([["@fixture/public", "minor"]]) }),
    []
  )
}

const decodeJson = Effect.fn("ChangesetCoverage.decodeJson")(function* (content, location) {
  return yield* Effect.try({
    try: () => JSON.parse(content),
    catch: (cause) => new ChangesetCoverageError({ cause, reason: `${location}: invalid JSON` })
  })
})

const makeGit = Effect.fn("ChangesetCoverage.makeGit")(function* (repositoryRoot) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  return Effect.fn("ChangesetCoverage.git")(function* (args) {
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

const gitOption = (git, args) => git(args).pipe(Effect.option, Effect.map(Option.getOrUndefined))

const resolveMergeBase = Effect.fn("ChangesetCoverage.resolveMergeBase")(function* (git, configuredBase, githubBase) {
  const candidates = [
    configuredBase,
    githubBase === undefined ? undefined : `origin/${githubBase}`,
    "origin/main",
    "main"
  ].filter((candidate) => candidate !== undefined)
  for (const candidate of candidates) {
    const mergeBase = yield* gitOption(git, ["merge-base", "HEAD", candidate])
    if (mergeBase !== undefined) return mergeBase
  }
  return yield* fail(
    `Could not resolve a changeset coverage merge base from: ${candidates.join(
      ", "
    )}. Fetch the base branch history or set CHANGESET_COVERAGE_BASE explicitly.`
  )
})

const runMergeBaseSelfTest = Effect.fn("ChangesetCoverage.runMergeBaseSelfTest")(function* () {
  const validAttempts = []
  const validGit = (args) => {
    validAttempts.push(args)
    return args.at(-1) === "origin/release"
      ? Effect.succeed("fixture-merge-base")
      : fail(`Fixture revision ${args.at(-1)} is unavailable`)
  }
  const mergeBase = yield* resolveMergeBase(validGit, "missing-base", "release")
  yield* Effect.try({
    try: () => {
      assert.equal(mergeBase, "fixture-merge-base")
      assert.deepEqual(validAttempts, [
        ["merge-base", "HEAD", "missing-base"],
        ["merge-base", "HEAD", "origin/release"]
      ])
    },
    catch: (cause) =>
      new ChangesetCoverageError({
        cause,
        reason: "Changeset coverage valid merge-base self-test failed"
      })
  })

  const invalidAttempts = []
  const invalidGit = (args) => {
    invalidAttempts.push(args)
    return fail(`Fixture revision ${args.at(-1)} is unavailable`)
  }
  const unresolved = yield* resolveMergeBase(invalidGit, undefined, undefined).pipe(Effect.flip)
  yield* Effect.try({
    try: () => {
      assert.match(unresolved.reason, /Could not resolve a changeset coverage merge base/u)
      assert.deepEqual(invalidAttempts, [
        ["merge-base", "HEAD", "origin/main"],
        ["merge-base", "HEAD", "main"]
      ])
      assert.equal(
        invalidAttempts.some(([command]) => command === "rev-parse"),
        false
      )
    },
    catch: (cause) =>
      new ChangesetCoverageError({
        cause,
        reason: "Changeset coverage fail-closed merge-base self-test failed"
      })
  })
})

const changedPaths = Effect.fn("ChangesetCoverage.changedPaths")(function* (git, mergeBase) {
  const [tracked, untracked] = yield* Effect.all([
    git(["diff", "--name-only", "--no-renames", "--diff-filter=ACDMRTUXB", mergeBase, "--"]),
    git(["ls-files", "--others", "--exclude-standard"])
  ])
  return new Set([...splitLines(tracked), ...splitLines(untracked)])
})

// Only frontmatter changed from this run's merge base may satisfy coverage.
// Existing changesets at the merge base describe older work and are deliberately absent.
const changedChangesetPackages = Effect.fn("ChangesetCoverage.changedChangesetPackages")(
  function* (fileSystem, path, repositoryRoot, paths) {
    const packages = new Set()
    const changesets = [...paths].filter(
      (changedPath) =>
        changedPath.startsWith(".changeset/") && changedPath.endsWith(".md") && changedPath !== ".changeset/README.md"
    )
    for (const changesetPath of changesets) {
      const absolute = path.join(repositoryRoot, changesetPath)
      if (!(yield* fileSystem.exists(absolute))) continue
      const content = yield* fileSystem.readFileString(absolute)
      const names = yield* Effect.try({
        try: () => parseChangesetFrontmatter(content, changesetPath),
        catch: (cause) => new ChangesetCoverageError({ cause, reason: `Could not parse ${changesetPath}` })
      })
      for (const name of names) packages.add(name)
    }
    return packages
  }
)

const changedChangesetReleaseTypes = Effect.fn("ChangesetCoverage.changedChangesetReleaseTypes")(
  function* (fileSystem, path, repositoryRoot, paths) {
    const releases = new Map()
    const changesets = [...paths].filter(
      (changedPath) =>
        changedPath.startsWith(".changeset/") && changedPath.endsWith(".md") && changedPath !== ".changeset/README.md"
    )
    for (const changesetPath of changesets) {
      const absolute = path.join(repositoryRoot, changesetPath)
      if (!(yield* fileSystem.exists(absolute))) continue
      const content = yield* fileSystem.readFileString(absolute)
      const parsed = yield* Effect.try({
        try: () => parseChangesetReleaseTypes(content, changesetPath),
        catch: (cause) => new ChangesetCoverageError({ cause, reason: `Could not parse ${changesetPath}` })
      })
      for (const [name, releaseType] of parsed) releases.set(name, releaseType)
    }
    return releases
  }
)

const sourcePaths = (paths) =>
  [...paths].filter(
    (changedPath) =>
      changedPath.startsWith("packages/") && changedPath.includes("/src/") && /\.(?:ts|tsx)$/u.test(changedPath)
  )

const changedPublicCallableAdditions = Effect.fn("ChangesetCoverage.changedPublicCallableAdditions")(
  function* (git, fileSystem, path, repositoryRoot, mergeBase, paths, records) {
    const additions = []
    for (const filePath of sourcePaths(paths)) {
      const record = records.find(({ directory }) => filePath.startsWith(`${directory}/`))
      if (record === undefined || !record.publishable) continue
      const absolute = path.join(repositoryRoot, filePath)
      if (!(yield* fileSystem.exists(absolute))) continue
      const currentSource = yield* fileSystem.readFileString(absolute)
      const previousSource = yield* gitOption(git, ["show", `${mergeBase}:${filePath}`])
      for (const addition of publicCallableAdditions(previousSource, currentSource, filePath)) {
        additions.push({ ...addition, packageName: record.name })
      }
    }
    return additions
  }
)

const valueAtRevision = Effect.fn("ChangesetCoverage.valueAtRevision")(function* (git, revision, filePath) {
  const content = yield* gitOption(git, ["show", `${revision}:${filePath}`])
  return content === undefined ? undefined : yield* decodeJson(content, `${revision}:${filePath}`)
})

const loadPackageRecords = Effect.fn("ChangesetCoverage.loadPackageRecords")(
  function* (git, fileSystem, path, repositoryRoot, packagesRoot, mergeBase, paths) {
    const records = []
    // Whole-package deletion has no surviving release target and is intentionally
    // outside this check. Deletions within a surviving package remain release-bearing.
    const entries = (yield* fileSystem.readDirectory(packagesRoot)).toSorted()
    for (const entry of entries) {
      const packageDirectory = path.join(packagesRoot, entry)
      if ((yield* fileSystem.stat(packageDirectory)).type !== "Directory") continue
      const manifestRelativePath = `packages/${entry}/package.json`
      const manifestPath = path.join(repositoryRoot, manifestRelativePath)
      if (!(yield* fileSystem.exists(manifestPath))) continue
      const current = yield* decodeJson(yield* fileSystem.readFileString(manifestPath), manifestRelativePath)
      const previous = paths.has(manifestRelativePath)
        ? yield* valueAtRevision(git, mergeBase, manifestRelativePath)
        : current
      records.push({
        changedReleaseManifest: paths.has(manifestRelativePath) && manifestsDifferForRelease(current, previous),
        directory: `packages/${entry}`,
        name: current.name ?? `packages/${entry}`,
        publishable: current.private !== true
      })
    }
    return records
  }
)

const program = Effect.gen(function* () {
  yield* Effect.try({
    try: runSelfTest,
    catch: (cause) => new ChangesetCoverageError({ cause, reason: "Changeset coverage self-test failed" })
  })
  yield* runMergeBaseSelfTest()

  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  if (args.includes("--self-test")) return

  const path = yield* Path.Path
  const fileSystem = yield* FileSystem.FileSystem
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  const repositoryRoot = path.dirname(path.dirname(scriptPath))
  const packagesRoot = path.join(repositoryRoot, "packages")
  const git = yield* makeGit(repositoryRoot)
  const configuredBase = Option.getOrUndefined(yield* Config.option(Config.string("CHANGESET_COVERAGE_BASE")))
  const githubBase = Option.getOrUndefined(yield* Config.option(Config.string("GITHUB_BASE_REF")))
  const mergeBase = yield* resolveMergeBase(git, configuredBase, githubBase)
  const paths = yield* changedPaths(git, mergeBase)
  const records = yield* loadPackageRecords(git, fileSystem, path, repositoryRoot, packagesRoot, mergeBase, paths)
  const changedChangesetNames = yield* changedChangesetPackages(fileSystem, path, repositoryRoot, paths)
  const changedReleaseTypes = yield* changedChangesetReleaseTypes(fileSystem, path, repositoryRoot, paths)
  const missing = validateCoverage({ changedChangesetNames, paths, records })
  if (missing.length > 0) {
    return yield* fail(
      `Changeset coverage failed for publishable package changes since ${mergeBase}:\n- ${missing.join("\n- ")}`
    )
  }
  const callableAdditions = yield* changedPublicCallableAdditions(
    git,
    fileSystem,
    path,
    repositoryRoot,
    mergeBase,
    paths,
    records
  )
  const releaseDiagnostics = validatePublicCallableReleaseTypes({
    additions: callableAdditions,
    releaseTypes: changedReleaseTypes
  })
  if (releaseDiagnostics.length > 0) {
    return yield* fail(`Changeset release type coverage failed:\n- ${releaseDiagnostics.join("\n- ")}`)
  }
  yield* Console.log(
    `Changeset coverage checked ${releaseBearingPackages(paths, records).length} publishable packages against changed changesets`
  )
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
