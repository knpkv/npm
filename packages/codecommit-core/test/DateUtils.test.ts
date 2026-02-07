import { describe, expect, it } from "@effect/vitest"
import * as DateUtils from "../src/DateUtils.js"

describe("DateUtils", () => {
  describe("formatDate", () => {
    // Verifies DD.MM.YYYY format with zero-padded day/month
    it("formats date as DD.MM.YYYY", () => {
      expect(DateUtils.formatDate(new Date(2024, 0, 5))).toBe("05.01.2024")
    })

    // Ensures double-digit day/month are not double-padded
    it("handles double-digit day and month", () => {
      expect(DateUtils.formatDate(new Date(2024, 11, 25))).toBe("25.12.2024")
    })
  })

  describe("formatRelativeTime", () => {
    const now = new Date("2024-06-15T12:00:00Z")

    // Seconds bucket: <60s shows seconds
    it("shows seconds for <60s", () => {
      const date = new Date(now.getTime() - 30_000)
      expect(DateUtils.formatRelativeTime(date, now)).toBe("Updated 30s ago")
    })

    // Minutes bucket: 60s–3600s shows minutes
    it("shows minutes for <1h", () => {
      const date = new Date(now.getTime() - 5 * 60_000)
      expect(DateUtils.formatRelativeTime(date, now)).toBe("Updated 5m ago")
    })

    // Hours bucket: 3600s–86400s shows hours
    it("shows hours for <24h", () => {
      const date = new Date(now.getTime() - 3 * 3_600_000)
      expect(DateUtils.formatRelativeTime(date, now)).toBe("Updated 3h ago")
    })

    // Fallback: >=24h shows absolute date
    it("shows absolute date for >=24h", () => {
      const date = new Date("2024-06-13T12:00:00Z")
      expect(DateUtils.formatRelativeTime(date, now)).toBe("Updated on 13.06.2024")
    })

    // Edge: future dates should clamp to 0s
    it("clamps future dates to 0s", () => {
      const future = new Date(now.getTime() + 10_000)
      expect(DateUtils.formatRelativeTime(future, now)).toBe("Updated 0s ago")
    })
  })
})
