import { describe, expect, it } from "@effect/vitest"
import { rangeOf } from "../src/client/range.js"
import { formatPeriod } from "../src/limits/format.js"
import { summarizeLimits } from "../src/limits/model.js"
import { buildWeek, NOW, TIME_ZONE } from "../stories/fixtures/week.js"

describe("current-screen fixtures", () => {
  it("uses the shipped seven-day preset, including today's future remainder", () => {
    const week = buildWeek("binding")
    expect(week.range).toEqual(rangeOf("7d", NOW, TIME_ZONE))
    expect(week.usage.periods).toHaveLength(7)
    expect(week.range.to).toBeGreaterThan(NOW)
  })

  it("keeps aggregation and chart labels in the viewer's zone", () => {
    expect(TIME_ZONE).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    for (const period of buildWeek("binding").usage.periods) {
      expect(new Date(period.start).getHours()).toBe(0)
      expect(formatPeriod(period.start, "day")).toBe(
        new Intl.DateTimeFormat(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          timeZone: TIME_ZONE
        }).format(period.start)
      )
    }
  })

  it("makes the binding window 86% used with 72 minutes until reset", () => {
    const week = buildWeek("binding")
    const window = summarizeLimits(week.limits.latest, NOW)
      .find((group) => group.agent === "claude")
      ?.windows.find((window) => window.name === "5-hour")
    expect(window).toMatchObject({ usedPercent: 86, resetsAt: NOW + 72 * 60_000, reset: "resets in 1h 12m" })
  })
})
