import { describe, expect, it } from "@effect/vitest"
import { limitTrackTone, type RlyLimitTrackTone } from "@knpkv/rly/primitives"
import type { LimitSnapshot } from "../src/core/Model.js"
import {
  describeProjection,
  limitRows,
  limitSegments,
  type LimitTone,
  limitTone,
  NEAR_PERCENT,
  relativeReset,
  summarizeLimits,
  windowName
} from "../src/limits/model.js"
import type { LimitSeries } from "../src/shared/contracts.js"
import { PLOT, timeTicks } from "../src/usage/axis.js"

const HOUR = 3_600_000
const now = Date.parse("2026-10-04T12:00:00Z")

const snapshot = (overrides: Partial<LimitSnapshot>): LimitSnapshot => ({
  agent: "claude",
  machine: "host-a",
  source: "claude-oauth-usage",
  label: "five_hour",
  windowMinutes: 300,
  observedAt: now - 60_000,
  reading: { _tag: "Known", usedPercent: 40, resetsAt: now + 2 * HOUR },
  ...overrides
})

describe("limitTone", () => {
  it("names how close a window is, never by colour alone", () => {
    expect(limitTone({ _tag: "Known", usedPercent: 40, resetsAt: null })).toBe("ok")
    expect(limitTone({ _tag: "Known", usedPercent: 80, resetsAt: null })).toBe("near")
    expect(limitTone({ _tag: "Known", usedPercent: 100, resetsAt: null })).toBe("at-limit")
    expect(limitTone({ _tag: "Unknown", reason: "Fetch" })).toBe("unknown")
  })

  it("agrees with the tone Rly's LimitTrack draws at the same near mark", () => {
    const track = { ok: "ok", near: "near", "at-limit": "full", unknown: "unknown" } satisfies Record<
      LimitTone,
      RlyLimitTrackTone
    >
    for (const usedPercent of [0, 79.9, 80, 99.9, 100, 140]) {
      expect(track[limitTone({ _tag: "Known", usedPercent, resetsAt: null })]).toBe(
        limitTrackTone(usedPercent, NEAR_PERCENT)
      )
    }
    expect(track[limitTone({ _tag: "Unknown", reason: "Fetch" })]).toBe(limitTrackTone(null, NEAR_PERCENT))
  })
})

describe("relativeReset", () => {
  it("says how long until a window resets", () => {
    expect(relativeReset(now + 4 * HOUR + 12 * 60_000, now)).toBe("resets in 4h 12m")
    expect(relativeReset(now + 50 * HOUR, now)).toBe("resets in 2d 2h")
    expect(relativeReset(now + 30 * 60_000, now)).toBe("resets in 30m")
    expect(relativeReset(now - 1, now)).toBe("reset")
  })
})

describe("summarizeLimits", () => {
  it("groups windows by agent, named ones first and the at-limit one leading its group", () => {
    const summary = summarizeLimits(
      [
        snapshot({ label: "five_hour", reading: { _tag: "Known", usedPercent: 5, resetsAt: now + HOUR } }),
        snapshot({ label: "seven_day", windowMinutes: 10_080 }),
        snapshot({ label: "iguana_necktie", windowMinutes: null }),
        snapshot({
          agent: "codex",
          source: "codex-rollout",
          label: "primary",
          windowMinutes: 10_080,
          observedAt: now - 14 * HOUR,
          reading: { _tag: "Known", usedPercent: 100, resetsAt: now + 40 * HOUR }
        })
      ],
      now
    )
    expect(summary.map((group) => group.agent)).toEqual(["codex", "claude"])
    const claude = summary.find((group) => group.agent === "claude")
    expect(claude?.windows.map((window) => window.name)).toEqual(["Weekly", "5-hour"])
    expect(claude?.unnamed.map((window) => window.name)).toEqual(["Unnamed allowance (iguana_necktie)"])
    const codex = summary.find((group) => group.agent === "codex")
    expect(codex?.windows[0]).toMatchObject({
      name: "Weekly",
      tone: "at-limit",
      usedPercent: 100,
      freshness: "stale",
      reset: "resets in 1d 16h"
    })
  })

  it("leaves out windows that reset since they were read, and says why a failed poll left nothing", () => {
    const summary = summarizeLimits(
      [
        snapshot({ observedAt: now - 2 * HOUR, reading: { _tag: "Known", usedPercent: 60, resetsAt: now - HOUR } }),
        snapshot({ label: "*", windowMinutes: null, reading: { _tag: "Unknown", reason: "AuthExpired" } })
      ],
      now
    )
    expect(summary).toEqual([{
      agent: "claude",
      windows: [],
      unnamed: [],
      problem: { reason: "sign-in expired", observedAt: now - 60_000 }
    }])
  })
})

describe("Spend and failed polls", () => {
  it("keeps showing the Spend window after a failed poll, which never reads it", () => {
    const summary = summarizeLimits(
      [
        snapshot({
          source: "claude-statusline",
          label: "spend",
          windowMinutes: null,
          observedAt: now - 2 * HOUR,
          reading: { _tag: "Known", usedPercent: 12, resetsAt: null }
        }),
        snapshot({ label: "*", windowMinutes: null, reading: { _tag: "Unknown", reason: "NoAuth" } })
      ],
      now
    )
    expect(summary[0]?.windows.map((window) => window.name)).toEqual(["Spend"])
  })

  it("still says the poll failed after a newer Spend sample, which cannot vouch for the other windows", () => {
    const summary = summarizeLimits(
      [
        snapshot({ observedAt: now - 3 * HOUR }),
        snapshot({
          label: "*",
          windowMinutes: null,
          observedAt: now - 2 * HOUR,
          reading: { _tag: "Unknown", reason: "NoAuth" }
        }),
        snapshot({
          source: "claude-statusline",
          label: "spend",
          windowMinutes: null,
          observedAt: now - HOUR,
          reading: { _tag: "Known", usedPercent: 12, resetsAt: null }
        })
      ],
      now
    )
    expect(summary[0]?.problem?.reason).toBe("not signed in")
    expect(summary[0]?.windows.map((window) => window.name)).toEqual(["Spend"])
  })
})

describe("limitSegments", () => {
  it("draws levels, a reset nobody read since, and a reading that failed as three kinds", () => {
    const segments = limitSegments(
      [
        { at: 0, reading: { _tag: "Known", usedPercent: 10, resetsAt: 100 } },
        { at: 150, reading: { _tag: "Unknown", reason: "Fetch", detail: "HTTP 503" } },
        { at: 200, reading: { _tag: "Known", usedPercent: 30, resetsAt: null } }
      ],
      300
    )
    expect(segments).toEqual([
      { kind: "level", from: 0, to: 100, usedPercent: 10 },
      { kind: "reset", from: 100, to: 150 },
      { kind: "unknown", from: 150, to: 200, reason: "Fetch", detail: "HTTP 503" },
      { kind: "level", from: 200, to: 300, usedPercent: 30 }
    ])
  })
})

describe("limitRows", () => {
  it("gives every named window a row, carrying its agent's failed polls, and leaves unnamed ones to the table", () => {
    const rows = limitRows([
      {
        agent: "claude",
        label: "five_hour",
        windowMinutes: 300,
        points: [{ at: 10, reading: { _tag: "Known", usedPercent: 5, resetsAt: null } }]
      },
      {
        agent: "claude",
        label: "*",
        windowMinutes: null,
        points: [{ at: 20, reading: { _tag: "Unknown", reason: "Fetch" } }]
      },
      { agent: "claude", label: "iguana_necktie", windowMinutes: null, points: [] },
      { agent: "codex", label: "secondary", windowMinutes: 10_080, points: [] }
    ])
    expect(rows.map((row) => row.name)).toEqual(["Claude 5-hour", "Codex Weekly"])
    expect(rows[0]?.points.map((point) => point.at)).toEqual([10, 20])
  })
})

describe("timeTicks", () => {
  it("picks the finest step whose labels do not touch, on local hour boundaries", () => {
    const range = { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 8) }
    const spacing = (width: number) => {
      const ticks = timeTicks(range, width, 64)
      for (const tick of ticks) expect(new Date(tick.at).getMinutes()).toBe(0)
      const gap = (ticks.at(1)?.at ?? range.to) - (ticks.at(0)?.at ?? range.from)
      return { count: ticks.length, pixels: (gap / (range.to - range.from)) * (width - PLOT.left - PLOT.right) }
    }
    const wide = spacing(1200)
    const narrow = spacing(390)
    expect(narrow.count).toBeLessThan(wide.count)
    expect(wide.pixels).toBeGreaterThanOrEqual(64)
    expect(narrow.pixels).toBeGreaterThanOrEqual(64)
  })
})

describe("timeTicks on day ranges", () => {
  it("labels whole days only, never times of day", () => {
    const range = { from: Date.UTC(2026, 8, 28), to: Date.UTC(2026, 9, 5) }
    const ticks = timeTicks(range, 1440, 64, 24)
    expect(ticks.length).toBeGreaterThan(0)
    for (const tick of ticks) {
      expect(new Date(tick.at).getHours()).toBe(0)
      expect(tick.label).not.toMatch(/:/)
    }
  })
})

describe("limitRows first reading", () => {
  it("says when a window was first read, so an empty start is not mistaken for zero", () => {
    const rows = limitRows([
      {
        agent: "claude",
        label: "five_hour",
        windowMinutes: 300,
        points: [{ at: 500, reading: { _tag: "Known", usedPercent: 5, resetsAt: null } }]
      }
    ])
    expect(rows[0]?.firstAt).toBe(500)
  })
})

describe("window identity", () => {
  it("keeps Codex windows without a length apart by their provider label", () => {
    const summary = summarizeLimits(
      [
        snapshot({ agent: "codex", source: "codex-rollout", label: "primary", windowMinutes: null }),
        snapshot({ agent: "codex", source: "codex-rollout", label: "secondary", windowMinutes: null }),
        snapshot({
          agent: "codex",
          source: "codex-rollout",
          label: "primary",
          windowMinutes: 300,
          observedAt: now - 2 * 60_000
        }),
        snapshot({ agent: "codex", source: "codex-rollout", label: "secondary", windowMinutes: 10_080 })
      ],
      now
    )
    const ids = summary.flatMap((group) => [...group.windows, ...group.unnamed]).map((window) => window.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("windowName", () => {
  it("names a window by its exact length, never rounding minutes into hours", () => {
    const codex = (windowMinutes: number) => windowName({ agent: "codex", label: "primary", windowMinutes })
    expect(codex(300)).toBe("5-hour")
    expect(codex(10_080)).toBe("Weekly")
    expect(codex(120)).toBe("2-hour")
    expect(codex(90)).toBe("90-minute")
    expect(codex(30)).toBe("30-minute")
    expect(windowName({ agent: "claude", label: "spend", windowMinutes: null })).toBe("Spend")
  })
})

describe("summarizeLimits with the series behind the latest readings", () => {
  const series = (usedPercent: number): ReadonlyArray<LimitSeries> => [{
    agent: "claude",
    label: "five_hour",
    windowMinutes: 300,
    points: [{ at: now - HOUR, reading: { _tag: "Known", usedPercent, resetsAt: now + 2 * HOUR } }]
  }]
  const latest = (usedPercent: number) =>
    snapshot({ observedAt: now - 60_000, reading: { _tag: "Known", usedPercent, resetsAt: now + 2 * HOUR } })

  it("raises a window that runs out before its reset to near, under 80%", () => {
    const window = summarizeLimits([latest(40)], now, series(10))[0]?.windows[0]
    expect(window?.tone).toBe("near")
    expect(window?.projection).toMatchObject({ _tag: "RunsOut" })
  })

  it("keeps the tone of a window that lasts until its reset", () => {
    const window = summarizeLimits([latest(40)], now, series(35))[0]?.windows[0]
    expect(window?.tone).toBe("ok")
    expect(window?.projection).toMatchObject({ _tag: "LastsUntilReset" })
  })

  it("projects from the latest reading when the series stopped at an unchanged one", () => {
    const window = summarizeLimits([latest(40)], now, series(40))[0]?.windows[0]
    expect(window?.projection).toEqual({ _tag: "LastsUntilReset", burnPerHour: 0, atReset: 40 })
  })

  it("has no projection without the series", () => {
    expect(summarizeLimits([latest(40)], now)[0]?.windows[0]?.projection).toBeNull()
  })
})

describe("describeProjection", () => {
  it("says when a window runs out: a time today, a weekday and time on another day", () => {
    expect(describeProjection({ _tag: "RunsOut", at: now + HOUR, burnPerHour: 20 }, now)).toMatchObject({
      text: expect.stringMatching(/^at this pace: out at \d{2}:\d{2}$/),
      tone: "secondary",
      title: "Projected from the burn over the last hour"
    })
    expect(describeProjection({ _tag: "RunsOut", at: now + 3 * 24 * HOUR, burnPerHour: 1 }, now)?.text).toMatch(
      /^at this pace: out \p{L}+\.? \d{2}:\d{2}$/u
    )
  })

  it("is quiet when the window lasts, and never a time or zero when the pace is unknown", () => {
    expect(describeProjection({ _tag: "LastsUntilReset", burnPerHour: 0, atReset: 40 }, now)).toEqual({
      text: "lasts until reset",
      tone: "tertiary",
      title: null
    })
    expect(describeProjection({ _tag: "Unknown", reason: "Stale" }, now)?.text).toBe("pace unknown · old reading")
    expect(describeProjection({ _tag: "Unknown", reason: "TooFewSamples" }, now)?.text).toBe(
      "pace unknown · too few readings"
    )
    expect(describeProjection({ _tag: "Unknown", reason: "Malformed" }, now)?.text).toBe("pace unknown")
  })

  it("says nothing at the limit, without a reset, or without a reading", () => {
    expect(describeProjection({ _tag: "OutNow" }, now)).toBeNull()
    expect(describeProjection({ _tag: "Unknown", reason: "NoReset" }, now)).toBeNull()
    expect(describeProjection({ _tag: "Unknown", reason: "NoReading" }, now)).toBeNull()
    expect(describeProjection(null, now)).toBeNull()
  })
})

describe("a stale reading's projection", () => {
  it("is pace unknown once the row reads stale, even where the weekly pace would still hold", () => {
    const weekly = snapshot({
      label: "seven_day",
      windowMinutes: 10_080,
      observedAt: now - 30 * 60_000,
      reading: { _tag: "Known", usedPercent: 40, resetsAt: now + 50 * HOUR }
    })
    const series: ReadonlyArray<LimitSeries> = [{
      agent: "claude",
      label: "seven_day",
      windowMinutes: 10_080,
      points: [{ at: now - 2 * HOUR, reading: { _tag: "Known", usedPercent: 10, resetsAt: now + 50 * HOUR } }]
    }]
    const window = summarizeLimits([weekly], now, series)[0]?.windows[0]
    expect(window?.freshness).toBe("stale")
    expect(window?.projection).toEqual({ _tag: "Unknown", reason: "Stale" })
    expect(window?.tone).toBe("ok")
  })
})
