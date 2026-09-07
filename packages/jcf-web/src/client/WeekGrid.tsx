/**
 * The week as a calendar.
 *
 * **Mental model**
 *
 * - **Everything sits at the time it happened.** Logged entries come from the intervals the two
 *   systems reported; proposable time comes from the credited spans of the sessions behind it. A
 *   block nobody can place in time is not drawn here at all — the lane below says so instead.
 * - **One block per logged entry, marked when Jira is behind it.** Drawing the same hour twice, once
 *   per system, would double every day on screen. Time only Jira holds is its own block, because
 *   that direction is a real discrepancy and hiding it would be the same lie in reverse.
 * - **Empty space is an offer.** Clicking it is how time nobody recorded gets logged, at the time
 *   clicked — which is the gesture a calendar teaches.
 * - **A block is the unit, not the day.** Clicking one proposable block offers that stretch, because
 *   that is the thing on screen a person pointed at. Its row's other blocks are one tick away in the
 *   panel, so accepting the whole day never costs more than a click either.
 *
 * @module
 */
import type { CSSProperties } from "react"
import type { WeekPlanResponse, WeekRowResponse } from "../server/Api.js"
import { duration, formatClock } from "./format.js"
import { clockAtOffset, type HourWindow, hourWindow, type Placed, placeBlocks } from "./layout.js"

/** Pixels per minute. Also the CSS variable, set from here so the two can never disagree. */
const MINUTE_PX = 0.8

const HOUR_PX = MINUTE_PX * 60

/**
 * The shortest a block may be drawn.
 *
 * Enough for one line of its label. At true scale a five-minute block is four pixels tall, which
 * renders as a sliver with the top half of its Issue Key showing and is barely clickable — and a
 * block that cannot be read or clicked is not an offer.
 */
const MIN_BLOCK_PX = 18

export type GridBlock =
  | {
      readonly kind: "logged"
      readonly id: string
      readonly startMs: number
      readonly endMs: number
      readonly ticketKey: string
      readonly source: "clockify" | "jira"
      /** True when the other system holds less than this one for the same bucket. */
      readonly behind: boolean
      readonly description: string | null
    }
  | {
      readonly kind: "proposable"
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
      /** Everything the row could still put in the two systems, for the tooltip. */
      readonly deltaSeconds: number
    }

/**
 * Every block a row contributes.
 *
 * Logged blocks are the Clockify entries when there are any, because that is the system that records
 * an interval rather than deriving one. A bucket with only Jira time draws from Jira — either because
 * that is all there is, or because this is a Jira-only week.
 */
const blocksForRow = (row: WeekRowResponse): ReadonlyArray<GridBlock> => {
  const clockify = row.intervals.filter((interval) => interval.source === "clockify")
  const jira = row.intervals.filter((interval) => interval.source === "jira")
  const logged = clockify.length > 0 ? clockify : jira
  const behind = clockify.length > 0 ? row.jiraSeconds < row.clockifySeconds : row.clockifySeconds < row.jiraSeconds

  return [
    ...logged.map((interval, index): GridBlock => ({
      behind,
      description: row.clockifyDescription ?? row.ticketTitle,
      endMs: interval.endMs,
      id: `${row.rowId}:logged:${index}`,
      kind: "logged",
      source: interval.source,
      startMs: interval.startMs,
      ticketKey: row.ticketKey
    })),
    ...(row.proposal === undefined
      ? []
      : row.proposal.blocks.map((block, index): GridBlock => ({
          blockIndex: index,
          deltaSeconds: Math.max(row.proposal?.clockifyDelta ?? 0, row.proposal?.jiraDelta ?? 0),
          endMs: block.endMs,
          id: `${row.rowId}:gap:${index}`,
          kind: "proposable",
          rowId: row.rowId,
          seconds: block.seconds,
          signal: row.proposal?.signal ?? "none",
          startMs: block.startMs,
          ticketKey: row.ticketKey,
          ticketTitle: row.ticketTitle
        })))
  ]
}

/** Every block in the week, which is also what decides the hours the grid shows. */
export const blocksForWeek = (plan: WeekPlanResponse): ReadonlyArray<GridBlock> => plan.rows.flatMap(blocksForRow)

const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/**
 * The columns to draw.
 *
 * Saturday and Sunday appear only when they hold something. A week with nothing on them is five
 * columns of work rather than seven, two of which are always empty and steal the width.
 */
export const visibleDays = (plan: WeekPlanResponse, blocks: ReadonlyArray<GridBlock>): ReadonlyArray<string> => {
  const busy = new Set(
    blocks
      .map((block) => new Date(block.startMs))
      .map((at) => {
        const month = String(at.getMonth() + 1).padStart(2, "0")
        return `${at.getFullYear()}-${month}-${String(at.getDate()).padStart(2, "0")}`
      })
  )
  const withUnplaced = new Set([...busy, ...plan.unattributed.map((credit) => credit.day)])
  return plan.days.filter((day, index) => index < 5 || withUnplaced.has(day))
}

const Block = (props: {
  readonly placed: Placed<GridBlock>
  readonly window: HourWindow
  readonly onOpen: (rowId: string, blockIndex: number) => void
  readonly selectedRowId: string | undefined
}) => {
  const { block, column, columns, endMinutes, startMinutes } = props.placed
  const style = {
    height: `${Math.max((endMinutes - startMinutes) * MINUTE_PX, MIN_BLOCK_PX)}px`,
    left: `${(column / columns) * 100}%`,
    top: `${(startMinutes - props.window.fromHour * 60) * MINUTE_PX}px`,
    width: `${(1 / columns) * 100}%`
  }
  const clock = `${formatClock(new Date(block.startMs))}–${formatClock(new Date(block.endMs))}`

  if (block.kind === "logged") {
    return (
      <div
        className="jcf-block jcf-block-logged"
        data-behind={block.behind}
        data-source={block.source}
        style={style}
        title={`${block.ticketKey} ${clock}${block.description === null ? "" : ` — ${block.description}`}`}
      >
        <span className="jcf-block-key">{block.ticketKey}</span>
        <span className="jcf-block-clock">{clock}</span>
        {block.description === null ? null : <span className="jcf-block-note">{block.description}</span>}
        {block.behind ? (
          <span className="jcf-block-flag">{block.source === "clockify" ? "Jira behind" : "Clockify behind"}</span>
        ) : null}
      </div>
    )
  }

  return (
    <button
      className="jcf-block jcf-block-gap"
      data-selected={props.selectedRowId === block.rowId}
      onClick={(event) => {
        // Stops the column's own click from also offering a manual entry underneath it.
        event.stopPropagation()
        props.onOpen(block.rowId, block.blockIndex)
      }}
      style={style}
      title={[
        `${block.ticketKey}${block.ticketTitle === null ? "" : ` — ${block.ticketTitle}`}`,
        `${clock} · ${duration(block.seconds)} on this block`,
        `+${duration(block.deltaSeconds)} proposable on this ticket today · placed by ${block.signal}`
      ].join("\n")}
      type="button"
    >
      <span className="jcf-block-key">{block.ticketKey}</span>
      <span className="jcf-block-clock">{clock}</span>
      {/* Last, so a block too short for three lines loses the title rather than the times. */}
      {block.ticketTitle === null ? null : <span className="jcf-block-note">{block.ticketTitle}</span>}
    </button>
  )
}

export const WeekGrid = (props: {
  readonly plan: WeekPlanResponse
  readonly selectedRowId: string | undefined
  readonly onOpenRow: (rowId: string, blockIndex: number) => void
  readonly onOpenSlot: (day: string, clock: string) => void
}) => {
  const blocks = blocksForWeek(props.plan)
  const window = hourWindow(blocks)
  const days = visibleDays(props.plan, blocks)
  const hours = [...new Array(window.toHour - window.fromHour).keys()].map((offset) => window.fromHour + offset)
  const now = new Date()
  const today = props.plan.days.find((day) => day === localDayOf(now))

  return (
    <div
      className="jcf-calendar"
      style={{ "--jcf-columns": String(days.length), "--jcf-hour": `${HOUR_PX}px` } as CSSProperties}
    >
      <div className="jcf-calendar-head">
        <span className="jcf-gutter-head" />
        {days.map((day) => {
          const at = new Date(`${day}T00:00:00`)
          return (
            <span className="jcf-column-head" data-today={day === today} key={day}>
              <span>{weekdayNames[(at.getDay() + 6) % 7]}</span>
              <span className="jcf-date">{at.getDate()}</span>
            </span>
          )
        })}
      </div>
      <div className="jcf-calendar-body">
        <div className="jcf-gutter">
          {hours.map((hour) => (
            <span className="jcf-hour-label" key={hour}>
              {String(hour).padStart(2, "0")}:00
            </span>
          ))}
        </div>
        {days.map((day) => (
          <div
            className="jcf-column"
            key={day}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect()
              props.onOpenSlot(day, clockAtOffset(window, (event.clientY - bounds.top) / MINUTE_PX))
            }}
          >
            {hours.map((hour) => (
              <span className="jcf-hour-line" key={hour} />
            ))}
            {day === today ? (
              <span
                className="jcf-now"
                style={{
                  top: `${(now.getHours() * 60 + now.getMinutes() - window.fromHour * 60) * MINUTE_PX}px`
                }}
              />
            ) : null}
            {placeBlocks(blocks, day).map((placed) => (
              <Block
                key={placed.block.id}
                onOpen={props.onOpenRow}
                placed={placed}
                selectedRowId={props.selectedRowId}
                window={window}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** `YYYY-MM-DD` of an instant, by the local clock — the same key every bucket uses. */
const localDayOf = (at: Date): string => {
  const month = String(at.getMonth() + 1).padStart(2, "0")
  return `${at.getFullYear()}-${month}-${String(at.getDate()).padStart(2, "0")}`
}
