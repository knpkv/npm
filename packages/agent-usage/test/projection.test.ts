import { describe, expect, it } from "@effect/vitest"
import type { LimitReading } from "../src/core/Model.js"
import { projectWindow } from "../src/limits/projection.js"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const now = Date.parse("2026-10-16T12:00:00Z")
const reset = now + 3 * HOUR

const known = (usedPercent: number, resetsAt: number | null = reset): LimitReading => ({
  _tag: "Known",
  usedPercent,
  resetsAt
})
const at = (minutesAgo: number, reading: LimitReading) => ({ at: now - minutesAgo * MINUTE, reading })
const fiveHour = (points: ReadonlyArray<{ readonly at: number; readonly reading: LimitReading }>) =>
  projectWindow({ windowMinutes: 300, points, now })

describe("projectWindow", () => {
  it("runs out before the reset at the last hour's pace", () => {
    expect(fiveHour([at(60, known(40)), at(30, known(50)), at(0, known(60))])).toEqual({
      _tag: "RunsOut",
      at: now + 2 * HOUR,
      burnPerHour: 20
    })
  })

  it("lasts until the reset when the pace crosses the limit only after it", () => {
    expect(fiveHour([at(60, known(40, now + HOUR)), at(0, known(60, now + HOUR))])).toEqual({
      _tag: "LastsUntilReset",
      burnPerHour: 20,
      atReset: 80
    })
  })

  it("lasts until the reset while idle, never projecting 0", () => {
    expect(fiveHour([at(60, known(40)), at(30, known(40)), at(0, known(40))])).toEqual({
      _tag: "LastsUntilReset",
      burnPerHour: 0,
      atReset: 40
    })
  })

  it("holds a changes-only level from before the hour at the hour boundary", () => {
    expect(fiveHour([at(180, known(40)), at(0, known(50))])).toEqual({
      _tag: "LastsUntilReset",
      burnPerHour: 10,
      atReset: 80
    })
  })

  it("averages a burst over the hour instead of extrapolating it", () => {
    expect(fiveHour([at(60, known(40)), at(5, known(40)), at(0, known(50))])).toMatchObject({ burnPerHour: 10 })
  })

  it("starts a new cycle at a lowered reading (a manual reset) instead of giving up", () => {
    expect(fiveHour([at(60, known(70)), at(40, known(80)), at(30, known(5)), at(0, known(15))])).toEqual({
      _tag: "LastsUntilReset",
      burnPerHour: 20,
      atReset: 75
    })
  })

  it("treats reset times a second apart as one cycle (the OAuth poll's jitter)", () => {
    expect(fiveHour([at(60, known(40, reset + 432)), at(0, known(60, reset))])).toMatchObject({ burnPerHour: 20 })
  })

  it("ignores another cycle's readings", () => {
    expect(fiveHour([at(60, known(90, now - 4 * HOUR)), at(0, known(10))])).toEqual({
      _tag: "Unknown",
      reason: "TooFewSamples"
    })
  })

  it("ignores failed readings between known ones", () => {
    expect(fiveHour([at(60, known(40)), at(30, { _tag: "Unknown", reason: "Fetch" }), at(0, known(60))]))
      .toMatchObject({ _tag: "RunsOut", burnPerHour: 20 })
  })

  it("holds the latest level until now, so a reading's age does not inflate the burn", () => {
    expect(fiveHour([at(120, known(40)), at(14, known(50))])).toEqual({
      _tag: "LastsUntilReset",
      burnPerHour: 10,
      atReset: 80
    })
  })

  it("keeps a weekly pace when its last change is most of an hour old", () => {
    expect(projectWindow({ windowMinutes: 10_080, points: [at(180, known(40)), at(50, known(41))], now }))
      .toMatchObject({ _tag: "LastsUntilReset", burnPerHour: 1 })
  })

  it("needs a quarter hour of the cycle to call a pace", () => {
    expect(fiveHour([at(0, known(40))])).toEqual({ _tag: "Unknown", reason: "TooFewSamples" })
    expect(fiveHour([at(10, known(1)), at(0, known(3))])).toEqual({ _tag: "Unknown", reason: "TooFewSamples" })
  })

  it("is stale past the window's freshness: 15 minutes for 5-hour, an hour for weekly", () => {
    const old = [at(80, known(40)), at(16, known(50))]
    expect(fiveHour(old)).toEqual({ _tag: "Unknown", reason: "Stale" })
    expect(projectWindow({ windowMinutes: 10_080, points: old, now })).toMatchObject({ _tag: "LastsUntilReset" })
    expect(projectWindow({ windowMinutes: 10_080, points: [at(120, known(40)), at(61, known(50))], now }))
      .toEqual({ _tag: "Unknown", reason: "Stale" })
  })

  it("is stale once the reading's reset has passed", () => {
    expect(fiveHour([at(60, known(40, now)), at(0, known(60, now))])).toEqual({ _tag: "Unknown", reason: "Stale" })
  })

  it("has no projection without a reset time", () => {
    expect(fiveHour([at(60, known(40, null)), at(0, known(60, null))])).toEqual({ _tag: "Unknown", reason: "NoReset" })
  })

  it("refuses a reading from the future", () => {
    expect(fiveHour([at(60, known(40)), at(-1, known(60))])).toEqual({ _tag: "Unknown", reason: "Malformed" })
  })

  it("has no projection when the latest reading failed", () => {
    expect(fiveHour([at(60, known(40)), at(0, { _tag: "Unknown", reason: "Fetch" })])).toEqual({
      _tag: "Unknown",
      reason: "NoReading"
    })
  })

  it("is out now at the ceiling, whatever the pace", () => {
    expect(fiveHour([at(0, known(100))])).toEqual({ _tag: "OutNow" })
    expect(projectWindow({ windowMinutes: 300, points: [at(0, known(90))], now, ceilingPercent: 85 })).toEqual({
      _tag: "OutNow"
    })
  })

  it("projects to a lower ceiling, as a caller keeping a reserve asks", () => {
    expect(
      projectWindow({ windowMinutes: 300, points: [at(60, known(40)), at(0, known(60))], now, ceilingPercent: 85 })
    ).toEqual({ _tag: "RunsOut", at: now + 1.25 * HOUR, burnPerHour: 20 })
  })
})
