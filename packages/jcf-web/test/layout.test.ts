import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { clockAtOffset, DEFAULT_HOUR_WINDOW, hourWindow, minutesIntoDay, placeBlocks } from "../src/client/layout.js"

const DAY = "2026-07-01"

/** Local components, so every expectation holds in any timezone. */
const at = (hour: number, minute: number): number => new Date(2026, 6, 1, hour, minute, 0, 0).getTime()

const block = (fromHour: number, fromMinute: number, toHour: number, toMinute: number, id = "b") => ({
  endMs: at(toHour, toMinute),
  id,
  startMs: at(fromHour, fromMinute)
})

describe("placeBlocks", () => {
  it("places one block at its own clock time, full width", () => {
    const placed = placeBlocks([block(9, 30, 10, 45)], DAY)
    expect(placed).toEqual([{
      block: block(9, 30, 10, 45),
      column: 0,
      columns: 1,
      endMinutes: 10 * 60 + 45,
      startMinutes: 9 * 60 + 30
    }])
  })

  it("splits the width between blocks that overlap", () => {
    const placed = placeBlocks([block(9, 0, 11, 0, "a"), block(10, 0, 12, 0, "b")], DAY)
    expect(placed.map((entry) => [entry.block.id, entry.column, entry.columns])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2]
    ])
  })

  it("keeps a later, separate block full width", () => {
    // The morning overlapping must not halve the afternoon: width is shared within a cluster.
    const placed = placeBlocks(
      [block(9, 0, 11, 0, "a"), block(10, 0, 12, 0, "b"), block(14, 0, 15, 0, "c")],
      DAY
    )
    expect(placed.find((entry) => entry.block.id === "c")).toMatchObject({ column: 0, columns: 1 })
  })

  it("reuses a column once its block has ended", () => {
    const placed = placeBlocks(
      [block(9, 0, 12, 0, "long"), block(9, 30, 10, 0, "first"), block(10, 30, 11, 0, "second")],
      DAY
    )
    // Both short blocks sit in column 1, one after the other, beside the long one.
    expect(placed.map((entry) => [entry.block.id, entry.column])).toEqual([
      ["long", 0],
      ["first", 1],
      ["second", 1]
    ])
    expect(placed.every((entry) => entry.columns === 2)).toBe(true)
  })

  it("gives a long block the left column when two start together", () => {
    const placed = placeBlocks([block(9, 0, 9, 30, "short"), block(9, 0, 12, 0, "long")], DAY)
    expect(placed[0]!.block.id).toBe("long")
  })

  it("clamps a block that starts on the previous day to this day's top", () => {
    const placed = placeBlocks([{ endMs: at(1, 0), id: "overnight", startMs: at(0, 0) - 3600_000 }], DAY)
    expect(placed[0]).toMatchObject({ endMinutes: 60, startMinutes: 0 })
  })

  it("clamps a block running past midnight to the end of the day", () => {
    const placed = placeBlocks([{ endMs: at(23, 0) + 4 * 3600_000, id: "late", startMs: at(23, 0) }], DAY)
    expect(placed[0]).toMatchObject({ endMinutes: 24 * 60, startMinutes: 23 * 60 })
  })

  it("draws nothing for a block on another day", () => {
    expect(placeBlocks([{ endMs: at(10, 0) + 48 * 3600_000, id: "x", startMs: at(10, 0) + 47 * 3600_000 }], DAY))
      .toEqual([])
  })

  it("draws nothing for a zero-length block", () => {
    expect(placeBlocks([block(10, 0, 10, 0)], DAY)).toEqual([])
  })

  it("places a block crossing the repeated autumn hour with positive height", () => {
    vi.stubEnv("TZ", "Europe/Berlin")
    try {
      const repeated = {
        id: "fall-back",
        startMs: Date.parse("2026-10-25T02:50:00+02:00"),
        endMs: Date.parse("2026-10-25T02:10:00+01:00")
      }
      const placed = placeBlocks([repeated], "2026-10-25")
      expect(placed).toEqual([{
        block: repeated,
        column: 0,
        columns: 1,
        startMinutes: 2 * 60 + 50,
        endMinutes: 3 * 60 + 10
      }])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("keeps spring-forward blocks at their actual elapsed height", () => {
    vi.stubEnv("TZ", "Europe/Berlin")
    try {
      const skipped = {
        id: "spring-forward",
        startMs: Date.parse("2026-03-29T01:50:00+01:00"),
        endMs: Date.parse("2026-03-29T03:10:00+02:00")
      }
      expect(placeBlocks([skipped], "2026-03-29")[0]).toMatchObject({
        startMinutes: 110,
        endMinutes: 130
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("uses ordinary UTC clock geometry when there is no local transition", () => {
    vi.stubEnv("TZ", "UTC")
    try {
      const ordinary = {
        startMs: Date.parse("2026-03-29T01:50:00+01:00"),
        endMs: Date.parse("2026-03-29T03:10:00+02:00")
      }
      expect(placeBlocks([ordinary], "2026-03-29")[0]).toMatchObject({ startMinutes: 50, endMinutes: 70 })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("hourWindow", () => {
  it("shows a working day when everything fits inside one", () => {
    expect(hourWindow([block(9, 0, 17, 0)])).toEqual(DEFAULT_HOUR_WINDOW)
  })

  it("widens to hold an early start and a late finish", () => {
    // A 23:40 session is exactly what someone opens this to find, so it cannot fall outside.
    expect(hourWindow([block(5, 30, 6, 0), block(23, 40, 23, 59)])).toEqual({ fromHour: 5, toHour: 24 })
  })

  it("draws the whole hour a block ends inside", () => {
    expect(hourWindow([block(9, 0, 20, 1)]).toHour).toBe(21)
  })

  it("does not widen for a block ending exactly on the hour", () => {
    expect(hourWindow([block(9, 0, 20, 0)]).toHour).toBe(20)
  })
})

describe("clockAtOffset", () => {
  it("reads a click as the quarter hour it lands on", () => {
    expect(clockAtOffset({ fromHour: 7, toHour: 20 }, 0)).toBe("07:00")
    // Seven minutes past the hour is nearer the hour than the quarter.
    expect(clockAtOffset({ fromHour: 7, toHour: 20 }, 7)).toBe("07:00")
    expect(clockAtOffset({ fromHour: 7, toHour: 20 }, 10)).toBe("07:15")
    expect(clockAtOffset({ fromHour: 7, toHour: 20 }, 190)).toBe("10:15")
  })

  // Above the grid is the grid's first hour, not midnight — a time this window is not showing.
  it("stays inside the visible window at either end", () => {
    expect(clockAtOffset({ fromHour: 7, toHour: 20 }, -600)).toBe("07:00")
    expect(clockAtOffset({ fromHour: 7, toHour: 20 }, 24 * 60)).toBe("19:45")
    expect(clockAtOffset({ fromHour: 0, toHour: 24 }, 24 * 60 * 10)).toBe("23:45")
  })
})

describe("minutesIntoDay", () => {
  it("reads the local clock rather than measuring from midnight", () => {
    expect(minutesIntoDay(at(13, 30))).toBe(13 * 60 + 30)
  })
})
