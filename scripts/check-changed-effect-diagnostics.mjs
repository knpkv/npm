import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"

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

const lspConfig = JSON.stringify({
  diagnosticSeverity: {
    strictBooleanExpressions: "suggestion",
    strictEffectProvide: "suggestion"
  }
})

const isCheckedSource = (file) =>
  /\.(?:ts|tsx)$/u.test(file) &&
  !file.split("/").some((segment) => segment === "generated" || segment === "node_modules") &&
  !file.startsWith("repos/effect/")

const validateDiagnostics = (records) =>
  records.flatMap(({ diagnostics, file }) =>
    diagnostics.map(({ column, line, message, name }) => `${file}:${line}:${column}: effect(${name}): ${message}`)
  )

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
  const githubBase = Option.getOrUndefined(yield* Config.option(Config.string("GITHUB_BASE_REF")))
  const candidates = [
    configuredBase,
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
    git(["diff", "--name-only", "--diff-filter=ACMR", `${mergeBase}...HEAD`]),
    git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]),
    git(["diff", "--name-only", "--diff-filter=ACMR"])
  ])
  return [...new Set(outputs.flatMap((output) => output.split("\n")).filter(isCheckedSource))].toSorted()
})

const inspectFile = Effect.fn("ChangedEffectDiagnostics.inspectFile")(
  function* (spawner, executable, repositoryRoot, file) {
    const handle = yield* spawner.spawn(
      ChildProcess.make(executable, ["diagnostics", "--file", file, "--format", "json", "--lspconfig", lspConfig], {
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
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* fail(`${file}: Effect diagnostics failed: ${stderr.trim()}`)
    }
    const decoded = yield* Schema.decodeEffect(DiagnosticsOutput)(stdout).pipe(
      Effect.mapError(
        (cause) => new ChangedEffectDiagnosticsError({ cause, reason: `${file}: invalid diagnostics output` })
      )
    )
    return { diagnostics: decoded.diagnostics, file }
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
  const records = []
  for (const file of files) records.push(yield* inspectFile(spawner, executable, repositoryRoot, file))
  const diagnostics = validateDiagnostics(records)
  if (diagnostics.length > 0) {
    return yield* fail(`Changed Effect diagnostics failed:\n- ${diagnostics.join("\n- ")}`)
  }
  yield* Console.log(`Changed Effect diagnostics checked ${files.length} TypeScript files`)
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
