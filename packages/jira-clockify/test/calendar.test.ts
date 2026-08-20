import { describe, expect, it } from "@effect/vitest"
import { formatSpanRanges, renderDayCalendar } from "../src/cli/calendar.js"

// Local components, so the grid is drawn against a local midnight wherever this suite runs.
const at = (year: number, month: number, day: number, hour: number, minute: number): number =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime()

const span = (fromHour: number, fromMinute: number, toHour: number, toMinute: number) => ({
  startMs: at(2026, 7, 1, fromHour, fromMinute),
  endMs: at(2026, 7, 1, toHour, toMinute)
})

const gridLines = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => /^ {2}\d{2}h/.test(line))

describe("renderDayCalendar", () => {
  it("draws nothing for a day with no credited time", () => {
    expect(renderDayCalendar({ day: "2026-07-01", rows: [] })).toEqual([])
    expect(renderDayCalendar({ day: "2026-07-01", rows: [{ ticketKey: "PROJ-1", spans: [] }] })).toEqual([])
  })

  it("fills exactly the credited minutes of an hour", () => {
    const lines = renderDayCalendar({
      day: "2026-07-01",
      rows: [{ ticketKey: "PROJ-1", spans: [span(9, 15, 9, 45)] }]
    })
    const hour = gridLines(lines)[0]!
    const cells = hour.slice(8)
    expect(cells).toHaveLength(60)
    expect(cells.slice(0, 15)).toBe(".".repeat(15))
    expect(cells.slice(15, 45)).toBe("#".repeat(30))
    expect(cells.slice(45)).toBe(".".repeat(15))
  })

  // A day is mostly empty; drawing all 24 hours would bury the three that matter.
  it("draws only hours with credited time", () => {
    const lines = renderDayCalendar({
      day: "2026-07-01",
      rows: [{ ticketKey: "PROJ-1", spans: [span(9, 0, 9, 30), span(14, 0, 14, 30)] }]
    })
    const hours = gridLines(lines).map((line) => line.trim().slice(0, 3))
    expect(hours).toEqual(["09h", "14h"])
  })

  // The skipped stretch has to stay visible, or an 8-hour gap silently closes up and the picture
  // implies continuous work.
  it("marks a skipped stretch with its length", () => {
    const lines = renderDayCalendar({
      day: "2026-07-01",
      rows: [{ ticketKey: "PROJ-1", spans: [span(2, 0, 2, 30), span(11, 0, 11, 10)] }]
    })
    expect(lines.join("\n")).toContain("8h with nothing credited")
  })

  it("gives each Issue Key its own glyph and lists them in the legend", () => {
    const lines = renderDayCalendar({
      day: "2026-07-01",
      rows: [
        { ticketKey: "PROJ-1", spans: [span(9, 0, 9, 20)] },
        { ticketKey: "PROJ-2", spans: [span(9, 30, 9, 50)] }
      ]
    })
    expect(lines[0]).toContain("# PROJ-1")
    expect(lines[0]).toContain("= PROJ-2")
    const cells = gridLines(lines)[0]!.slice(8)
    expect(cells.slice(0, 20)).toBe("#".repeat(20))
    expect(cells.slice(30, 50)).toBe("=".repeat(20))
  })

  it("rounds a sub-minute span up to one visible minute", () => {
    const lines = renderDayCalendar({
      day: "2026-07-01",
      rows: [{
        ticketKey: "PROJ-1",
        spans: [{ startMs: at(2026, 7, 1, 9, 0), endMs: at(2026, 7, 1, 9, 0) + 20_000 }]
      }]
    })
    expect(gridLines(lines)[0]!.slice(8).indexOf("#")).toBe(0)
    expect(gridLines(lines)[0]!.slice(8).replace(/\./g, "")).toBe("#")
  })

  // A caller may hand over a whole period's rows; another day's spans must not wrap onto this one.
  it("ignores spans belonging to another day", () => {
    const lines = renderDayCalendar({
      day: "2026-07-01",
      rows: [{
        ticketKey: "PROJ-1",
        spans: [{ startMs: at(2026, 7, 2, 9, 0), endMs: at(2026, 7, 2, 9, 30) }]
      }]
    })
    expect(lines).toEqual([])
  })

  it("draws a span running to local midnight without spilling past the grid", () => {
    const lines = renderDayCalendar({
      day: "2026-07-01",
      rows: [{
        ticketKey: "PROJ-1",
        spans: [{ startMs: at(2026, 7, 1, 23, 30), endMs: at(2026, 7, 2, 0, 0) }]
      }]
    })
    const cells = gridLines(lines)[0]!.slice(8)
    expect(cells).toHaveLength(60)
    expect(cells.slice(30)).toBe("#".repeat(30))
  })

  it("puts each ruler label above the minute it names", () => {
    const lines = renderDayCalendar({
      day: "2026-07-01",
      rows: [{ ticketKey: "PROJ-1", spans: [span(9, 0, 9, 60)] }]
    })
    const ruler = lines[1]!
    expect(ruler.slice(8, 11)).toBe(":00")
    expect(ruler.slice(8 + 15, 8 + 18)).toBe(":15")
    expect(ruler.slice(8 + 45, 8 + 48)).toBe(":45")
  })
})

describe("formatSpanRanges", () => {
  it("renders each block as a local clock range", () => {
    expect(formatSpanRanges([span(9, 5, 10, 30)])).toBe("09:05-10:30")
  })

  it("joins several blocks in order", () => {
    expect(formatSpanRanges([span(9, 0, 9, 30), span(11, 0, 11, 15)])).toBe("09:00-09:30, 11:00-11:15")
  })

  it("clips a long list with a count rather than wrapping the line", () => {
    const spans = [span(1, 0, 1, 5), span(2, 0, 2, 5), span(3, 0, 3, 5), span(4, 0, 4, 5), span(5, 0, 5, 5)]
    expect(formatSpanRanges(spans, { limit: 3 })).toBe("01:00-01:05, 02:00-02:05, 03:00-03:05 +2 more")
  })

  it("renders nothing for no spans", () => {
    expect(formatSpanRanges([])).toBe("")
  })
})

describe("more Issue Keys than glyphs", () => {
  // Glyphs run out at six. Comparing minutes by glyph made the seventh key collide with the first,
  // so a minute genuinely split between them read as exclusively one ticket's — the one thing the
  // grid states it will never do.
  it("still marks a minute shared when two keys collide past the glyph supply", () => {
    const spans = [{ startMs: new Date(2026, 6, 1, 10, 0).getTime(), endMs: new Date(2026, 6, 1, 10, 30).getTime() }]
    const rows = Array.from({ length: 7 }, (_, index) => ({
      ticketKey: `PROJ-${index + 1}`,
      spans: index === 0 || index === 6 ? spans : []
    }))
    const lines = renderDayCalendar({ day: "2026-07-01", rows })
    expect(lines.join("\n")).toContain("shared")
    expect(lines[0]).toContain("? PROJ-7")
  })
})

describe("daylight saving", () => {
  // Positions used to be measured from local midnight, which is not minute-of-day on a transition
  // day: after a spring-forward, 03:00 is two hours from midnight and was drawn in the `02h` row.
  it("draws a spring-forward morning under its real local hour", () => {
    const start = new Date(2026, 2, 8, 3, 0).getTime()
    const lines = renderDayCalendar({
      day: "2026-03-08",
      rows: [{ ticketKey: "PROJ-1", spans: [{ startMs: start, endMs: start + 30 * 60_000 }] }]
    })
    const hours = lines.filter((line) => line.trimStart().startsWith("0"))
    expect(hours.some((line) => line.includes("03h") && line.includes("#"))).toBe(true)
    expect(hours.some((line) => line.includes("02h") && line.includes("#"))).toBe(false)
  })

  // After a fall-back every later block shifted by an hour, and the last of them ran off the end of
  // the fixed 1,440-cell grid and vanished.
  it("keeps a late block on a fall-back day inside the grid", () => {
    const start = new Date(2026, 10, 1, 23, 0).getTime()
    const lines = renderDayCalendar({
      day: "2026-11-01",
      rows: [{ ticketKey: "PROJ-1", spans: [{ startMs: start, endMs: start + 30 * 60_000 }] }]
    })
    expect(lines.some((line) => line.includes("23h") && line.includes("#"))).toBe(true)
  })
})
