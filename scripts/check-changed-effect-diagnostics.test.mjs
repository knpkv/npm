import assert from "node:assert/strict"
import test from "node:test"

import { NodeServices } from "@effect/platform-node"
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import {
  changedFiles,
  changedLines,
  diagnosticScope,
  diagnosticsOnChangedLines,
  decodeInspectionOutput,
  inspectFile,
  inspectFiles,
  makeGit,
  resolveMergeBase
} from "./check-changed-effect-diagnostics.mjs"

const record = (file) => ({ file, diagnostics: [] })

const capture = () => {
  const lines = []
  return {
    lines,
    report: (line) =>
      Effect.sync(() => {
        lines.push(line)
      })
  }
}

const times = (...values) => {
  let index = 0
  return Effect.sync(() => values[index++])
}

const spawner = (stdout, exitCode = 0) => ({
  spawn: () =>
    Effect.succeed({
      stdout: Stream.make(new TextEncoder().encode(stdout)),
      stderr: Stream.empty,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode))
    })
})

test("staged diagnostics inspect the selected Control Center test and preserve blocking changed-line diagnostics", async () => {
  const file = "packages/control-center/test/unit/new.test.ts"
  const calls = []
  const git = (args) =>
    Effect.sync(() => {
      calls.push(args)
      return args.includes("--name-only") ? `${file}\0README.md\0` : `+++ b/${file}\n@@ -0,0 +1,2 @@\n+first\n+second\n`
    })
  const files = await Effect.runPromise(changedFiles(git, "branch-base", true))
  assert.deepEqual(files, [file])
  assert.deepEqual(calls[0], ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"])
  const lines = await Effect.runPromise(changedLines(git, "branch-base", files, true))
  assert.ok(calls[1].includes("--cached"))
  assert.ok(calls[1].includes("branch-base"))
  const failure = {
    line: 2,
    column: 1,
    name: "strictEffectProvide",
    message: "Provide only required services.",
    severity: "error"
  }
  const record = decodeInspectionOutput(
    file,
    JSON.stringify({ diagnostics: [{ file, ...failure }] }),
    "",
    ChildProcessSpawner.ExitCode(1)
  )
  assert.deepEqual(diagnosticsOnChangedLines([record], lines)[0].diagnostics, [{ file, ...failure }])
  assert.deepEqual(diagnosticsOnChangedLines([record], new Map([[file, new Set([1])]]))[0].diagnostics, [])
  assert.equal(diagnosticScope([]), "branch")
  assert.equal(diagnosticScope(["--staged"]), "staged")
  assert.equal(diagnosticScope(["--unknown"]), undefined)
  assert.equal(diagnosticScope(["--staged", "--unknown"]), undefined)
})

test("empty selection starts no diagnostic wave", async () => {
  const output = capture()
  const records = await Effect.runPromise(
    inspectFiles([], () => Effect.die("unexpected child"), times(), output.report)
  )
  assert.deepEqual(records, [])
  assert.deepEqual(output.lines, [])
})

test("one child reports bounded start and completion with elapsed time", async () => {
  const output = capture()
  const records = await Effect.runPromise(
    inspectFiles(["synthetic.ts"], (file) => Effect.succeed(record(file)), times(0n, 12_000_000n), output.report)
  )
  assert.deepEqual(records, [record("synthetic.ts")])
  assert.deepEqual(output.lines, [
    "Changed Effect diagnostics wave 1/1 START: 1 files",
    "Changed Effect diagnostics wave 1/1 COMPLETE: 1 files, 12ms"
  ])
})

test("five children retain four-way wave concurrency and result order", async () => {
  const output = capture()
  const files = Array.from({ length: 5 }, (_, index) => `synthetic-${index}.ts`)
  let active = 0
  let peak = 0
  const inspect = (file) =>
    Effect.gen(function* () {
      active++
      peak = Math.max(peak, active)
      yield* Effect.yieldNow
      active--
      return record(file)
    })
  const records = await Effect.runPromise(
    inspectFiles(files, inspect, times(0n, 8_000_000n, 8_000_000n, 20_000_000n), output.report)
  )
  assert.deepEqual(records, files.map(record))
  assert.equal(peak, 4)
  assert.deepEqual(output.lines, [
    "Changed Effect diagnostics wave 1/2 START: 4 files",
    "Changed Effect diagnostics wave 1/2 COMPLETE: 4 files, 8ms",
    "Changed Effect diagnostics wave 2/2 START: 1 files",
    "Changed Effect diagnostics wave 2/2 COMPLETE: 1 files, 12ms"
  ])
})

test("a failed child leaves its wave started but never completed", async () => {
  const output = capture()
  const failure = new Error("synthetic child failure")
  await assert.rejects(
    Effect.runPromise(inspectFiles(["synthetic.ts"], () => Effect.fail(failure), times(0n), output.report)),
    /synthetic child failure/u
  )
  assert.deepEqual(output.lines, ["Changed Effect diagnostics wave 1/1 START: 1 files"])
})

test("invalid and failed child output remain failures", () => {
  assert.throws(
    () => decodeInspectionOutput("synthetic.ts", "not-json", "", ChildProcessSpawner.ExitCode(0)),
    /invalid diagnostics output/u
  )
  assert.throws(
    () => decodeInspectionOutput("synthetic.ts", "", "synthetic spawn error", ChildProcessSpawner.ExitCode(1)),
    /process failed/u
  )
})

test("an invalid child output cannot emit a completed wave", async () => {
  const output = capture()
  const inspect = (file) =>
    Effect.try({
      try: () => decodeInspectionOutput(file, "not-json", "", ChildProcessSpawner.ExitCode(0)),
      catch: (cause) => cause
    })
  await assert.rejects(
    Effect.runPromise(inspectFiles(["synthetic.ts"], inspect, times(0n), output.report)),
    /invalid diagnostics output/u
  )
  assert.deepEqual(output.lines, ["Changed Effect diagnostics wave 1/1 START: 1 files"])
})

test("a synthetic child process keeps valid diagnostics and rejects invalid output", async () => {
  const valid = JSON.stringify({ diagnostics: [] })
  assert.deepEqual(
    await Effect.runPromise(inspectFile(spawner(valid), "synthetic-diagnostics", "/synthetic", "synthetic.ts")),
    record("synthetic.ts")
  )
  await assert.rejects(
    Effect.runPromise(inspectFile(spawner("not-json"), "synthetic-diagnostics", "/synthetic", "synthetic.ts")),
    /invalid diagnostics output/u
  )
  await assert.rejects(
    Effect.runPromise(inspectFile(spawner(valid, 1), "synthetic-diagnostics", "/synthetic", "synthetic.ts")),
    /process failed/u
  )
})

// A scratch repository with an in-progress `git merge --no-commit` of main into a feature branch: main
// changed packages/demo/src/main.ts after the fork, the branch changed packages/demo/src/feature.ts.
test("during a merge only this branch's own lines count as changed, not the incoming branch's", async () => {
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "effect-diagnostics-merge-" })
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      // None of the caller's GIT_* (a hook's GIT_DIR or GIT_INDEX_FILE) may leak into the scratch repository.
      const env = {
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.test",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: directory,
        PATH: yield* Config.String("PATH")
      }
      const run = (...args) =>
        spawner.spawn(ChildProcess.make("git", args, { cwd: directory, env, extendEnv: false })).pipe(
          Effect.flatMap((handle) => handle.exitCode),
          Effect.scoped
        )
      const write = (file, text) =>
        fileSystem
          .makeDirectory(path.dirname(path.join(directory, file)), { recursive: true })
          .pipe(Effect.andThen(fileSystem.writeFileString(path.join(directory, file), text)))
      yield* run("init", "-q", "-b", "main")
      yield* write("packages/demo/src/main.ts", "export const a = 1\n")
      yield* write("packages/demo/src/feature.ts", "export const b = 1\n")
      yield* run("add", ".")
      yield* run("commit", "-q", "-m", "base")
      yield* run("switch", "-q", "-c", "feature")
      yield* write("packages/demo/src/feature.ts", "export const b = 2\n")
      yield* run("commit", "-q", "-am", "feature")
      yield* run("switch", "-q", "main")
      yield* write("packages/demo/src/main.ts", "export const a = 2\n")
      yield* run("commit", "-q", "-am", "main moves")
      yield* run("update-ref", "refs/remotes/origin/main", "HEAD")
      yield* run("switch", "-q", "feature")
      yield* run("merge", "--no-commit", "--no-ff", "-q", "main")
      const git = yield* makeGit(directory, env)
      const base = yield* resolveMergeBase(git).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))
      )
      const stagedFiles = yield* changedFiles(git, base, true)
      return {
        base,
        main: yield* git(["rev-parse", "main"]),
        files: yield* changedFiles(git, base),
        stagedFiles,
        stagedLines: yield* changedLines(git, base, stagedFiles, true)
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
  assert.equal(outcome.base, outcome.main)
  assert.deepEqual(outcome.files, ["packages/demo/src/feature.ts"])
  assert.deepEqual(outcome.stagedFiles, ["packages/demo/src/main.ts"])
  assert.equal(outcome.stagedLines.size, 0)
})
