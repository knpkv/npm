import assert from "node:assert/strict"
import test from "node:test"

import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { ChildProcessSpawner } from "effect/unstable/process"

import { decodeInspectionOutput, inspectFile, inspectFiles } from "./check-changed-effect-diagnostics.mjs"

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
