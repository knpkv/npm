import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import { makeMemoryRunLog, outputTail, RunEntry, RunId, RunLog, summarizeRuns } from "../src/index.js"

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
    expect(runs[0]).toMatchObject({ accountId: "222222222222", outcome: null, current: "nuke", endedAt: null })
    expect(runs[1]).toMatchObject({
      outcome: "Quarantined",
      blocker: "verify: 3 resources still removable.",
      current: null,
      startedAt: at("08:00:00"),
      endedAt: at("08:05:01")
    })
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
