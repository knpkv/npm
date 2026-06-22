import { describe, expect, it } from "@effect/vitest"
import { formatElapsed, isFullIsoTimestamp, parseDuration, parseStartTime } from "../src/utils/time.js"

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
