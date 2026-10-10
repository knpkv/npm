import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type { ChildProcessSpawner } from "effect/process"
import { ChildProcess } from "effect/process"
import * as Schema from "effect/Schema"
import { matchesGlob } from "node:path"
import * as TypeScript from "typescript"
import { parse as parseYaml } from "yaml"

export class StagedInputsError extends Data.TaggedError("StagedInputsError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

/** Workspace patterns apply to package directories, including explicitly configured tooling and scratch workspaces. */
export const isWorkspaceDirectory = (directory: string, patterns: ReadonlyArray<string>): boolean =>
  patterns.some((pattern) => !pattern.startsWith("!") && matchesGlob(directory, pattern)) &&
  !patterns.some((pattern) => pattern.startsWith("!") && matchesGlob(directory, pattern.slice(1)))

const isWorkspaceInput = (file: string, patterns: ReadonlyArray<string>): boolean => {
  const segments = file.split("/")
  return segments.some((_, index) => isWorkspaceDirectory(segments.slice(0, index + 1).join("/"), patterns))
}

const isUntrackedInput = (file: string, workspacePatterns: ReadonlyArray<string>): boolean =>
  isWorkspaceInput(file, workspacePatterns) ||
  file.startsWith(".changeset/") || file.startsWith("docs/debt") ||
  /^(?:packages|scripts|ast-grep|\.github|\.husky|repos|patches|\.specs)\//u.test(file) ||
  (!file.includes("/") && (
    /^(?:package\.json|pnpm[^/]*|tsconfig[^/]*|vitest[^/]*|eslint[^/]*|oxlint[^/]*|(?:\.)?prettier[^/]*|sgconfig[^/]*|\.(?:gitignore|gitattributes|gitmodules|npmrc|nvmrc|node-version|env[^/]*|eslint[^/]*|oxlint[^/]*|ignore|rgignore|pnpmfile[^/]*))$/u
      .test(file) ||
    /\.(?:jsonc?|ya?ml|toml|[cm]?[jt]s|sh)$/u.test(file)
  ))

/** Gates use the working tree only when its tracked inputs equal the index and no extra input can be loaded. */
export const stagedInputProblem = (
  unstaged: ReadonlyArray<string>,
  untracked: ReadonlyArray<string>,
  workspacePatterns: ReadonlyArray<string>,
  recreatedDeletions: ReadonlyArray<string> = []
): string | undefined => {
  const inputs = [
    ...new Set([...untracked.filter((file) => isUntrackedInput(file, workspacePatterns)), ...recreatedDeletions])
  ]
  if (unstaged.length === 0 && inputs.length === 0) return undefined
  return `stage or stash; gate checks staged content only. Unstaged tracked files: ${
    unstaged.join(", ") || "none"
  }. Untracked check inputs or recreated staged deletions: ${inputs.join(", ") || "none"}`
}

const gitPaths = Effect.fn("stagedInputs.gitPaths")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  root: string,
  args: ReadonlyArray<string>
) {
  const output = yield* spawner.string(ChildProcess.make("git", args, { cwd: root })).pipe(
    Effect.mapError((cause) => new StagedInputsError({ reason: "could not inspect gate inputs", cause }))
  )
  return output.split("\0").filter((file) => file.length > 0)
})

/** Decode the maintained workspace directory patterns, failing closed on missing or invalid configuration. */
export const workspacePatterns = Effect.fn("stagedInputs.workspacePatterns")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const content = yield* fs.readFileString(path.join(root, "pnpm-workspace.yaml"))
  const config = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.Struct({ packages: Schema.Array(Schema.String) }))(parseYaml(content)),
    catch: (cause) => new StagedInputsError({ reason: "could not decode workspace configuration", cause })
  })
  return config.packages
})

/** Retain current and deleted workspace manifests so dependency selection survives directory deletions and renames. */
export const workspaceDirectories = Effect.fn("stagedInputs.workspaceDirectories")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  root: string
) {
  const patterns = yield* workspacePatterns(root)
  const current = yield* gitPaths(spawner, root, ["ls-files", "-z"])
  const previous = yield* gitPaths(spawner, root, ["ls-tree", "-r", "--name-only", "-z", "HEAD"])
  return [
    ...new Set(
      [...current, ...previous]
        .filter((file) => file.endsWith("/package.json"))
        .map((file) => file.slice(0, -"/package.json".length))
        .filter((directory) => isWorkspaceDirectory(directory, patterns))
    )
  ].sort()
})

/** Call before either local gate. Ignored build outputs stay excluded, except a recreated staged deletion anywhere. */
export const assertStagedInputs = Effect.fn("stagedInputs.assertStagedInputs")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  root: string
) {
  const unstaged = yield* gitPaths(spawner, root, ["diff", "--name-only", "-z", "--"])
  const trackedProblem = stagedInputProblem(unstaged, [], [])
  if (trackedProblem !== undefined) return yield* new StagedInputsError({ reason: trackedProblem })
  const patterns = yield* workspacePatterns(root)
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const deleted = yield* gitPaths(spawner, root, [
    "diff",
    "--cached",
    "--no-renames",
    "--diff-filter=D",
    "--name-only",
    "-z",
    "--"
  ])
  const recreated = yield* Effect.filter(deleted, (file) =>
    fs.readDirectory(path.dirname(path.join(root, file))).pipe(
      Effect.map((entries) => entries.includes(path.basename(file))),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error))
    ))
  const untracked = yield* gitPaths(spawner, root, ["ls-files", "--others", "--exclude-standard", "-z"])
  const reason = stagedInputProblem([], untracked, patterns, recreated)
  if (reason !== undefined) return yield* new StagedInputsError({ reason })
})

/** Parse literal specifiers, including comments. Any edit in a cross-imported package selects full to cover its helpers. */
export const crossPackageImportTargets = (
  importer: string,
  source: string,
  directories: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const ownerOf = (file: string) =>
    directories.find((directory) => file === directory || file.startsWith(`${directory}/`))
  const owner = ownerOf(importer)
  if (owner === undefined) return []
  const targets = new Set<string>()
  for (const { fileName: specifier } of TypeScript.preProcessFile(source, true, true).importedFiles) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue
    const segments = `${importer.slice(0, importer.lastIndexOf("/"))}/${specifier}`.split("/")
    const resolved: Array<string> = []
    for (const segment of segments) {
      if (segment === "..") resolved.pop()
      else if (segment !== "." && segment !== "") resolved.push(segment)
    }
    const targetOwner = ownerOf(resolved.join("/"))
    if (targetOwner !== undefined && targetOwner !== owner) targets.add(targetOwner)
  }
  return [...targets]
}

/** Scan tracked workspace JS/TS sources, excluding generated/vendor trees, without starting a build or test runner. */
export const crossPackageInputs = Effect.fn("stagedInputs.crossPackageInputs")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  root: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directories = (yield* workspaceDirectories(spawner, root)).sort((left, right) => right.length - left.length)
  const files = yield* gitPaths(spawner, root, ["ls-files", "-z"])
  const targets = new Set<string>()
  for (const file of files) {
    if (
      !directories.some((directory) => file.startsWith(`${directory}/`)) ||
      !/\.(?:[cm]?[jt]sx?)$/u.test(file) || /\/(?:generated|vendor|node_modules|dist)\//u.test(file)
    ) continue
    const absolute = path.join(root, file)
    if (!(yield* fs.exists(absolute))) continue
    for (const target of crossPackageImportTargets(file, yield* fs.readFileString(absolute), directories)) {
      targets.add(target)
    }
  }
  return [...targets]
})
