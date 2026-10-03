/**
 * The week as a calendar.
 *
 * **Mental model**
 *
 * - **Everything sits at the time it happened.** Logged entries come from the intervals the two
 *   systems reported; proposable time comes from the credited spans of the sessions behind it. A
 *   block nobody can place in time is not drawn here at all.
 * - **Providers have independent layers.** Jira and Clockify keep their own intervals, even when
 *   both record the same time. Visibility changes are local and never start a new week read.
 * - **Empty space is an offer.** Clicking it is how time nobody recorded gets logged, at the time
 *   clicked — which is the gesture a calendar teaches.
 * - **A block is the unit, not the day.** Clicking one proposable block offers that stretch, because
 *   that is the thing on screen a person pointed at. The editor stays scoped to that block.
 *
 * @module
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { Button } from "@knpkv/rly/primitives"
import type { SavedEntry } from "../shared/contracts.js"
import type { WeekPlanResponse } from "../server/Api.js"
import type { OptimisticEntry } from "./weekAtoms.js"
import {
  type CalendarLayers,
  type GridBlock,
  minimumBlockPixels,
  minutePixels,
  projectCalendar
} from "./calendarProjection.js"
import { duration, formatClock } from "./format.js"
import { clockAtOffset, type HourWindow, type Placed } from "./layout.js"

/** Pixels per minute. Also the CSS variable, set from here so the two can never disagree. */
const MINUTE_PX = minutePixels

const HOUR_PX = MINUTE_PX * 60

/**
 * The shortest a block may be drawn.
 *
 * Enough for one line of its label. At true scale a five-minute block is four pixels tall, which
 * renders as a sliver with the top half of its Issue Key showing and is barely clickable — and a
 * block that cannot be read or clicked is not an offer.
 */
const MIN_BLOCK_PX = minimumBlockPixels

const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** A separate button keeps quick approval available while ordinary review is busy. */
const QuickApproveButton = (props: {
  readonly block: Extract<GridBlock, { readonly kind: "proposable" }>
  readonly disabled: boolean
  readonly onApprove: (rowId: string, blockIndex: number) => void
}) => (
  <button
    className="jcf-quick-approve"
    type="button"
    disabled={props.disabled}
    aria-label={`Quick approve ${props.block.ticketKey} at ${formatClock(new Date(props.block.startMs))}–${formatClock(new Date(props.block.endMs))} with 5-second Undo`}
    title="Quick approve · 5s Undo"
    onClick={(event) => {
      event.stopPropagation()
      props.onApprove(props.block.rowId, props.block.blockIndex)
    }}
  >
    <span aria-hidden="true">+</span>
  </button>
)

const Block = (props: {
  readonly placed: Placed<GridBlock>
  readonly window: HourWindow
  readonly onOpen: (rowId: string, blockIndex: number) => void
  readonly selectedRowId: string | undefined
  readonly selectedBlockIndex: number | undefined
  readonly disabled: boolean
  readonly quickApproval: boolean
  readonly queueUnavailable: boolean
  readonly onQuickApprove: (rowId: string, blockIndex: number) => void
  readonly onOpenSaved: (entry: SavedEntry) => void
}) => {
  const { block, column, columns, endMinutes, startMinutes } = props.placed
  const height = Math.max((endMinutes - startMinutes) * MINUTE_PX, MIN_BLOCK_PX)
  const density = height < 38 ? "short" : height < 56 ? "medium" : "full"
  const style = {
    height: `${height}px`,
    left: `${(column / columns) * 100}%`,
    top: `${(startMinutes - props.window.fromHour * 60) * MINUTE_PX}px`,
    width: `${(1 / columns) * 100}%`
  }
  const clock = `${formatClock(new Date(block.startMs))}–${formatClock(new Date(block.endMs))}`

  if (block.kind === "logged") {
    return (
      <button
        type="button"
        id={`jcf-calendar-saved-${block.source}-${encodeURIComponent(block.entry?.id ?? block.id)}-${block.startMs}`}
        disabled={props.disabled || block.pending === true || block.entry === undefined}
        onClick={(event) => {
          event.stopPropagation()
          if (block.entry !== undefined) props.onOpenSaved(block.entry)
        }}
        className="jcf-block jcf-block-logged"
        data-density={density}
        data-source={block.source}
        data-pending={block.pending === true}
        style={style}
        title={`${block.pending === true ? "Pending in" : "Saved in"} ${block.source === "jira" ? "Jira" : "Clockify"}: ${block.ticketKey ?? "No ticket"} ${clock}${block.description === null ? "" : ` — ${block.description}`}`}
      >
        <span className="jcf-block-label">
          <span className="jcf-block-key">{block.ticketKey ?? "No ticket"}</span>
          <span className="jcf-block-source">
            {block.pending === true ? "Pending" : block.source === "jira" ? "Jira" : "Clockify"}
          </span>
        </span>
        <span className="jcf-block-clock">{clock}</span>
        {block.description === null ? null : <span className="jcf-block-note">{block.description}</span>}
      </button>
    )
  }

  return (
    <div className="jcf-block-actions" style={style}>
      <button
        id={`jcf-calendar-suggestion-${encodeURIComponent(block.rowId)}-${block.blockIndex}`}
        className="jcf-block jcf-block-gap"
        data-overlap={block.overlap}
        data-density={density}
        disabled={props.disabled}
        aria-label={`${block.ticketKey}, ${clock}, ${duration(block.seconds)} suggested, not saved${props.quickApproval ? ", click to queue with Undo" : ""}${block.ticketTitle === null ? "" : `, ${block.ticketTitle}`}`}
        aria-pressed={props.selectedRowId === block.rowId && props.selectedBlockIndex === block.blockIndex}
        data-selected={props.selectedRowId === block.rowId && props.selectedBlockIndex === block.blockIndex}
        onClick={(event) => {
          // Stops the column's own click from also offering a manual entry underneath it.
          event.stopPropagation()
          props.onOpen(block.rowId, block.blockIndex)
        }}
        title={[
          `${block.ticketKey}${block.ticketTitle === null ? "" : ` — ${block.ticketTitle}`}`,
          `${clock} · ${duration(block.seconds)} on this block`,
          `+${duration(block.deltaSeconds)} proposable on this ticket today · placed by ${block.signal}`
        ].join("\n")}
        type="button"
      >
        <span className="jcf-block-label">
          <span className="jcf-block-key">{block.ticketKey}</span>
          <span className="jcf-block-source">
            {props.quickApproval ? "Approve" : block.overlap ? "Overlap" : "Suggestion"}
          </span>
        </span>
        <span className="jcf-block-clock">{clock}</span>
        {/* Last, so a block too short for three lines loses the title rather than the times. */}
        {block.ticketTitle === null ? null : <span className="jcf-block-note">{block.ticketTitle}</span>}
      </button>
      <QuickApproveButton block={block} disabled={props.queueUnavailable} onApprove={props.onQuickApprove} />
    </div>
  )
}

export const WeekGrid = (props: {
  readonly layers: CalendarLayers
  readonly onToggleLayer: (layer: keyof CalendarLayers | "all") => void
  readonly writing: boolean
  readonly plan: WeekPlanResponse
  readonly optimisticEntries: ReadonlyArray<OptimisticEntry>
  readonly selectedRowId: string | undefined
  readonly selectedBlockIndex: number | undefined
  readonly disabled: boolean
  readonly manualDisabled: boolean
  readonly quickApproval: boolean
  readonly queueUnavailable: boolean
  readonly onQuickApprove: (rowId: string, blockIndex: number) => void
  readonly onOpenSaved: (entry: SavedEntry) => void
  readonly onOpenRow: (rowId: string, blockIndex: number) => void
  readonly onOpenSlot: (day: string, clock: string) => void
}) => {
  const { layers } = props
  const [view, setView] = useState<"auto" | "calendar" | "agenda">("auto")
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 640px)").matches)
  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)")
    const change = () => setNarrow(query.matches)
    query.addEventListener("change", change)
    return () => query.removeEventListener("change", change)
  }, [])
  const presentation = view === "auto" ? (narrow ? "agenda" : "calendar") : view

  const { counts, days, hours, placements, visibleHours } = useMemo(() => {
    return projectCalendar(props.plan, props.optimisticEntries, layers)
  }, [props.plan, props.optimisticEntries, layers])
  // Dense collision lanes still need a 24px review target beside the 24px quick action.
  const minimumColumnPixels = [...placements.values()].reduce(
    (maximum, day) => day.reduce((maximum, placed) => Math.max(maximum, placed.columns * 48), maximum),
    0
  )
  const calendarStyle: CSSProperties & Record<"--jcf-columns" | "--jcf-hour" | "--jcf-column-min", string> = {
    "--jcf-columns": String(days.length),
    "--jcf-column-min": `${minimumColumnPixels}px`,
    "--jcf-hour": `${HOUR_PX}px`
  }
  const now = new Date()
  const today = props.plan.days.find((day) => day === localDayOf(now))

  return (
    <section className="jcf-week-view" data-view={presentation} aria-label="Week calendar" tabIndex={-1}>
      <div className="jcf-calendar-tools">
        <div className="jcf-layers" role="group" aria-label="Visible calendar layers">
          {(
            [
              {
                label: "Saved entries · click to edit",
                choices: [
                  { key: "jira", label: "Jira entries", detail: "Jira worklogs" },
                  { key: "clockify", label: "Clockify entries", detail: "With or without a ticket" }
                ]
              },
              {
                label: props.quickApproval ? "Suggestions · click to approve" : "Suggestions · click to review",
                choices: [
                  { key: "available", label: "No overlap", detail: "Outside visible saved time" },
                  { key: "overlapping", label: "Overlap", detail: "Check before logging" },
                  { key: "all", label: "All", detail: "Every suggestion" }
                ]
              }
            ] satisfies ReadonlyArray<{
              readonly label: string
              readonly choices: ReadonlyArray<{
                readonly key: keyof typeof layers | "all"
                readonly label: string
                readonly detail: string
              }>
            }>
          ).map((group) => (
            <div className="jcf-layer-group" key={group.label}>
              <strong>{group.label}</strong>
              <div className="jcf-layer-choices" data-suggestions={group.choices.some(({ key }) => key === "all")}>
                {group.choices
                  .filter(
                    ({ key }) =>
                      (key !== "jira" && key !== "clockify") || props.plan.scope === "both" || props.plan.scope === key
                  )
                  .map(({ detail, key, label }) => {
                    const selected =
                      key === "all"
                        ? layers.available && layers.overlapping
                        : key === "available"
                          ? layers.available && !layers.overlapping
                          : key === "overlapping"
                            ? layers.overlapping && !layers.available
                            : layers[key]
                    return (
                      <div className="jcf-layer-choice" key={key}>
                        <Button
                          variant={selected ? "primary" : "secondary"}
                          {...(key === "jira" || key === "clockify"
                            ? { leadingIcon: selected ? "check" : "plus" }
                            : {})}
                          title={`${selected && (key === "jira" || key === "clockify") ? "Hide" : "Show"} ${label}`}
                          data-source={key}
                          aria-label={label}
                          aria-pressed={selected}
                          disabled={props.writing && (key === "jira" || key === "clockify")}
                          onClick={() => props.onToggleLayer(key)}
                        >
                          {`${label} · ${key === "all" ? counts.available + counts.overlapping : counts[key]}`}
                        </Button>
                        <small>{detail}</small>
                      </div>
                    )
                  })}
              </div>
            </div>
          ))}
        </div>
        <div className="jcf-presentation" role="group" aria-label="Calendar presentation">
          <Button
            size="compact"
            variant="quiet"
            aria-pressed={presentation === "calendar"}
            onClick={() => setView("calendar")}
          >
            Calendar
          </Button>
          <Button
            size="compact"
            variant="quiet"
            aria-pressed={presentation === "agenda"}
            onClick={() => setView("agenda")}
          >
            Agenda
          </Button>
        </div>
      </div>
      <p className="jcf-layer-help">
        Overlap is checked against the Jira and Clockify layers you show, for any ticket or entry without a ticket. Only
        selected provider layers receive new time.{" "}
        {props.quickApproval
          ? "Click a dashed suggestion to queue it. Undo is available for at least five seconds before saving."
          : "Click a dashed suggestion to review and log it."}{" "}
        Use + to quick approve with five-second Undo in either mode. Click empty space to add time.
      </p>
      <div
        className="jcf-calendar"
        role="region"
        aria-label="Scrollable weekly calendar"
        tabIndex={0}
        style={calendarStyle}
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
              data-disabled={props.manualDisabled}
              key={day}
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect()
                if (props.manualDisabled || event.target !== event.currentTarget) return
                props.onOpenSlot(day, clockAtOffset(visibleHours, (event.clientY - bounds.top) / MINUTE_PX))
              }}
            >
              {hours.map((hour) => (
                <span className="jcf-hour-line" key={hour} />
              ))}
              {day === today ? (
                <span
                  className="jcf-now"
                  style={{
                    top: `${(now.getHours() * 60 + now.getMinutes() - visibleHours.fromHour * 60) * MINUTE_PX}px`
                  }}
                />
              ) : null}
              {(placements.get(day) ?? []).map((placed) => (
                <Block
                  key={placed.block.id}
                  onOpen={props.onOpenRow}
                  placed={placed}
                  selectedRowId={props.selectedRowId}
                  selectedBlockIndex={props.selectedBlockIndex}
                  disabled={props.disabled}
                  quickApproval={props.quickApproval}
                  queueUnavailable={props.queueUnavailable}
                  onQuickApprove={props.onQuickApprove}
                  onOpenSaved={props.onOpenSaved}
                  window={visibleHours}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="jcf-agenda">
        {days.map((day) => (
          <section className="jcf-agenda-day" key={day}>
            <header>
              <h3>
                {new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "short"
                })}
              </h3>
              <Button
                size="compact"
                variant="quiet"
                disabled={props.manualDisabled}
                onClick={() => props.onOpenSlot(day, "09:00")}
              >
                Log time
              </Button>
            </header>
            {(placements.get(day) ?? []).length === 0 ? (
              <p className="jcf-muted">No entries in the visible layers.</p>
            ) : (
              <ul>
                {(placements.get(day) ?? []).map(({ block }) => (
                  <li key={block.id}>
                    {block.kind === "proposable" ? (
                      <div className="jcf-agenda-actions">
                        <button
                          id={`jcf-agenda-suggestion-${encodeURIComponent(block.rowId)}-${block.blockIndex}`}
                          type="button"
                          className="jcf-agenda-entry"
                          data-kind="proposable"
                          data-overlap={block.overlap}
                          disabled={props.disabled}
                          aria-pressed={
                            props.selectedRowId === block.rowId && props.selectedBlockIndex === block.blockIndex
                          }
                          onClick={() => props.onOpenRow(block.rowId, block.blockIndex)}
                        >
                          <span className="jcf-agenda-time">
                            {formatClock(new Date(block.startMs))}–{formatClock(new Date(block.endMs))}
                          </span>
                          <strong>{block.ticketKey ?? "No ticket"}</strong>
                          <span>{block.ticketTitle ?? "Proposed work"}</span>
                          <span className="jcf-agenda-state">
                            {duration(block.seconds)} suggested · {block.overlap ? "overlaps saved time" : "no overlap"}
                            {props.quickApproval ? " · click to approve" : ""}
                          </span>
                        </button>
                        <QuickApproveButton
                          block={block}
                          disabled={props.queueUnavailable}
                          onApprove={props.onQuickApprove}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        id={`jcf-agenda-saved-${block.source}-${encodeURIComponent(block.entry?.id ?? block.id)}-${block.startMs}`}
                        disabled={props.disabled || block.pending === true || block.entry === undefined}
                        onClick={() => {
                          if (block.entry !== undefined) props.onOpenSaved(block.entry)
                        }}
                        className="jcf-agenda-entry"
                        data-kind="logged"
                        data-source={block.source}
                        data-pending={block.pending === true}
                      >
                        <span className="jcf-agenda-time">
                          {formatClock(new Date(block.startMs))}–{formatClock(new Date(block.endMs))}
                        </span>
                        <strong>{block.ticketKey ?? "No ticket"}</strong>
                        <span>{block.description ?? "Logged work"}</span>
                        <span className="jcf-agenda-state">
                          {block.pending === true ? "Pending in" : "Saved in"}{" "}
                          {block.source === "jira" ? "Jira" : "Clockify"}
                        </span>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </section>
  )
}

/** `YYYY-MM-DD` of an instant, by the local clock — the same key every bucket uses. */
const localDayOf = (at: Date): string => {
  const month = String(at.getMonth() + 1).padStart(2, "0")
  return `${at.getFullYear()}-${month}-${String(at.getDate()).padStart(2, "0")}`
}
