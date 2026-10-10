import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"
import { URL } from "node:url"

import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Stdio from "effect/Stdio"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

class ChangedEffectDiagnosticsError extends Data.TaggedError("ChangedEffectDiagnosticsError") {
  get message() {
    return this.reason
  }
}

const DiagnosticsOutput = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        column: Schema.Number,
        file: Schema.String,
        line: Schema.Number,
        message: Schema.String,
        name: Schema.String,
        severity: Schema.String
      })
    )
  })
)

const diagnosticConcurrency = 4
const rootEffectSources = new Set(["vitest.setup.ts"])

const isCheckedSource = (file) =>
  /\.(?:ts|tsx)$/u.test(file) &&
  (file.startsWith("packages/") || file.startsWith("scripts/") || rootEffectSources.has(file)) &&
  !file.split("/").some((segment) => segment === "generated" || segment === "node_modules") &&
  !file.startsWith("repos/effect/")

const validateDiagnostics = (records) =>
  records.flatMap(({ diagnostics, file }) =>
    diagnostics.map(({ column, line, message, name }) => `${file}:${line}:${column}: effect(${name}): ${message}`)
  )

const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u

// Parse `git diff --unified=0` output into the 1-based post-image lines each file adds or changes.
// A file present in the diff with only deletions maps to an empty set.
export const changedLinesFromDiff = (diff) => {
  const changedLines = new Map()
  let current
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4)
      current = target === "/dev/null" ? undefined : target.replace(/^b\//u, "")
      if (current !== undefined && !changedLines.has(current)) changedLines.set(current, new Set())
      continue
    }
    if (!line.startsWith("@@")) continue
    const match = hunkHeader.exec(line)
    if (match === null || current === undefined) {
      throw new ChangedEffectDiagnosticsError({ reason: `Unparseable diff hunk header: ${line}` })
    }
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    const lines = changedLines.get(current)
    for (let offset = 0; offset < count; offset += 1) lines.add(start + offset)
  }
  return changedLines
}

// Keep only diagnostics reported on lines this change touched, so pre-existing diagnostics elsewhere in a
// touched file do not block unrelated work while every changed line still meets the gate.
export const diagnosticsOnChangedLines = (records, changedLines) =>
  records.map(({ diagnostics, file }) => {
    const lines = changedLines.get(file) ?? new Set()
    return { diagnostics: diagnostics.filter(({ line }) => lines.has(line)), file }
  })

const launchWaves = (files, concurrency = diagnosticConcurrency) =>
  Array.from({ length: Math.ceil(files.length / concurrency) }, (_, index) =>
    files.slice(index * concurrency, (index + 1) * concurrency)
  )

export const decodeInspectionOutput = (file, stdout, stderr, exitCode) => {
  let decoded
  try {
    decoded = Schema.decodeUnknownSync(DiagnosticsOutput)(stdout)
  } catch (cause) {
    const processFailure =
      exitCode === ChildProcessSpawner.ExitCode(0)
        ? `${file}: invalid diagnostics output`
        : `${file}: Effect diagnostics process failed: ${stderr.trim()}`
    throw new ChangedEffectDiagnosticsError({ cause, reason: processFailure })
  }
  if (exitCode !== ChildProcessSpawner.ExitCode(0) && decoded.diagnostics.length === 0) {
    throw new ChangedEffectDiagnosticsError({
      reason: `${file}: Effect diagnostics process failed: ${stderr.trim()}`
    })
  }
  return { diagnostics: decoded.diagnostics, file }
}

assert.equal(isCheckedSource("packages/rly/src/Button.tsx"), true)
assert.equal(isCheckedSource("vitest.setup.ts"), true)
assert.equal(isCheckedSource("vitest.config.ts"), false)
assert.equal(isCheckedSource("packages/client/src/generated/Api.ts"), false)
assert.deepEqual(validateDiagnostics([{ diagnostics: [], file: "valid.ts" }]), [])
assert.deepEqual(
  validateDiagnostics([
    {
      diagnostics: [
        { column: 7, line: 3, message: "Use a strict boolean expression.", name: "strictBooleanExpressions" }
      ],
      file: "invalid.ts"
    }
  ]),
  ["invalid.ts:3:7: effect(strictBooleanExpressions): Use a strict boolean expression."]
)
const hundredFiles = Array.from({ length: 100 }, (_, index) => `file-${String(index)}.ts`)
const hundredFileWaves = launchWaves(hundredFiles)
assert.equal(hundredFileWaves.length, 25)
assert.equal(Math.max(...hundredFileWaves.map((wave) => wave.length)), diagnosticConcurrency)
assert.deepEqual(hundredFileWaves.flat(), hundredFiles)
assert.deepEqual(
  decodeInspectionOutput(
    "invalid.ts",
    JSON.stringify({
      diagnostics: [
        {
          column: 7,
          file: "invalid.ts",
          line: 3,
          message: "Use a strict boolean expression.",
          name: "strictBooleanExpressions",
          severity: "error"
        }
      ]
    }),
    "",
    ChildProcessSpawner.ExitCode(1)
  ),
  {
    diagnostics: [
      {
        column: 7,
        file: "invalid.ts",
        line: 3,
        message: "Use a strict boolean expression.",
        name: "strictBooleanExpressions",
        severity: "error"
      }
    ],
    file: "invalid.ts"
  }
)
assert.throws(
  () => decodeInspectionOutput("broken.ts", "", "spawn failed", ChildProcessSpawner.ExitCode(1)),
  /broken\.ts: Effect diagnostics process failed: spawn failed/u
)

const fixtureDiff = [
  "diff --git a/changed.ts b/changed.ts",
  "--- a/changed.ts",
  "+++ b/changed.ts",
  "@@ -2 +2 @@",
  "-old",
  "+new",
  "@@ -9,0 +10,2 @@",
  "+added",
  "+added",
  "diff --git a/deleted-lines.ts b/deleted-lines.ts",
  "--- a/deleted-lines.ts",
  "+++ b/deleted-lines.ts",
  "@@ -4,2 +3,0 @@",
  "-gone",
  "-gone"
].join("\n")
const fixtureLines = changedLinesFromDiff(fixtureDiff)
assert.deepEqual([...fixtureLines.get("changed.ts")], [2, 10, 11])
assert.deepEqual([...fixtureLines.get("deleted-lines.ts")], [])
const fixtureDiagnostic = (line) => ({
  column: 1,
  line,
  message: "Use a strict boolean expression.",
  name: "strictBooleanExpressions"
})
// A new diagnostic on a changed line still fails the gate.
assert.deepEqual(
  validateDiagnostics(
    diagnosticsOnChangedLines([{ diagnostics: [fixtureDiagnostic(10)], file: "changed.ts" }], fixtureLines)
  ),
  ["changed.ts:10:1: effect(strictBooleanExpressions): Use a strict boolean expression."]
)
// An untouched pre-existing diagnostic passes.
assert.deepEqual(
  validateDiagnostics(
    diagnosticsOnChangedLines([{ diagnostics: [fixtureDiagnostic(5)], file: "changed.ts" }], fixtureLines)
  ),
  []
)
// A changed line in a file with older diagnostics elsewhere reports only its own.
assert.deepEqual(
  validateDiagnostics(
    diagnosticsOnChangedLines(
      [{ diagnostics: [fixtureDiagnostic(1), fixtureDiagnostic(2), fixtureDiagnostic(7)], file: "changed.ts" }],
      fixtureLines
    )
  ),
  ["changed.ts:2:1: effect(strictBooleanExpressions): Use a strict boolean expression."]
)
assert.throws(() => changedLinesFromDiff("+++ b/broken.ts\n@@ malformed @@"), /Unparseable diff hunk header/u)

const fail = (reason, cause) => Effect.fail(new ChangedEffectDiagnosticsError({ cause, reason }))

// Git in `repositoryRoot`. Production inherits the caller's environment (a hook's GIT_INDEX_FILE is the
// commit being checked); a scratch repository passes its own `env`, which replaces it entirely.
export const makeGit = Effect.fn("ChangedEffectDiagnostics.makeGit")(function* (repositoryRoot, env) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const options = env === undefined ? { cwd: repositoryRoot } : { cwd: repositoryRoot, env, extendEnv: false }
  return Effect.fn("ChangedEffectDiagnostics.git")(function* (args) {
    const handle = yield* spawner.spawn(ChildProcess.make("git", args, options))
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.decodeText(handle.stdout).pipe(Stream.mkString),
        Stream.decodeText(handle.stderr).pipe(Stream.mkString),
        handle.exitCode
      ],
      { concurrency: "unbounded" }
    )
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* fail(`git ${args.join(" ")} failed: ${stderr.trim()}`)
    }
    return stdout.trim()
  })
})

const gitOption = (git, args) => git(args).pipe(Effect.option, Effect.map(Option.getOrUndefined))

const baseCandidates = ({ configuredBase, eventName, githubBase, pushBase }) => [
  configuredBase,
  eventName === "push" && pushBase !== undefined && !/^0+$/u.test(pushBase) ? pushBase : undefined,
  githubBase === undefined ? undefined : `origin/${githubBase}`,
  "origin/main",
  "main"
]

assert.deepEqual(
  baseCandidates({ eventName: "push", pushBase: "abc", githubBase: undefined, configuredBase: undefined }),
  [undefined, "abc", undefined, "origin/main", "main"]
)
assert.deepEqual(
  baseCandidates({
    eventName: "pull_request",
    pushBase: "previous-head",
    githubBase: "main",
    configuredBase: undefined
  }),
  [undefined, undefined, "origin/main", "origin/main", "main"]
)

// The pending merge head of an in-progress merge, or undefined when none is pending. Read from the
// worktree's MERGE_HEAD file, since rev-parse alone can hide an octopus merge.
const pendingMergeHead = Effect.fn("ChangedEffectDiagnostics.pendingMergeHead")(function* (git) {
  const fileSystem = yield* FileSystem.FileSystem
  const mergeHeadPath = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"])
  if (!(yield* fileSystem.exists(mergeHeadPath))) return undefined
  const heads = (yield* fileSystem.readFileString(mergeHeadPath)).split("\n").filter((line) => line.trim() !== "")
  if (heads.length !== 1) {
    return yield* fail(`Changed Effect diagnostics needs exactly one pending merge head, found ${heads.length}`)
  }
  return yield* git(["rev-parse", "--verify", `${heads[0]}^{commit}`])
})

// An explicit EFFECT_DIAGNOSTICS_BASE wins. During a merge the index holds every change the incoming
// branch brings, and the fork point would count all of them as this branch's: the pending merge head is
// the base instead, leaving this branch's own lines and its conflict resolutions.
export const resolveMergeBase = Effect.fn("ChangedEffectDiagnostics.resolveMergeBase")(function* (git) {
  const configuredBase = Option.getOrUndefined(yield* Config.option(Config.String("EFFECT_DIAGNOSTICS_BASE")))
  if (configuredBase === undefined) {
    const mergeHead = yield* pendingMergeHead(git)
    if (mergeHead !== undefined) return mergeHead
  }
  const eventName = Option.getOrUndefined(yield* Config.option(Config.String("GITHUB_EVENT_NAME")))
  const pushBase = Option.getOrUndefined(yield* Config.option(Config.String("GITHUB_EVENT_BEFORE")))
  const githubBase = Option.getOrUndefined(yield* Config.option(Config.String("GITHUB_BASE_REF")))
  const candidates = baseCandidates({ configuredBase, eventName, githubBase, pushBase })
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const mergeBase = yield* gitOption(git, ["merge-base", "HEAD", candidate])
    if (mergeBase !== undefined && mergeBase !== "") return mergeBase
  }
  return yield* fail("Could not resolve a merge base for changed Effect diagnostics")
})

/** Local staged scope selects index changes against HEAD; branch/CI scope retains all changes against the base. */
export const changedFiles = Effect.fn("ChangedEffectDiagnostics.changedFiles")(function* (
  git,
  mergeBase,
  staged = false
) {
  const output = yield* git([
    "diff",
    ...(staged ? ["--cached"] : []),
    "--name-only",
    "-z",
    "--diff-filter=ACMR",
    ...(staged ? [] : [mergeBase])
  ])
  return [...new Set(output.split("\0").filter(isCheckedSource))].toSorted()
})

/** Staged files retain the branch/merge line baseline, so incoming merge lines do not count as this branch's edits. */
export const changedLines = Effect.fn("ChangedEffectDiagnostics.changedLines")(function* (
  git,
  mergeBase,
  files,
  staged = false
) {
  if (files.length === 0) return new Map()
  const diff = yield* git([
    "diff",
    ...(staged ? ["--cached"] : []),
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--diff-filter=ACMR",
    mergeBase,
    "--",
    ...files
  ])
  return yield* Effect.try({
    try: () => changedLinesFromDiff(diff),
    catch: (cause) =>
      cause instanceof ChangedEffectDiagnosticsError
        ? cause
        : new ChangedEffectDiagnosticsError({ cause, reason: "Could not read changed lines" })
  })
})

export const inspectFile = Effect.fn("ChangedEffectDiagnostics.inspectFile")(
  function* (spawner, executable, repositoryRoot, file) {
    const handle = yield* spawner.spawn(
      ChildProcess.make(executable, ["diagnostics", "--file", file, "--format", "json"], {
        cwd: repositoryRoot
      })
    )
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.decodeText(handle.stdout).pipe(Stream.mkString),
        Stream.decodeText(handle.stderr).pipe(Stream.mkString),
        handle.exitCode
      ],
      { concurrency: "unbounded" }
    )
    return yield* Effect.try({
      try: () => decodeInspectionOutput(file, stdout, stderr, exitCode),
      catch: (cause) =>
        cause instanceof ChangedEffectDiagnosticsError
          ? cause
          : new ChangedEffectDiagnosticsError({ cause, reason: `${file}: invalid diagnostics output` })
    })
  }
)

export const inspectFiles = Effect.fn("ChangedEffectDiagnostics.inspectFiles")(
  function* (files, inspect, clock, report) {
    const records = []
    const waves = launchWaves(files)
    for (const [index, wave] of waves.entries()) {
      const started = yield* clock
      const label = `Changed Effect diagnostics wave ${index + 1}/${waves.length}`
      yield* report(`${label} START: ${wave.length} files`)
      const waveRecords = yield* Effect.forEach(wave, inspect, { concurrency: "unbounded" })
      const elapsedMs = Number(((yield* clock) - started) / 1_000_000n)
      yield* report(`${label} COMPLETE: ${wave.length} files, ${elapsedMs}ms`)
      for (const record of waveRecords) records.push(record)
    }
    return records
  }
)

/** Only the local staged flag changes selection; reject unknown flags rather than silently checking another scope. */
export const diagnosticScope = (args) =>
  args.length === 0 ? "branch" : args.length === 1 && args[0] === "--staged" ? "staged" : undefined

const program = Effect.gen(function* () {
  const scope = diagnosticScope(yield* (yield* Stdio.Stdio).args)
  if (scope === undefined) return yield* fail("usage: node scripts/check-changed-effect-diagnostics.mjs [--staged]")
  const staged = scope === "staged"
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  const repositoryRoot = path.dirname(path.dirname(scriptPath))
  const executable = path.join(repositoryRoot, "node_modules", ".bin", "effect-language-service")
  const git = yield* makeGit(repositoryRoot)
  const mergeBase = yield* resolveMergeBase(git)
  const files = yield* changedFiles(git, mergeBase, staged)
  const records = yield* inspectFiles(
    files,
    (file) => inspectFile(spawner, executable, repositoryRoot, file),
    Clock.monotonicTimeNanos,
    Console.error
  )
  const diagnostics = validateDiagnostics(
    diagnosticsOnChangedLines(records, yield* changedLines(git, mergeBase, files, staged))
  )
  if (diagnostics.length > 0) {
    return yield* fail(`Changed Effect diagnostics failed:\n- ${diagnostics.join("\n- ")}`)
  }
  yield* Console.log(`Changed Effect diagnostics checked changed lines in ${files.length} TypeScript files`)
})

if (import.meta.main) NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
