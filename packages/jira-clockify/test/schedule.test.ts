import { describe, expect, it } from "@effect/vitest"
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
  it("turns twenty simultaneous tickets into four non-overlapping fifteen-minute blocks", () => {
    const rows = credit(Array.from({ length: 20 }, (_, index) => ({ ticket: `PROJ-${7000 + index}`, from: 0, to: 60 })))
    const blocks = rows.flatMap((row) => row.blocks).sort((a, b) => a.startMs - b.startMs)
    expect(blocks).toHaveLength(4)
    expect(rows.reduce((sum, row) => sum + row.seconds, 0)).toBe(3600)
    for (const [index, block] of blocks.entries()) {
      expect(block.seconds).toBe(900)
      expect(block.startMs).toBe(start + index * 900_000)
      expect(block.endMs).toBe(start + (index + 1) * 900_000)
    }
    expect(rows.every((row) => row.activeSeconds === 3600)).toBe(true)
    expect(rows.every((row) => row.sourceStartMs === start)).toBe(true)
  })

  it("keeps the dominant ticket when an overlap cannot fit two fifteen-minute blocks", () => {
    const rows = credit([{ ticket: "PROJ-7000", from: 0, to: 20 }, { ticket: "PROJ-7001", from: 1, to: 19 }])
    expect(rows.map((row) => [row.ticketKey, row.seconds])).toEqual([["PROJ-7000", 1200]])
  })

  it("shares an overlapping stretch evenly when every ticket fits", () => {
    const rows = credit([{ ticket: "PROJ-7000", from: 0, to: 60 }, { ticket: "PROJ-7001", from: 0, to: 60 }])
    expect(rows.map((row) => row.seconds)).toEqual([1800, 1800])
    expect(rows[0]?.blocks[0]?.endMs).toBe(rows[1]?.blocks[0]?.startMs)
  })

  it("never credits a late ticket beyond its active presence", () => {
    const rows = credit([{ ticket: "PROJ-7000", from: 0, to: 60 }, { ticket: "PROJ-7001", from: 45, to: 60 }])
    expect(rows.map((row) => [row.ticketKey, row.seconds, row.activeSeconds])).toEqual([
      ["PROJ-7000", 3150, 3600],
      ["PROJ-7001", 450, 900]
    ])
    expect(rows[1]?.blocks[0]?.startMs).toBeGreaterThanOrEqual(start + 45 * 60_000)
  })

  it("keeps a dominant late ticket inside its own active span", () => {
    const rows = credit([{ ticket: "PROJ-7000", from: 0, to: 20 }, { ticket: "PROJ-7001", from: 10, to: 60 }])
    expect(rows.map((row) => [row.ticketKey, row.seconds])).toEqual([
      ["PROJ-7000", 900],
      ["PROJ-7001", 2700]
    ])
    expect(rows[0]?.blocks.every((block) => block.startMs >= start && block.endMs <= start + 20 * 60_000)).toBe(true)
    expect(rows[1]?.blocks.every((block) => block.startMs >= start + 10 * 60_000 && block.endMs <= start + 60 * 60_000))
      .toBe(true)
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
