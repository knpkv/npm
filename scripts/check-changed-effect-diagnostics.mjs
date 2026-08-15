import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"
import { URL } from "node:url"

import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

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

const isCheckedSource = (file) =>
  /\.(?:ts|tsx)$/u.test(file) &&
  !file.split("/").some((segment) => segment === "generated" || segment === "node_modules") &&
  !file.startsWith("repos/effect/")

const validateDiagnostics = (records) =>
  records.flatMap(({ diagnostics, file }) =>
    diagnostics.map(({ column, line, message, name }) => `${file}:${line}:${column}: effect(${name}): ${message}`)
  )

const launchWaves = (files, concurrency = diagnosticConcurrency) =>
  Array.from({ length: Math.ceil(files.length / concurrency) }, (_, index) =>
    files.slice(index * concurrency, (index + 1) * concurrency)
  )

const decodeInspectionOutput = (file, stdout, stderr, exitCode) => {
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

const fail = (reason, cause) => Effect.fail(new ChangedEffectDiagnosticsError({ cause, reason }))

const makeGit = Effect.fn("ChangedEffectDiagnostics.makeGit")(function* (repositoryRoot) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return Effect.fn("ChangedEffectDiagnostics.git")(function* (args) {
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
      return yield* fail(`git ${args.join(" ")} failed: ${stderr.trim()}`)
    }
    return stdout.trim()
  })
})

const gitOption = (git, args) => git(args).pipe(Effect.option, Effect.map(Option.getOrUndefined))

const resolveMergeBase = Effect.fn("ChangedEffectDiagnostics.resolveMergeBase")(function* (git) {
  const configuredBase = Option.getOrUndefined(yield* Config.option(Config.string("EFFECT_DIAGNOSTICS_BASE")))
  const pushBase = Option.getOrUndefined(yield* Config.option(Config.string("GITHUB_EVENT_BEFORE")))
  const githubBase = Option.getOrUndefined(yield* Config.option(Config.string("GITHUB_BASE_REF")))
  const candidates = [
    configuredBase,
    pushBase === undefined || /^0+$/u.test(pushBase) ? undefined : pushBase,
    githubBase === undefined ? undefined : `origin/${githubBase}`,
    "origin/main",
    "main"
  ]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const mergeBase = yield* gitOption(git, ["merge-base", "HEAD", candidate])
    if (mergeBase !== undefined && mergeBase !== "") return mergeBase
  }
  return yield* fail("Could not resolve a merge base for changed Effect diagnostics")
})

const changedFiles = Effect.fn("ChangedEffectDiagnostics.changedFiles")(function* (git, mergeBase) {
  const outputs = yield* Effect.all([
    git(["diff", "--name-only", "-z", "--diff-filter=ACMR", `${mergeBase}...HEAD`]),
    git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]),
    git(["diff", "--name-only", "-z", "--diff-filter=ACMR"])
  ])
  return [...new Set(outputs.flatMap((output) => output.split("\0")).filter(isCheckedSource))].toSorted()
})

const inspectFile = Effect.fn("ChangedEffectDiagnostics.inspectFile")(
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

const inspectFiles = Effect.fn("ChangedEffectDiagnostics.inspectFiles")(
  function* (spawner, executable, repositoryRoot, files) {
    const records = []
    for (const wave of launchWaves(files)) {
      const waveRecords = yield* Effect.forEach(
        wave,
        (file) => inspectFile(spawner, executable, repositoryRoot, file),
        { concurrency: "unbounded" }
      )
      for (const record of waveRecords) records.push(record)
    }
    return records
  }
)

const program = Effect.gen(function* () {
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  const repositoryRoot = path.dirname(path.dirname(scriptPath))
  const executable = path.join(repositoryRoot, "node_modules", ".bin", "effect-language-service")
  const git = yield* makeGit(repositoryRoot)
  const mergeBase = yield* resolveMergeBase(git)
  const files = yield* changedFiles(git, mergeBase)
  const records = yield* inspectFiles(spawner, executable, repositoryRoot, files)
  const diagnostics = validateDiagnostics(records)
  if (diagnostics.length > 0) {
    return yield* fail(`Changed Effect diagnostics failed:\n- ${diagnostics.join("\n- ")}`)
  }
  yield* Console.log(`Changed Effect diagnostics checked ${files.length} TypeScript files`)
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
