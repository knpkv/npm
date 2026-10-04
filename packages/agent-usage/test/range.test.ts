import { describe, expect, it } from "@effect/vitest"
import { rangeOf } from "../src/client/range.js"
import { periodsOf } from "../src/core/Report.js"

describe("rangeOf", () => {
  const now = Date.parse("2026-10-03T15:20:00+02:00")

  it("covers the last 24 hours in hours, up to now", () => {
    expect(rangeOf("24h", now, "Europe/Berlin")).toEqual({ from: now - 86_400_000, to: now, bucket: "hour" })
  })

  it("covers whole local days, today included, in days", () => {
    expect(rangeOf("7d", now, "Europe/Berlin")).toEqual({
      from: Date.parse("2026-09-27T00:00:00+02:00"),
      to: Date.parse("2026-10-04T00:00:00+02:00"),
      bucket: "day"
    })
  })

  it("counts days in the viewer's zone across a daylight-saving change", () => {
    const winter = Date.parse("2026-10-27T12:00:00+01:00")
    expect(rangeOf("7d", winter, "Europe/Berlin").from).toBe(Date.parse("2026-10-21T00:00:00+02:00"))
  })

  it("starts a day whose midnight does not exist at its first real instant", () => {
    // Chile moves clocks from 00:00 to 01:00 on 6 September 2026.
    const range = rangeOf("7d", Date.parse("2026-09-12T12:00:00Z"), "America/Santiago")
    expect(range.from).toBe(Date.parse("2026-09-06T04:00:00Z"))
    expect(periodsOf({ ...range, timeZone: "America/Santiago", bucket: "day" })).toHaveLength(7)
  })
})
