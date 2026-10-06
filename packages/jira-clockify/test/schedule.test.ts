import { describe, expect, it } from "@effect/vitest"
import { scheduleRuns } from "../src/agent/schedule.js"
import { type SessionAttribution, splitCredits } from "../src/agent/sessions.js"

const start = new Date(2026, 8, 7, 10).getTime()
const credit = (
  spans: ReadonlyArray<{ readonly ticket: string | null; readonly from: number; readonly to: number }>
) => {
  const attributions: ReadonlyArray<SessionAttribution> = spans.map((span, index) => ({
    sessionId: String(index),
    ticketKey: span.ticket,
    signal: "branch",
    confidence: null,
    belowConfidenceFloor: false
  }))
  return splitCredits(
    spans.map((span, index) => ({
      sessionId: String(index),
      spans: [{ startMs: start + span.from * 60_000, endMs: start + span.to * 60_000 }]
    })),
    attributions
  ).attributed
}

describe("proposed schedule", () => {
  it("packs fifteen interleaved tickets into fifteen writable blocks across ninety minutes", () => {
    const rows = credit([
      { ticket: "PROJ-7000", from: 0, to: 45 },
      { ticket: "PROJ-7000", from: 60, to: 90 },
      ...Array.from({ length: 14 }, (_, index) => [
        { ticket: `PROJ-${7001 + index}`, from: (index + 1) * 2, to: 35 + (index + 1) * 2 },
        { ticket: `PROJ-${7001 + index}`, from: 50 + index, to: 80 + index / 2 }
      ]).flat()
    ])
    const blocks = rows.flatMap((row) => row.blocks).sort((a, b) => a.startMs - b.startMs)
    expect(rows).toHaveLength(15)
    expect(blocks).toHaveLength(15)
    expect(blocks.every((block) => block.seconds >= 60)).toBe(true)
    expect(blocks.reduce((sum, block) => sum + block.seconds, 0)).toBe(5400)
    expect(blocks[0]?.startMs).toBe(start)
    expect(blocks.at(-1)?.endMs).toBe(start + 90 * 60_000)
    for (const [index, block] of blocks.entries()) {
      if (index > 0) expect(block.startMs).toBe(blocks[index - 1]?.endMs)
    }
  })

  it("keeps first-activity order when appended work reverses total evidence weights", () => {
    const initial = [
      { startMs: start, endMs: start + 5 * 60_000, bucketIds: ["A", "B"] },
      { startMs: start + 5 * 60_000, endMs: start + 10 * 60_000, bucketIds: ["A", "B", "C"] }
    ]
    const appended = [
      ...initial,
      { startMs: start + 10 * 60_000, endMs: start + 40 * 60_000, bucketIds: ["B", "C"] }
    ]
    expect(scheduleRuns(initial, 900, () => true).map((run) => run.bucketIds[0])).toEqual(["A", "B", "C"])
    expect(scheduleRuns(appended, 900, () => true).map((run) => run.bucketIds[0])).toEqual(["A", "B", "C"])
  })

  it("packs mixed credit after attributed tickets without internal gaps", () => {
    const runs = [
      { startMs: start, endMs: start + 10 * 60_000, bucketIds: ["A", "unknown"] },
      { startMs: start + 10 * 60_000, endMs: start + 20 * 60_000, bucketIds: ["A", "B"] }
    ]
    const scheduled = scheduleRuns(runs, 900, (id) => id !== "unknown")
    expect(scheduled.map((run) => [run.bucketIds[0], (run.endMs - run.startMs) / 1000])).toEqual([
      ["A", 600],
      ["B", 300],
      ["unknown", 300]
    ])
    expect(scheduled[0]?.startMs).toBe(start)
    expect(scheduled.at(-1)?.endMs).toBe(start + 20 * 60_000)
    for (const [index, run] of scheduled.entries()) {
      if (index > 0) expect(run.startMs).toBe(scheduled[index - 1]?.endMs)
    }
  })

  it("keeps every simultaneous ticket in non-overlapping shares", () => {
    const rows = credit(Array.from({ length: 20 }, (_, index) => ({ ticket: `PROJ-${7000 + index}`, from: 0, to: 60 })))
    const blocks = rows.flatMap((row) => row.blocks).sort((a, b) => a.startMs - b.startMs)
    expect(blocks).toHaveLength(20)
    expect(rows.reduce((sum, row) => sum + row.seconds, 0)).toBe(3600)
    for (const [index, block] of blocks.entries()) {
      expect(block.seconds).toBe(180)
      expect(block.startMs).toBe(start + index * 180_000)
      expect(block.endMs).toBe(start + (index + 1) * 180_000)
    }
    expect(rows.every((row) => row.activeSeconds === 3600)).toBe(true)
    expect(rows.every((row) => row.sourceStartMs === start)).toBe(true)
  })

  it("keeps both tickets when an overlap cannot fit two fifteen-minute blocks", () => {
    const rows = credit([{ ticket: "PROJ-7000", from: 0, to: 20 }, { ticket: "PROJ-7001", from: 1, to: 19 }])
    expect(rows.map((row) => [row.ticketKey, row.seconds])).toEqual([["PROJ-7000", 660], ["PROJ-7001", 540]])
  })

  it("keeps a ten-minute ticket overlapping an hour of another ticket", () => {
    const rows = credit([{ ticket: "PROJ-7000", from: 0, to: 60 }, { ticket: "PROJ-7001", from: 10, to: 20 }])
    expect(rows.map((row) => [row.ticketKey, row.seconds])).toEqual([["PROJ-7000", 3300], ["PROJ-7001", 300]])
    expect(rows[1]?.blocks).toMatchObject([{ startMs: start + 55 * 60_000, endMs: start + 60 * 60_000 }])
  })

  it("folds sub-minute shares into their next higher-ranked ticket so two minutes stay writable", () => {
    const runs = [{ startMs: start, endMs: start + 120_000, bucketIds: ["A", "B", "C"] }]
    const scheduled = scheduleRuns(runs, 900, () => true, (id) => id === "C" ? 2 : id === "B" ? 1 : 0)
    expect(scheduled.map((run) => [run.bucketIds[0], (run.endMs - run.startMs) / 1000])).toEqual([
      ["B", 60],
      ["C", 60]
    ])
  })

  it("preserves short raw evidence when the entire attributed stretch cannot reach a minute", () => {
    const runs = [{ startMs: start, endMs: start + 59_000, bucketIds: ["A", "B"] }]
    expect(scheduleRuns(runs, 900, () => true, (id) => id === "B" ? 1 : 0))
      .toMatchObject([
        { bucketIds: ["A"], startMs: start, endMs: start + 1_000 },
        { bucketIds: ["B"], startMs: start + 1_000, endMs: start + 59_000 }
      ])
  })

  it("folds an unwritable highest-ranked ticket into the next writable ticket", () => {
    const runs = [
      { startMs: start, endMs: start + 5_000, bucketIds: ["A", "B"] },
      { startMs: start + 5_000, endMs: start + 120_000, bucketIds: ["B"] }
    ]
    expect(scheduleRuns(runs, 900, () => true, (id) => id === "A" ? 1 : 0))
      .toMatchObject([{ bucketIds: ["B"], startMs: start, endMs: start + 120_000 }])
  })

  it("does not change uncapped proportional shares when every ticket clears a minute", () => {
    const runs = [{ startMs: start, endMs: start + 3_601_000, bucketIds: ["A", "B", "C"] }]
    const scheduled = scheduleRuns(runs, 900, () => true, (id) => id === "C" ? 2 : 0)
    expect(scheduled).toEqual(scheduleRuns(runs, 900, () => true))
    expect(scheduled.map((run) => (run.endMs - run.startMs) / 1000)).toEqual([1200, 1200, 1201])
  })

  it("keeps unchanged allocation timestamps when logging reverses the advisory ranking", () => {
    const runs = [
      { startMs: start, endMs: start + 20 * 60_000, bucketIds: ["A"] },
      { startMs: start + 20 * 60_000, endMs: start + 40 * 60_000, bucketIds: ["A", "B"] },
      { startMs: start + 40 * 60_000, endMs: start + 80 * 60_000, bucketIds: ["B"] },
      { startMs: start + 80 * 60_000, endMs: start + 100 * 60_000, bucketIds: ["A", "B"] },
      { startMs: start + 100 * 60_000, endMs: start + 120 * 60_000, bucketIds: ["A"] }
    ]
    expect(scheduleRuns(runs, 900, () => true, (id) => id === "A" ? 1 : 0))
      .toEqual(scheduleRuns(runs, 900, () => true, (id) => id === "B" ? 1 : 0))
  })

  it("folds jointly constrained short shares without losing their connected cluster's time", () => {
    const ranges: ReadonlyArray<readonly [number, number]> = [
      [13, 51],
      [17, 73],
      [21, 54],
      [3, 99],
      [13, 14],
      [23, 44],
      [19, 46],
      [18, 58],
      [19, 109]
    ]
    const spans = ranges.map(([from, to], index) => ({
      id: String(index),
      startMs: start + from * 1000,
      endMs: start + to * 1000
    }))
    const boundaries = [...new Set(spans.flatMap((span) => [span.startMs, span.endMs]))].sort((a, b) => a - b)
    const runs = boundaries.slice(0, -1).flatMap((startMs, index) => {
      const endMs = boundaries[index + 1]
      if (endMs === undefined) return []
      const bucketIds = spans.filter((span) => span.startMs <= startMs && span.endMs >= endMs).map((span) => span.id)
      return bucketIds.length === 0 ? [] : [{ startMs, endMs, bucketIds }]
    })
    const scheduled = scheduleRuns(runs, 900, () => true, (id) => Number(id) % 3)
    expect(scheduled).toHaveLength(1)
    expect(scheduled.reduce((sum, run) => sum + run.endMs - run.startMs, 0)).toBe(106_000)
    for (const run of scheduled) {
      expect(run.startMs).toBeGreaterThanOrEqual(start + 3_000)
      expect(run.endMs).toBeLessThanOrEqual(start + 109_000)
      expect(run.endMs - run.startMs).toBeGreaterThanOrEqual(60_000)
    }
  })

  it("shares an overlapping stretch evenly when every ticket fits", () => {
    const rows = credit([{ ticket: "PROJ-7000", from: 0, to: 60 }, { ticket: "PROJ-7001", from: 0, to: 60 }])
    expect(rows.map((row) => row.seconds)).toEqual([1800, 1800])
    expect(rows[0]?.blocks[0]?.endMs).toBe(rows[1]?.blocks[0]?.startMs)
  })

  it("caps a late ticket's amount at its active seconds while packing inside the cluster", () => {
    const rows = credit([{ ticket: "PROJ-7000", from: 0, to: 60 }, { ticket: "PROJ-7001", from: 45, to: 60 }])
    expect(rows.map((row) => [row.ticketKey, row.seconds, row.activeSeconds])).toEqual([
      ["PROJ-7000", 3150, 3600],
      ["PROJ-7001", 450, 900]
    ])
    expect(rows[1]?.blocks[0]?.startMs).toBeGreaterThanOrEqual(start + 45 * 60_000)
  })

  it("packs a dominant late ticket after the earlier ticket inside the shared cluster", () => {
    const rows = credit([{ ticket: "PROJ-7000", from: 0, to: 20 }, { ticket: "PROJ-7001", from: 10, to: 60 }])
    expect(rows.map((row) => [row.ticketKey, row.seconds])).toEqual([
      ["PROJ-7000", 900],
      ["PROJ-7001", 2700]
    ])
    expect(rows[0]?.blocks).toMatchObject([{ startMs: start, endMs: start + 15 * 60_000 }])
    expect(rows[1]?.blocks).toMatchObject([{ startMs: start + 15 * 60_000, endMs: start + 60 * 60_000 }])
  })

  it("redistributes capped residual time instead of dropping it", () => {
    const rows = credit([
      { ticket: "PROJ-7000", from: 0, to: 16 },
      { ticket: "PROJ-7001", from: 10, to: 26 },
      { ticket: "PROJ-7002", from: 20, to: 36 }
    ])

    expect(rows.reduce((sum, row) => sum + row.seconds, 0)).toBe(36 * 60)
    expect(rows.every((row) => row.seconds <= row.activeSeconds)).toBe(true)
  })

  it("packs overlapping owners and reserved credit within their connected cluster", () => {
    const runs = [
      { startMs: start, endMs: start + 5 * 60_000, bucketIds: ["A", "B"] },
      { startMs: start + 5 * 60_000, endMs: start + 20 * 60_000, bucketIds: ["A", "C"] },
      { startMs: start + 20 * 60_000, endMs: start + 25 * 60_000, bucketIds: ["A", "B", "unplaced"] },
      { startMs: start + 25 * 60_000, endMs: start + 30 * 60_000, bucketIds: ["B", "unplaced"] }
    ]
    const scheduled = scheduleRuns(runs, 15 * 60, (id) => id !== "unplaced")
    const permuted = scheduleRuns(
      runs.map((run) => ({ ...run, bucketIds: [...run.bucketIds].reverse() })),
      15 * 60,
      (id) => id !== "unplaced"
    )
    expect(permuted).toEqual(scheduled)
    expect(scheduled.reduce((sum, run) => sum + run.endMs - run.startMs, 0)).toBe(30 * 60_000)
    expect(scheduled[0]?.startMs).toBe(start)
    expect(scheduled.at(-1)?.endMs).toBe(start + 30 * 60_000)
    expect(scheduled.at(-1)?.bucketIds).toEqual(["unplaced"])
    for (const [index, allocation] of scheduled.entries()) {
      expect(allocation.startMs).toBeGreaterThanOrEqual(start)
      expect(allocation.endMs).toBeLessThanOrEqual(start + 30 * 60_000)
      if (index > 0) expect(allocation.startMs).toBe(scheduled[index - 1]?.endMs)
    }

    const split = splitCredits(
      [
        { sessionId: "A", spans: [{ startMs: start, endMs: start + 25 * 60_000 }] },
        {
          sessionId: "B",
          spans: [
            { startMs: start, endMs: start + 5 * 60_000 },
            { startMs: start + 20 * 60_000, endMs: start + 30 * 60_000 }
          ]
        },
        { sessionId: "C", spans: [{ startMs: start + 5 * 60_000, endMs: start + 20 * 60_000 }] },
        { sessionId: "unplaced", spans: [{ startMs: start + 20 * 60_000, endMs: start + 30 * 60_000 }] }
      ],
      [
        { sessionId: "A", ticketKey: "PROJ-A", signal: "branch", confidence: null, belowConfidenceFloor: false },
        { sessionId: "B", ticketKey: "PROJ-B", signal: "branch", confidence: null, belowConfidenceFloor: false },
        { sessionId: "C", ticketKey: "PROJ-C", signal: "branch", confidence: null, belowConfidenceFloor: false },
        { sessionId: "unplaced", ticketKey: null, signal: "none", confidence: null, belowConfidenceFloor: false }
      ],
      { dwellSeconds: 15 * 60 }
    )
    expect([
      ...split.attributed.map((row) => row.seconds),
      ...split.unattributed.map((row) => row.seconds)
    ].reduce((sum, seconds) => sum + seconds, 0)).toBe(30 * 60)
  })

  it("uses whole seconds for allocations so drawn and written durations agree on uneven shares", () => {
    const rows = credit(
      Array.from({ length: 3 }, (_, index) => ({ ticket: `PROJ-${7000 + index}`, from: 0, to: 60 + 1 / 60 }))
    )
    expect(rows.reduce((sum, row) => sum + row.seconds, 0)).toBe(3601)
    for (const block of rows.flatMap((row) => row.blocks)) {
      expect(block.endMs - block.startMs).toBe(block.seconds * 1000)
    }
  })

  it("preserves separate ticket stretches and idle gaps instead of redistributing the entire day", () => {
    const rows = credit([
      { ticket: "PROJ-7000", from: 0, to: 20 },
      { ticket: "PROJ-7001", from: 20, to: 60 },
      { ticket: "PROJ-7000", from: 90, to: 100 }
    ])
    expect(rows.map((row) => row.seconds)).toEqual([1800, 2400])
    expect(rows[0]?.blocks).toHaveLength(2)
    expect(rows[0]?.blocks[1]?.startMs).toBe(start + 90 * 60_000)
    expect(rows[0]?.blocks[1]?.seconds).toBe(600)
  })

  it("coalesces touching blocks of one ticket after packing adjacent clusters", () => {
    const rows = credit([
      { ticket: "PROJ-7000", from: 0, to: 40 },
      { ticket: "PROJ-7001", from: 5, to: 10 },
      { ticket: "PROJ-7001", from: 40, to: 60 }
    ])
    const row = rows.find((entry) => entry.ticketKey === "PROJ-7001")
    expect(row?.blocks).toMatchObject([{
      startMs: start + 37.5 * 60_000,
      endMs: start + 60 * 60_000,
      seconds: 1350,
      sourceStartMs: start
    }])
    expect(row?.blocks).toHaveLength(1)
    expect(rows.reduce((sum, entry) => sum + entry.seconds, 0)).toBe(3600)
  })
})

it("keeps rapidly changing unplaced shares from fragmenting a known ticket", () => {
  const rows = credit([
    { ticket: "PROJ-7000", from: 0, to: 60 },
    ...Array.from({ length: 60 }, (_, minute) => ({ ticket: null, from: minute, to: minute + 0.5 }))
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0]?.seconds).toBe(2700)
  expect(rows[0]?.blocks).toHaveLength(1)
  expect(rows[0]?.blocks[0]?.seconds).toBe(2700)
})
