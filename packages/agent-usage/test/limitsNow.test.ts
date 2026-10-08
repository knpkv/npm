import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import type { LimitSnapshot } from "../src/core/Model.js"
import { type MachineRange, UsageStore } from "../src/core/Store.js"
import { LIMITS_NOW_LOOKBACK_MILLIS, readLimitsNow } from "../src/server/LimitsNow.js"

const now = Date.parse("2026-10-08T12:00:00Z")
const snapshot = (label: string, observedAt: number, usedPercent: number): LimitSnapshot => ({
  agent: "claude",
  machine: "host-a",
  source: "claude-oauth-usage",
  label,
  windowMinutes: label === "five_hour" ? 300 : 10_080,
  observedAt,
  reading: { _tag: "Known", usedPercent, resetsAt: now + 3_600_000 }
})

describe("readLimitsNow", () => {
  it.effect("answers the newest snapshot of each window and this Machine's balances, stamped with now", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(now)
      const asked: Array<MachineRange> = []
      const store = UsageStore.of({
        cursor: () => Effect.die("unused"),
        commitChunk: () => Effect.die("unused"),
        recordObservations: () => Effect.die("unused"),
        usageGroups: () => Effect.die("unused"),
        sessionGroups: () => Effect.die("unused"),
        places: () => Effect.die("unused"),
        limitSnapshots: (range) =>
          Effect.sync(() => {
            asked.push(range)
            return [
              snapshot("five_hour", now - 20 * 60_000, 10),
              snapshot("five_hour", now - 5 * 60_000, 19),
              snapshot("seven_day", now - 30 * 60_000, 47)
            ]
          }),
        latestBalances: () => Effect.succeed([]),
        tickets: () => Effect.die("unused"),
        saveTicket: () => Effect.die("unused")
      })
      const limits = yield* readLimitsNow(store, "host-a")
      expect(asked).toEqual([{ from: now - LIMITS_NOW_LOOKBACK_MILLIS, to: now + 1, machine: "host-a" }])
      expect(limits.machine).toBe("host-a")
      expect(limits.observedAt).toBe(now)
      expect(limits.latest.map((latest) => [latest.label, latest.reading])).toEqual([
        ["five_hour", { _tag: "Known", usedPercent: 19, resetsAt: now + 3_600_000 }],
        ["seven_day", { _tag: "Known", usedPercent: 47, resetsAt: now + 3_600_000 }]
      ])
    }))
})
