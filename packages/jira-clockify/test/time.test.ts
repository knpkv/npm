import { describe, expect, it } from "@effect/vitest"
import {
  formatClock,
  formatElapsed,
  isFullIsoTimestamp,
  isoWeekPeriod,
  localDay,
  parseDuration,
  parseStartTime,
  resolveCorrectedEnd,
  startOfIsoWeek
} from "../src/utils/time.js"

describe("parseDuration", () => {
  it("parses combined hours and minutes", () => {
    expect(parseDuration("1h30m")).toBe(5400)
  })

  it("parses hours only", () => {
    expect(parseDuration("2h")).toBe(7200)
  })

  it("parses minutes only, including >59", () => {
    expect(parseDuration("45m")).toBe(2700)
    expect(parseDuration("90m")).toBe(5400)
  })

  it("trims surrounding whitespace", () => {
    expect(parseDuration("  15m ")).toBe(900)
  })

  it("rejects empty or malformed input", () => {
    expect(parseDuration("")).toBeNull()
    expect(parseDuration("abc")).toBeNull()
    expect(parseDuration("1h30")).toBeNull()
    expect(parseDuration("30s")).toBeNull()
  })
})

describe("parseStartTime", () => {
  const now = new Date("2025-06-19T15:00:00.000Z")

  it("interprets HH:MM as that local time today", () => {
    const result = parseStartTime("09:30", now)
    expect(result).not.toBeNull()
    expect(result!.getHours()).toBe(9)
    expect(result!.getMinutes()).toBe(30)
    expect(result!.getSeconds()).toBe(0)
    // Same calendar day as `now`
    expect(result!.getDate()).toBe(now.getDate())
  })

  it("parses a full ISO timestamp", () => {
    const result = parseStartTime("2025-01-01T10:00:00.000Z", now)
    expect(result?.toISOString()).toBe("2025-01-01T10:00:00.000Z")
  })

  it("parses an ISO timestamp without seconds or zone", () => {
    const result = parseStartTime("2025-01-01T10:00", now)
    expect(result).not.toBeNull()
  })

  it("returns a future instant for an HH:MM later today (caller must guard)", () => {
    // now is 15:00 — 18:00 today is still in the future; the parser itself does
    // not reject it (the future-guard lives at the command/service layer).
    const result = parseStartTime("18:00", now)
    expect(result).not.toBeNull()
    expect(result!.getTime()).toBeGreaterThan(now.getTime())
  })

  it("rejects out-of-range clock times", () => {
    expect(parseStartTime("24:00", now)).toBeNull()
    expect(parseStartTime("10:60", now)).toBeNull()
  })

  it("rejects date-only and loose Date-parseable strings", () => {
    // These are accepted by `new Date()` but must not become a surprising instant.
    expect(parseStartTime("2024", now)).toBeNull()
    expect(parseStartTime("Jan 5", now)).toBeNull()
    expect(parseStartTime("2025-01-01", now)).toBeNull()
  })

  it("rejects unparseable input", () => {
    expect(parseStartTime("not-a-time", now)).toBeNull()
  })
})

describe("isFullIsoTimestamp", () => {
  it("recognises full ISO timestamps", () => {
    expect(isFullIsoTimestamp("2025-01-01T10:00:00.000Z")).toBe(true)
    expect(isFullIsoTimestamp("2025-01-01T10:00")).toBe(true)
    expect(isFullIsoTimestamp(" 2025-06-01T09:00+02:00 ")).toBe(true)
  })

  it("rejects HH:MM and date-only strings", () => {
    expect(isFullIsoTimestamp("09:30")).toBe(false)
    expect(isFullIsoTimestamp("2025-01-01")).toBe(false)
    expect(isFullIsoTimestamp("2024")).toBe(false)
  })
})

describe("formatElapsed", () => {
  it("formats positive seconds as HH:MM:SS", () => {
    expect(formatElapsed(3661)).toBe("01:01:01")
  })

  it("clamps negative input to zero", () => {
    expect(formatElapsed(-5)).toBe("00:00:00")
  })
})

describe("formatClock", () => {
  it("formats local hours and minutes zero-padded", () => {
    // Constructed from local components so the assertion is timezone-independent.
    expect(formatClock(new Date(2025, 5, 19, 9, 5))).toBe("09:05")
    expect(formatClock(new Date(2025, 5, 19, 17, 30))).toBe("17:30")
  })
})

describe("resolveCorrectedEnd", () => {
  // Local-component dates keep these assertions independent of the runner's timezone.
  const start = new Date(2025, 5, 19, 10, 0) // today 10:00 local
  const now = new Date(2025, 5, 19, 15, 0) // today 15:00 local

  it("accepts an HH:MM earlier today within bounds", () => {
    const result = resolveCorrectedEnd({ start, input: "12:00", now })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.end.getHours()).toBe(12)
      expect(result.end.getDate()).toBe(now.getDate())
    }
  })

  it("rolls a future HH:MM back to yesterday (forgot overnight)", () => {
    // Started yesterday 17:00, noticed today 09:30 — the real end was yesterday 18:00.
    const overnightStart = new Date(2025, 5, 18, 17, 0)
    const overnightNow = new Date(2025, 5, 19, 9, 30)
    const result = resolveCorrectedEnd({ start: overnightStart, input: "18:00", now: overnightNow })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.end.getHours()).toBe(18)
      expect(result.end.getDate()).toBe(18) // yesterday
    }
  })

  it("rejects when the yesterday-rollback lands before the start", () => {
    const overnightStart = new Date(2025, 5, 18, 17, 0)
    const overnightNow = new Date(2025, 5, 19, 9, 30)
    // "10:00" → today 10:00 is future → yesterday 10:00, which is before the 17:00 start.
    const result = resolveCorrectedEnd({ start: overnightStart, input: "10:00", now: overnightNow })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("before the start")
      // The rolled-back day is surfaced so "10:00 before 17:00" doesn't read as nonsense.
      expect(result.error).toContain("on 2025-06-18")
    }
  })

  it("rejects an end at or before the start", () => {
    const result = resolveCorrectedEnd({ start, input: "09:00", now })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("before the start")
  })

  it("rejects a future ISO end", () => {
    const result = resolveCorrectedEnd({ start, input: "2025-06-19T16:00", now })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("future")
  })

  it("accepts a full ISO timestamp on an earlier day (more than a day ago)", () => {
    const oldStart = new Date(2025, 5, 17, 10, 0)
    const result = resolveCorrectedEnd({ start: oldStart, input: "2025-06-18T12:00", now })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.end.getDate()).toBe(18)
      expect(result.end.getHours()).toBe(12)
    }
  })

  it("rejects empty and unparseable input", () => {
    expect(resolveCorrectedEnd({ start, input: "", now }).ok).toBe(false)
    expect(resolveCorrectedEnd({ start, input: "   ", now }).ok).toBe(false)
    expect(resolveCorrectedEnd({ start, input: "later", now }).ok).toBe(false)
    expect(resolveCorrectedEnd({ start, input: "25:00", now }).ok).toBe(false)
  })
})

describe("startOfIsoWeek", () => {
  // Constructed from local components, so these hold in any timezone.
  const monday = new Date(2025, 5, 16, 14, 30)
  const sunday = new Date(2025, 5, 22, 23, 59)

  it("returns the day itself for a Monday, at local midnight", () => {
    const start = startOfIsoWeek(monday)
    expect(localDay(start)).toBe(localDay(monday))
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(start.getSeconds()).toBe(0)
    expect(start.getMilliseconds()).toBe(0)
  })

  it("reaches back to Monday from a Sunday, not forward", () => {
    // Sunday is the last day of its ISO week, which a Sunday-first weekday index gets wrong by six.
    expect(localDay(startOfIsoWeek(sunday))).toBe(localDay(monday))
  })

  it("puts every day of one week on the same Monday", () => {
    const mondays = [...new Array(7).keys()].map((offset) =>
      localDay(startOfIsoWeek(new Date(2025, 5, 16 + offset, 9, 0)))
    )
    expect(new Set(mondays).size).toBe(1)
  })
})

describe("isoWeekPeriod", () => {
  it("spans Monday to the following Monday, half-open", () => {
    const period = isoWeekPeriod(new Date(2025, 5, 18, 11, 0))
    expect(localDay(period.from)).toBe("2025-06-16")
    expect(localDay(period.to)).toBe("2025-06-23")
    expect(period.to.getHours()).toBe(0)
  })

  it("lands on a local midnight across a daylight-saving change", () => {
    // Both European and American transitions, so whichever the test host observes is covered. A
    // week containing one is 167 or 169 hours long, which is what clock arithmetic gets wrong.
    for (const date of [new Date(2025, 2, 27, 12, 0), new Date(2025, 9, 29, 12, 0)]) {
      const period = isoWeekPeriod(date)
      expect(period.from.getHours()).toBe(0)
      expect(period.to.getHours()).toBe(0)
      expect(period.from.getDay()).toBe(1)
      expect(period.to.getDay()).toBe(1)
    }
  })
})
