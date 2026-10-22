import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import {
  failedLine,
  makeMemoryRunLog,
  outputTail,
  RunEntry,
  RunId,
  RunLog,
  runLogLines,
  summarizeRuns
} from "../src/index.js"

const at = (time: string) => DateTime.makeUnsafe(`2026-10-16T${time}Z`)
const runA = Schema.decodeUnknownSync(RunId)("run-a")
const runB = Schema.decodeUnknownSync(RunId)("run-b")
const entry = Schema.decodeUnknownSync(RunEntry)

const started = (runId: string, accountId: string, time: string) =>
  entry({ _tag: "Started", runId, accountId, reason: "Released", at: `2026-10-16T${time}Z` })
const step = (runId: string, name: string, status: string, time: string, detail: string | null = null) =>
  entry({ _tag: "Step", runId, step: name, status, at: `2026-10-16T${time}Z`, detail, output: [] })
const finished = (runId: string, outcome: string, time: string, blocker: string | null = null) =>
  entry({ _tag: "Finished", runId, outcome, blocker, at: `2026-10-16T${time}Z` })

describe("run log", () => {
  it("folds entries into one summary per run, newest first, with the step in progress", () => {
    const runs = summarizeRuns([
      started("run-a", "111111111111", "08:00:00"),
      step("run-a", "dry run", "ok", "08:01:00"),
      step("run-a", "verify", "failed", "08:05:00", "3 resources still removable."),
      finished("run-a", "Quarantined", "08:05:01", "verify: 3 resources still removable."),
      started("run-b", "222222222222", "09:00:00"),
      step("run-b", "sign in", "ok", "09:00:02"),
      step("run-b", "nuke", "started", "09:02:00")
    ])
    expect(runs.map(({ runId }) => runId)).toEqual([runB, runA])
    expect(runs[0]).toMatchObject({
      accountId: "222222222222",
      outcome: null,
      current: "nuke",
      endedAt: null,
      failedStep: null
    })
    expect(runs[1]).toMatchObject({
      outcome: "Quarantined",
      failedStep: "verify",
      blocker: "verify: 3 resources still removable.",
      current: null,
      startedAt: at("08:00:00"),
      endedAt: at("08:05:01")
    })
  })

  it("keeps the failed step only for a run whose step failed", () => {
    const runs = summarizeRuns([
      started("run-a", "111111111111", "08:00:00"),
      step("run-a", "nuke", "failed", "08:02:00", "S3Bucket could not be removed."),
      step("run-a", "verify", "started", "08:03:00"),
      finished("run-a", "Quarantined", "08:04:00", "nuke: failed"),
      started("run-b", "111111111111", "09:00:00"),
      step("run-b", "nuke", "ok", "09:02:00"),
      finished("run-b", "Available", "09:05:00")
    ])
    expect(runs.map(({ failedStep, runId }) => [runId, failedStep])).toEqual([[runB, null], [runA, "nuke"]])
  })

  it("ignores entries of a run whose start it never saw", () => {
    expect(summarizeRuns([step("run-x", "nuke", "ok", "08:00:00")])).toEqual([])
  })

  it.effect("the memory log keeps a run's entries in order and pages recent runs", () =>
    Effect.gen(function*() {
      const log = yield* RunLog
      yield* log.record(started("run-a", "111111111111", "08:00:00"))
      yield* log.record(step("run-a", "sign in", "ok", "08:00:01"))
      yield* log.record(started("run-b", "222222222222", "09:00:00"))
      expect((yield* log.entries(runA)).map(({ _tag }) => _tag)).toEqual(["Started", "Step"])
      expect((yield* log.recent(1)).map(({ runId }) => runId)).toEqual([runB])
      expect(yield* log.entries(Schema.decodeUnknownSync(RunId)("run-none"))).toEqual([])
    }).pipe(Effect.provideServiceEffect(RunLog, makeMemoryRunLog)))

  it("keeps the last lines of a run's output, uncoloured and bounded", () => {
    const esc = String.fromCharCode(27)
    const output = [...Array.from({ length: 50 }, (_, index) => `line ${index}`), `${esc}[31mred${esc}[0m\r`].join("\n")
    const tail = outputTail(output)
    expect(tail).toHaveLength(40)
    expect(tail.at(-1)).toBe("red")
    expect(tail[0]).toBe("line 11")
    expect(outputTail(`${"x".repeat(400)}\n\n`)).toEqual(["x".repeat(300)])
  })
})

describe("run log lines", () => {
  const nuke = (status: string, time: string, output: ReadonlyArray<string>, detail: string | null = null) =>
    entry({ _tag: "Step", runId: "run-a", step: "nuke", status, at: `2026-10-16T${time}Z`, detail, output })

  it("reads a run as timed lines: start, each step with its output before its result, the end", () => {
    const lines = runLogLines([
      started("run-a", "111111111111", "08:00:00"),
      step("run-a", "sign in", "ok", "08:00:01"),
      nuke("started", "08:00:02", []),
      nuke(
        "failed",
        "08:01:00",
        ["S3Bucket scratch-uploads waiting for objects", "removed 3"],
        "S3Bucket - failed: locked"
      ),
      finished("run-a", "Quarantined", "08:01:01", "nuke: S3Bucket - failed: locked")
    ])
    expect(lines.map(({ at: time, text }) => [DateTime.formatIso(time), text])).toEqual([
      ["2026-10-16T08:00:00.000Z", "run run-a started, reason released, account 111111111111"],
      ["2026-10-16T08:00:01.000Z", "sign in: ok"],
      ["2026-10-16T08:00:02.000Z", "nuke: started"],
      ["2026-10-16T08:01:00.000Z", "S3Bucket scratch-uploads waiting for objects"],
      ["2026-10-16T08:01:00.000Z", "removed 3"],
      ["2026-10-16T08:01:00.000Z", "nuke: failed: S3Bucket - failed: locked"],
      ["2026-10-16T08:01:01.000Z", "run run-a ended, account quarantined"]
    ])
  })

  it("names the stored line of the step that failed, or the run's blocker, or nothing", () => {
    expect(failedLine([
      started("run-a", "111111111111", "08:00:00"),
      step("run-a", "verify", "failed", "08:05:00", "3 resources still removable."),
      finished("run-a", "Quarantined", "08:05:01", "verify: 3 resources still removable.")
    ])).toBe("verify: 3 resources still removable.")
    expect(failedLine([
      started("run-a", "111111111111", "08:00:00"),
      step("run-a", "verify", "failed", "08:05:00", "3 resources still removable.")
    ])).toBe("verify: 3 resources still removable.")
    expect(failedLine([started("run-a", "111111111111", "08:00:00"), finished("run-a", "Available", "08:09:00")]))
      .toBeNull()
  })

  it("clamps a line and the stored line to 2,000 characters, so one long line can't push the log past its read", () => {
    const long = "x".repeat(5_000)
    const lines = runLogLines([
      started("run-a", "111111111111", "08:00:00"),
      nuke("failed", "08:01:00", [long], "locked")
    ])
    expect(lines.map(({ text }) => text.length)).toEqual([
      "run run-a started, reason released, account 111111111111".length,
      2_000,
      "nuke: failed: locked".length
    ])
    expect(
      failedLine([started("run-a", "111111111111", "08:00:00"), finished("run-a", "Quarantined", "08:01:01", long)])
    )
      .toHaveLength(2_000)
  })
})
