/** Packed short suggestions are drawn as one stretch so the calendar stops faking overlap. */
import { expect, it } from "@effect/vitest"
import { type GridBlock, groupStretches, type ProposableBlock } from "../src/client/calendarProjection.js"

const MIN = 60_000
const suggestion = (key: string, startMin: number, endMin: number): ProposableBlock => ({
  kind: "proposable",
  overlap: false,
  id: `${key}-${String(startMin)}`,
  startMs: startMin * MIN,
  endMs: endMin * MIN,
  rowId: `row-${key}`,
  blockIndex: 0,
  ticketKey: key,
  ticketTitle: null,
  signal: "path",
  seconds: (endMin - startMin) * 60,
  deltaSeconds: (endMin - startMin) * 60
})
const saved: GridBlock = {
  kind: "logged",
  id: "saved",
  startMs: 0,
  endMs: 5 * MIN,
  ticketKey: "PROJ-9",
  source: "jira",
  description: null
}

it("groups back-to-back short suggestions and leaves long, lone and saved blocks alone", () => {
  const grouped = groupStretches([
    saved,
    suggestion("PROJ-1", 0, 4),
    suggestion("PROJ-2", 4, 9),
    suggestion("PROJ-3", 9, 11),
    suggestion("PROJ-4", 11, 41),
    suggestion("PROJ-5", 60, 63)
  ], 12 * MIN)
  const stretches = grouped.filter((block) => block.kind === "stretch")
  expect(stretches).toHaveLength(1)
  expect(stretches[0]).toMatchObject({ startMs: 0, endMs: 11 * MIN })
  if (stretches[0]?.kind === "stretch") {
    expect(stretches[0].members.map((member) => member.ticketKey)).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"])
  }
  // The long block, the lone short block and the saved entry each keep their own card.
  expect(grouped.filter((block) => block.kind !== "stretch").map((block) => block.id).sort())
    .toEqual(["PROJ-4-11", "PROJ-5-60", "saved"])
})

it("breaks a stretch at a gap rather than bridging idle time", () => {
  const grouped = groupStretches([
    suggestion("PROJ-1", 0, 3),
    suggestion("PROJ-2", 3, 6),
    suggestion("PROJ-3", 20, 23),
    suggestion("PROJ-4", 23, 26)
  ], 12 * MIN)
  expect(grouped.filter((block) => block.kind === "stretch")).toHaveLength(2)
})

it("keeps overlapping short suggestions out of a packed stretch", () => {
  const grouped = groupStretches([
    suggestion("PROJ-1", 0, 10),
    suggestion("PROJ-2", 5, 6),
    suggestion("PROJ-3", 6, 7)
  ], 12 * MIN)
  const first = grouped.find((block) => block.id === "PROJ-1-0")
  expect(first?.kind).toBe("proposable")
  expect(grouped.filter((block) => block.kind === "stretch").every((block) => block.endMs <= 10 * MIN)).toBe(true)
})

it("never joins suggestions across local midnight", () => {
  const midnight = new Date(2026, 9, 6).getTime() / MIN
  const grouped = groupStretches([
    suggestion("PROJ-1", midnight - 4, midnight),
    suggestion("PROJ-2", midnight, midnight + 4)
  ], 12 * MIN)
  expect(grouped.filter((block) => block.kind === "stretch")).toHaveLength(0)
})
