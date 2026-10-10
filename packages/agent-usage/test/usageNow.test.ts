import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import type { LimitSnapshot } from "../src/core/Model.js"
import { type MachineRange, type UsageGroup, UsageStore } from "../src/core/Store.js"
import { UsageRequestRefused } from "../src/server/ControlSocket.js"
import { describeUsageFailure } from "../src/server/Usage.js"
import { MAX_LIMIT_POINTS, readUsageNow, thinPoints } from "../src/server/UsageNow.js"
import { type LimitSeries, UsageNow } from "../src/shared/contracts.js"

const now = Date.parse("2026-10-08T12:00:00Z")
const hour = 3_600_000
const tokens = { input: 100, output: 20, reasoning: 0, cacheRead: 1_000, cacheWrite5m: 0, cacheWrite1h: 0 }

// Everything that books or prices a request is set, so a leak of any of it would show in the answer.
const group = (bucketStart: number, agent: UsageGroup["agent"], model: string): UsageGroup => ({
  bucketStart,
  agent,
  model,
  fast: false,
  longPrompt: false,
  attribution: { cwd: "/home/someone/secret-repo", branch: "feature/RPS-1234-private", activeTicket: "RPS-1234" },
  requests: 3,
  tokens
})

const snapshot = (observedAt: number, usedPercent: number): LimitSnapshot => ({
  agent: "claude",
  machine: "host-a",
  source: "claude-oauth-usage",
  label: "five_hour",
  windowMinutes: 300,
  observedAt,
  reading: { _tag: "Known", usedPercent, resetsAt: now + hour }
})

const storeWith = (groups: ReadonlyArray<UsageGroup>, snapshots: ReadonlyArray<LimitSnapshot>) => {
  const asked: Array<MachineRange> = []
  const store = UsageStore.of({
    cursor: () => Effect.die("unused"),
    commitChunk: () => Effect.die("unused"),
    recordObservations: () => Effect.die("unused"),
    usageGroups: (range) =>
      Effect.sync(() => {
        asked.push(range)
        return groups
      }),
    sessionGroups: () => Effect.die("sessions must not be read"),
    places: () => Effect.die("places must not be read"),
    limitSnapshots: () => Effect.succeed(snapshots),
    latestBalances: () => Effect.die("balances must not be read"),
    tickets: () => Effect.die("ticket titles must not be read"),
    saveTicket: () => Effect.die("unused")
  })
  return { asked, store }
}

const encode = Schema.encodeSync(Schema.fromJsonString(UsageNow))

describe("readUsageNow", () => {
  it.effect("answers tokens per period, agent and model over the last 24 hours, stamped with now", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now)
      const { asked, store } = storeWith(
        [
          group(now - 2 * hour, "claude", "claude-opus-5"),
          group(now - 2 * hour, "claude", "claude-opus-5"),
          group(now - 2 * hour, "codex", "gpt-6"),
          group(now - hour, "claude", "claude-sonnet-5")
        ],
        [snapshot(now - 3 * hour, 12), snapshot(now - hour, 40)]
      )
      const usage = yield* readUsageNow(store, "host-a", "24h", "UTC")
      expect(asked).toEqual([{ from: now - 24 * hour, to: now, machine: "host-a" }])
      expect(usage).toMatchObject({
        v: 1,
        machine: "host-a",
        observedAt: now,
        range: { preset: "24h", timeZone: "UTC", from: now - 24 * hour, to: now, bucket: "hour" }
      })
      expect(usage.periods).toHaveLength(24)
      const total = 1_120
      expect(usage.tokens).toEqual([
        { period: 22, agent: "claude", model: "claude-opus-5", tokens: 2 * total },
        { period: 22, agent: "codex", model: "gpt-6", tokens: total },
        { period: 23, agent: "claude", model: "claude-sonnet-5", tokens: total }
      ])
      expect(usage.limits.map((series) => series.points.map((point) => point.reading))).toEqual([[
        { _tag: "Known", usedPercent: 12, resetsAt: now + hour },
        { _tag: "Known", usedPercent: 40, resetsAt: now + hour }
      ]])
    }))

  // The hub's boundary: tokens per agent and model cross the tailnet; nothing that books,
  // prices or locates a request does. The store fails if anything else is read at all.
  it.effect("encodes no cost, Booking, ticket, repo, path or balance", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now)
      const { store } = storeWith([group(now - hour, "claude", "claude-opus-5")], [snapshot(now - hour, 40)])
      const json = encode(yield* readUsageNow(store, "host-a", "7d", "Europe/Amsterdam"))
      for (
        const leak of ["cost", "Usd", "booking", "RPS-1234", "secret-repo", "/home/", "feature/", "balance", "requests"]
      ) {
        expect(json).not.toContain(leak)
      }
    }))

  it.effect("refuses a time zone it does not know", () =>
    Effect.gen(function*() {
      const { store } = storeWith([], [])
      const failure = yield* Effect.flip(readUsageNow(store, "host-a", "7d", "Mars/Olympus"))
      expect(failure._tag).toBe("UnknownTimeZone")
    }))
})

describe("thinPoints", () => {
  type Point = LimitSeries["points"][number]
  const point = (at: number, usedPercent: number): Point => ({
    at,
    reading: { _tag: "Known", usedPercent, resetsAt: null }
  })

  it("keeps a series that fits as it is", () => {
    const points = [point(0, 1), point(10, 2)]
    expect(thinPoints(points, { from: 0, to: 100 }, 4)).toBe(points)
  })

  it("keeps the highest reading of each slice, so a peak survives", () => {
    const points = [point(0, 5), point(10, 90), point(20, 7), point(60, 3), point(70, 1)]
    expect(thinPoints(points, { from: 0, to: 100 }, 2)).toEqual([point(10, 90), point(60, 3)])
  })

  it("prefers a Known reading to an Unknown one in the same slice", () => {
    const unknown: Point = { at: 0, reading: { _tag: "Unknown", reason: "Fetch" } }
    expect(thinPoints([unknown, point(5, 2), point(60, 1)], { from: 0, to: 100 }, 2)).toEqual([
      point(5, 2),
      point(60, 1)
    ])
  })

  it("bounds a month of five-minute polls", () => {
    const month = Array.from({ length: 30 * 288 }, (_, index) => point(index * 300_000, index % 100))
    expect(thinPoints(month, { from: 0, to: 30 * 86_400_000 }).length).toBeLessThanOrEqual(MAX_LIMIT_POINTS)
  })
})

// With the hub asking peers on several versions, a refusal must name what the peer did not know.
describe("describeUsageFailure", () => {
  it("names the range, the zone or the malformed request it refused", () => {
    const refused = (refused: "range" | "time zone" | "malformed") =>
      describeUsageFailure(new UsageRequestRefused({ refused, preset: "90d", timeZone: "Mars/Olympus" }))
    expect(refused("range")).toContain("does not offer the range \"90d\"")
    expect(refused("time zone")).toContain("does not know the time zone \"Mars/Olympus\"")
    expect(refused("malformed")).toContain("malformed")
  })
})
