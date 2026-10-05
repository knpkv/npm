import type { ProposalBlockResponse, SavedEntry, WeekPlanResponse, WeekRowResponse } from "../shared/contracts.js"
import { MINIMUM_WRITE_SECONDS } from "../shared/writePlanning.js"
import { dayBounds, hourWindow, placeBlocks } from "./layout.js"
import { type OptimisticEntry, previewWrite } from "./weekAtoms.js"

/** Shared with rendering: collision detection includes the minimum card height. */
export const minutePixels = 2
export const minimumBlockPixels = 24

/** A suggestion needs a writable minute of real range, credit, and room in a selected provider. */
const minimumSuggestionSeconds = MINIMUM_WRITE_SECONDS

const isSuggestionBlock = (block: ProposalBlockResponse): boolean =>
  block.seconds >= minimumSuggestionSeconds && block.endMs - block.startMs >= minimumSuggestionSeconds * 1000

export interface CalendarLayers {
  readonly jira: boolean
  readonly clockify: boolean
  readonly available: boolean
  readonly overlapping: boolean
}

export const defaultCalendarLayers: CalendarLayers = {
  jira: true,
  clockify: true,
  available: true,
  overlapping: false
}

const remainingSuggestionSeconds = (
  row: WeekRowResponse,
  scope: WeekPlanResponse["scope"],
  layers: CalendarLayers = defaultCalendarLayers
): number =>
  Math.max(
    scope !== "jira" && layers.clockify ? (row.proposal?.clockifyDelta ?? 0) : 0,
    scope !== "clockify" && layers.jira ? (row.proposal?.jiraDelta ?? 0) : 0
  )

/** Ask confirmation's planner how much of one block the selected provider could actually write. */
const executableBlockSeconds = (
  plan: WeekPlanResponse,
  rowId: string,
  blockIndex: number,
  source: "clockify" | "jira"
): number => {
  const row = plan.rows.find((row) => row.rowId === rowId)
  const rowDelta = source === "clockify" ? (row?.proposal?.clockifyDelta ?? 0) : (row?.proposal?.jiraDelta ?? 0)
  const executable = previewWrite({ plan, entries: [] }, {
    kind: "confirm",
    request: {
      planId: plan.planId,
      rowId,
      blocks: [blockIndex],
      targets: { clockify: source === "clockify", jira: source === "jira" }
    }
  }).filter((entry) => entry.source === source).reduce(
    (total, entry) => total + (entry.endMs - entry.startMs) / 1000,
    0
  )
  return Math.min(rowDelta, executable)
}

const selectedBlockSeconds = (
  plan: WeekPlanResponse,
  rowId: string,
  blockIndex: number,
  layers: CalendarLayers
): number =>
  Math.max(
    plan.scope !== "jira" && layers.clockify ? executableBlockSeconds(plan, rowId, blockIndex, "clockify") : 0,
    plan.scope !== "clockify" && layers.jira ? executableBlockSeconds(plan, rowId, blockIndex, "jira") : 0
  )

export type GridBlock =
  | {
    readonly kind: "logged"
    readonly id: string
    readonly startMs: number
    readonly endMs: number
    readonly ticketKey: string | null
    readonly source: "clockify" | "jira"
    readonly pending?: boolean
    readonly entry?: SavedEntry
    readonly description: string | null
  }
  | {
    readonly kind: "proposable"
    readonly overlap: boolean
    readonly id: string
    readonly startMs: number
    readonly endMs: number
    readonly rowId: string
    /** Which block of its row this is, which is what confirming just this one names. */
    readonly blockIndex: number
    readonly ticketKey: string
    readonly ticketTitle: string | null
    readonly signal: string
    /** This block's own credit, which is what accepting it alone would write. */
    readonly seconds: number
    /** This block's executable seconds in the selected providers, for the tooltip. */
    readonly deltaSeconds: number
  }

/** Keep every provider interval; a suggestion remains separate from saved time. */
const blocksForRow = (row: WeekRowResponse, scope: WeekPlanResponse["scope"]): ReadonlyArray<GridBlock> => {
  const logged = row.intervals.filter((interval) => scope === "both" || interval.source === scope)
  const deltaSeconds = remainingSuggestionSeconds(row, scope)
  return [
    ...logged.map((interval, index): GridBlock => ({
      description: interval.entry === undefined
        ? (interval.source === "clockify" ? (row.clockifyDescription ?? row.ticketTitle) : row.ticketTitle)
        : interval.entry.description,
      ...(interval.entry !== undefined && { entry: interval.entry }),
      endMs: interval.endMs,
      id: `${row.rowId}:${interval.source}:${index}`,
      kind: "logged",
      source: interval.source,
      startMs: interval.startMs,
      ticketKey: row.ticketKey
    })),
    ...(row.proposal === undefined
      ? []
      : row.proposal.blocks.flatMap((block, index): ReadonlyArray<GridBlock> => {
        // Filter the projection, never the retained evidence array: confirmation still names the
        // original index. Restored scans get the same floor without another session read.
        if (
          !isSuggestionBlock(block) ||
          deltaSeconds < minimumSuggestionSeconds
        ) return []
        return [{
          blockIndex: index,
          deltaSeconds,
          endMs: block.endMs,
          id: `${row.rowId}:gap:${index}`,
          kind: "proposable",
          overlap: false,
          rowId: row.rowId,
          seconds: block.seconds,
          signal: row.proposal?.signal ?? "none",
          startMs: block.startMs,
          ticketKey: row.ticketKey,
          ticketTitle: row.ticketTitle
        }]
      }))
  ]
}

/** Every block in the week, which is also what decides the hours the grid shows. */
const blocksForWeek = (plan: WeekPlanResponse): ReadonlyArray<GridBlock> => [
  ...plan.rows.flatMap((row) => blocksForRow(row, plan.scope)),
  ...(plan.scope === "jira"
    ? []
    : plan.unlinkedClockify.map((entry, index): GridBlock => ({
      ...entry,
      kind: "logged",
      id: `unlinked-clockify:${index}`,
      source: "clockify",
      ticketKey: null
    })))
]

/**
 * The columns to draw.
 *
 * Saturday and Sunday appear only when they hold something. A week with nothing on them is five
 * columns of work rather than seven, two of which are always empty and steal the width.
 */
const visibleDays = (plan: WeekPlanResponse, blocks: ReadonlyArray<GridBlock>): ReadonlyArray<string> => {
  const busy = new Set(plan.days.filter((day) => {
    const bounds = dayBounds(day)
    return blocks.some((block) => block.startMs < bounds.endMs && block.endMs > bounds.startMs)
  }))
  const withUnplaced = new Set([...busy, ...plan.unattributed.map((credit) => credit.day)])
  return plan.days.filter((day, index) => index < 5 || withUnplaced.has(day))
}

export type ProposableBlock = Extract<GridBlock, { readonly kind: "proposable" }>

/**
 * Back-to-back suggestions too short to draw on their own, shown as one card over their stretch.
 *
 * A packed stretch of parallel work hands each ticket a few minutes in turn. Drawn one card per
 * ticket, every card is taller than its time and the calendar pushes them into side-by-side lanes
 * that read as overlap, although none of them overlap at all.
 */
export interface StretchBlock {
  readonly kind: "stretch"
  readonly id: string
  readonly startMs: number
  readonly endMs: number
  /** In packed order; each stays individually reviewable and approvable. */
  readonly members: ReadonlyArray<ProposableBlock>
}

export type CalendarBlock = GridBlock | StretchBlock

/** Gap tolerated between two packed blocks: they are written back to back, to the second. */
const PACKED_JOIN_MS = 1000

/**
 * Group runs of two or more consecutive short suggestions into stretches. Long suggestions and
 * saved entries are never grouped, and a single short suggestion stays its own card.
 */
export const groupStretches = (
  blocks: ReadonlyArray<GridBlock>,
  shortMs: number
): ReadonlyArray<CalendarBlock> => {
  const proposable = blocks
    .filter((block): block is ProposableBlock => block.kind === "proposable")
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const grouped: Array<CalendarBlock> = blocks.filter((block) => block.kind !== "proposable")
  let run: Array<ProposableBlock> = []
  const flush = () => {
    const first = run[0]
    const last = run.at(-1)
    if (first !== undefined && last !== undefined && run.length >= 2) {
      grouped.push({
        kind: "stretch",
        id: `stretch-${first.id}`,
        startMs: first.startMs,
        endMs: last.endMs,
        members: run
      })
    } else {
      for (const single of run) grouped.push(single)
    }
    run = []
  }
  for (const block of proposable) {
    const previous = run.at(-1)
    if (block.endMs - block.startMs >= shortMs) {
      flush()
      grouped.push(block)
      continue
    }
    // Only back-to-back blocks on one local day join: overlapping ones keep their own lanes.
    const runEndMs = Math.max(...run.map((member) => member.endMs))
    if (
      previous !== undefined &&
      (Math.abs(block.startMs - runEndMs) > PACKED_JOIN_MS ||
        new Date(block.startMs).toDateString() !== new Date(previous.startMs).toDateString())
    ) flush()
    run.push(block)
  }
  flush()
  return grouped
}

/** Project saved time and pending writes into the same layers, counts and day placements for both presentations. */
export const projectCalendar = (
  plan: WeekPlanResponse,
  entries: ReadonlyArray<OptimisticEntry>,
  layers: CalendarLayers = defaultCalendarLayers
) => {
  const base = blocksForWeek(plan).filter(
    (block) =>
      block.kind === "logged" ?
        !entries.some((entry) =>
          block.entry !== undefined && entry.replaces?.source === block.source && entry.replaces.id === block.entry.id
        ) :
        !entries.some(
          (entry) =>
            entry.rowId === block.rowId && (entry.blocks === undefined || entry.blocks.includes(block.blockIndex))
        )
  )
  const all: ReadonlyArray<GridBlock> = [
    ...base,
    ...entries.map((entry): GridBlock => ({
      ...entry,
      kind: "logged"
    }))
  ]
  const logged = all.filter((block) => block.kind === "logged")
  const blocks = all.map((block) =>
    block.kind === "logged"
      ? block
      : {
        ...block,
        deltaSeconds: selectedBlockSeconds(plan, block.rowId, block.blockIndex, layers),
        overlap: logged.some((entry) =>
          layers[entry.source] && entry.startMs < block.endMs && entry.endMs > block.startMs
        )
      }
  )
  const counts = { jira: 0, clockify: 0, available: 0, overlapping: 0 }
  const visible = blocks.filter((block) => {
    // A hidden provider cannot keep a sixteen-second remainder in another provider actionable.
    // Keep the frame independent of layer selection so toggling providers does not move the grid.
    if (block.kind === "proposable" && block.deltaSeconds < minimumSuggestionSeconds) return false
    const layer = block.kind === "logged" ? block.source : block.overlap ? "overlapping" : "available"
    counts[layer] += 1
    return layers[layer]
  })
  const visibleHours = hourWindow(blocks)
  const days = visibleDays(plan, blocks)
  const hours = Array.from(
    { length: visibleHours.toHour - visibleHours.fromHour },
    (_, offset) => visibleHours.fromHour + offset
  )
  return {
    counts,
    visibleHours,
    days,
    hours,
    placements: new Map(days.map((day) => [day, placeBlocks(visible, day, minimumBlockPixels / minutePixels)])),
    /** The calendar's own placement, with packed short suggestions grouped into stretches. */
    calendarPlacements: new Map(days.map((day) => {
      const minimumMinutes = minimumBlockPixels / minutePixels
      return [day, placeBlocks(groupStretches(visible, minimumMinutes * 60_000), day, minimumMinutes)]
    }))
  }
}

/** Suggested totals count only eligible evidence, capped by each provider's remaining room. */
const suggestedTotal = (plan: WeekPlanResponse | null, source: "jira" | "clockify"): number => {
  if (plan === null || (plan.scope !== "both" && plan.scope !== source)) return 0
  return plan.rows.reduce((total, row) => {
    const delta = source === "jira" ? (row.proposal?.jiraDelta ?? 0) : (row.proposal?.clockifyDelta ?? 0)
    const credit = (row.proposal?.blocks ?? []).reduce((sum, block, index) => {
      if (
        !isSuggestionBlock(block) ||
        selectedBlockSeconds(plan, row.rowId, index, defaultCalendarLayers) < minimumSuggestionSeconds
      ) return sum
      const executable = executableBlockSeconds(plan, row.rowId, index, source)
      return sum + executable
    }, 0)
    return total + Math.min(credit, delta)
  }, 0)
}

/** Provider totals include ticketless Clockify time. The suggestion floor never alters saved totals. */
export const weekTotals = (plan: WeekPlanResponse | null) => ({
  jira: (plan?.rows ?? []).reduce((sum, row) => sum + row.jiraSeconds, 0),
  clockify: (plan?.rows ?? []).reduce((sum, row) => sum + row.clockifySeconds, 0)
    + (plan?.unlinkedClockify ?? []).reduce((sum, entry) => sum + entry.seconds, 0),
  jiraSuggested: suggestedTotal(plan, "jira"),
  clockifySuggested: suggestedTotal(plan, "clockify")
})
