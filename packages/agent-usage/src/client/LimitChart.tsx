/**
 * Limits over time as small multiples: one row per named window, on the same time axis as the
 * usage columns above, so a jump in a limit sits over the work that caused it. Each row is named
 * where it is drawn, so no line needs a colour to be told apart; a gap says whether the window
 * reset with nobody reading it since or a reading failed.
 *
 * @module
 */
import { useId, useRef, useState } from "react"
import type { LimitReading, UnknownReason } from "../core/Model.js"
import type { LimitSeries } from "../shared/contracts.js"
import { PLOT, timeAxis, timeTicks } from "./axis.js"
import { readingAt } from "./chartModel.js"
import { describeReason, formatInstant, formatPercent, formatShortInstant } from "../limits/format.js"
import {
  describeUnknown,
  fullWindowName,
  type LimitRow,
  limitRows,
  type LimitSegment,
  limitSegments,
  NEAR_PERCENT
} from "../limits/model.js"
import type { ViewRange } from "./range.js"
import { useDismissOnEscape, useTooltipPlacement } from "./useTooltipPlacement.js"
import { useWidth } from "./useWidth.js"

const ROW = 56
const ROW_GAP = 12
const AXIS = 34
const LABEL = 16

/** A failed reading's span on show: which window, when, and why. */
/** Which failure is open: its row and where it starts. The rest is read from the current series. */
interface GapId {
  readonly row: string
  readonly from: number
}

interface Gap {
  readonly anchor: number
  /** The top of the gap's row, so its explanation opens beside it. */
  readonly top: number
  readonly window: string
  readonly from: number
  readonly to: number
  readonly text: string
}

/** "Keychain access refused: the Keychain refused access (security exited 36)". */
const unknownText = (reason: UnknownReason, detail: string | null | undefined): string =>
  describeUnknown(detail === null || detail === undefined ? { reason } : { reason, detail })

const readingText = (reading: LimitReading): string =>
  reading._tag === "Known" ? formatPercent(reading.usedPercent) : unknownText(reading.reason, reading.detail)

const gapOf = (
  window: string,
  segment: Extract<LimitSegment, { readonly kind: "unknown" }>,
  x: (at: number) => number,
  top: number
): Gap => ({
  anchor: (x(segment.from) + x(segment.to)) / 2,
  top,
  window,
  from: segment.from,
  to: segment.to,
  text: unknownText(segment.reason, segment.detail)
})

const Row = (props: {
  readonly row: LimitRow
  readonly top: number
  readonly width: number
  readonly end: number
  readonly from: number
  readonly x: (at: number) => number
  readonly hatch: string
  readonly onGapHover: (gap: GapId | null) => void
  readonly onGapFocus: (gap: GapId | null) => void
}) => {
  const plotTop = props.top + LABEL
  const plotHeight = ROW - LABEL
  const y = (percent: number) => plotTop + plotHeight - (Math.min(100, Math.max(0, percent)) / 100) * plotHeight
  const segments = limitSegments(props.row.points, props.end)
  const right = props.width - PLOT.right
  // One stroke per unbroken run of levels, joined by its vertical steps.
  let line = ""
  let runEnd: number | null = null
  for (const segment of segments) {
    if (segment.kind !== "level") {
      runEnd = null
      continue
    }
    line +=
      runEnd === segment.from
        ? `V${y(segment.usedPercent)}H${props.x(segment.to)}`
        : `M${props.x(segment.from)},${y(segment.usedPercent)}H${props.x(segment.to)}`
    runEnd = segment.to
  }
  const finalReading = readingAt(props.row.points, props.end)
  return (
    <g>
      {/* The latest value sits beside the name, clear of the plot and the "now" marker. */}
      <text className="usage-row-label" x={PLOT.left} y={props.top + 11}>
        {props.row.name}
        <tspan className="usage-row-value">
          {` · ${
            finalReading === undefined
              ? "not read"
              : finalReading._tag === "Known"
                ? formatPercent(finalReading.usedPercent)
                : describeReason(finalReading.reason)
          }`}
        </tspan>
      </text>
      <line className="usage-grid" x1={PLOT.left} x2={right} y1={y(100)} y2={y(100)} />
      <line className="usage-limit-near" x1={PLOT.left} x2={right} y1={y(NEAR_PERCENT)} y2={y(NEAR_PERCENT)} />
      {segments.map((segment) =>
        segment.kind === "level" ? null : segment.kind === "unknown" ? (
          <rect
            aria-label={`${props.row.name} could not be read ${formatInstant(segment.from)} to ${formatInstant(
              segment.to
            )}: ${unknownText(segment.reason, segment.detail)}`}
            className="usage-limit-unknown"
            fill={`url(#${props.hatch})`}
            height={plotHeight}
            key={`u${segment.from}`}
            onBlur={() => props.onGapFocus(null)}
            onFocus={() => props.onGapFocus({ row: props.row.id, from: segment.from })}
            onMouseEnter={() => props.onGapHover({ row: props.row.id, from: segment.from })}
            onMouseLeave={() => props.onGapHover(null)}
            role="img"
            tabIndex={0}
            width={Math.max(1, props.x(segment.to) - props.x(segment.from))}
            x={props.x(segment.from)}
            y={plotTop}
          />
        ) : (
          <line
            className="usage-limit-reset"
            key={`r${segment.from}`}
            x1={props.x(segment.from)}
            x2={props.x(segment.to)}
            y1={y(0)}
            y2={y(0)}
          />
        )
      )}
      <line className="usage-baseline" x1={PLOT.left} x2={right} y1={y(0)} y2={y(0)} />
      <text className="usage-axis-label" textAnchor="end" x={PLOT.left - 6} y={y(100) + 4}>
        100%
      </text>
      <text className="usage-axis-label" textAnchor="end" x={PLOT.left - 6} y={y(0)}>
        0
      </text>
      {props.row.firstAt === null || props.row.firstAt <= props.from + 60 * 60 * 1000 ? null : (
        <text
          className="usage-row-note"
          textAnchor={props.x(props.row.firstAt) - PLOT.left > 160 ? "end" : "start"}
          x={props.x(props.row.firstAt) - PLOT.left > 160 ? props.x(props.row.firstAt) - 8 : PLOT.left + 8}
          y={plotTop + plotHeight / 2 + 4}
        >
          {`first read ${formatShortInstant(props.row.firstAt)}`}
        </text>
      )}
      <path className="usage-limit-line" d={line} />
    </g>
  )
}

export const LimitChart = (props: {
  readonly series: ReadonlyArray<LimitSeries>
  readonly range: ViewRange
  readonly now: number
}) => {
  const [width, container] = useWidth(960)
  const [cursor, setCursor] = useState<number | null>(null)
  // Hover and keyboard focus open a failure's explanation independently; each ends only its own,
  // so moving the pointer away keeps a focused one. Leaving a hovered gap closes it after a moment,
  // so the pointer can move onto the explanation (WCAG 1.4.13); entering it keeps it open.
  const [hoveredGap, setHoveredGap] = useState<GapId | null>(null)
  const [focusedGap, setFocusedGap] = useState<GapId | null>(null)
  const closing = useRef<number | undefined>(undefined)
  const hoverGap = (next: GapId | null) => {
    window.clearTimeout(closing.current)
    if (next !== null) setHoveredGap(next)
    else closing.current = window.setTimeout(() => setHoveredGap(null), 300)
  }
  const keepGap = () => window.clearTimeout(closing.current)
  const [tableOpen, setTableOpen] = useState(false)
  const hatch = `${useId()}-hatch`
  const axis = timeAxis(props.range, width)
  const rows = limitRows(props.series)
  // A range may run on past now (today ends at midnight); nothing after now has been read yet.
  const end = Math.min(props.range.to, props.now)
  const tabled = props.series.filter((series) => series.label !== "*")
  // An open failure is looked up in the current series on every render, so a live update that
  // ends or extends it changes what its explanation says; one that is gone closes.
  const resolveGap = (id: GapId | null): Gap | null => {
    if (id === null) return null
    const index = rows.findIndex((row) => row.id === id.row)
    const row = rows[index]
    if (row === undefined) return null
    const segment = limitSegments(row.points, end).find(
      (candidate) => candidate.kind === "unknown" && candidate.from === id.from
    )
    return segment === undefined || segment.kind !== "unknown"
      ? null
      : gapOf(row.name, segment, axis.x, index * (ROW + ROW_GAP))
  }
  const gap = resolveGap(hoveredGap) ?? resolveGap(focusedGap)
  // A focused or hovered failure explains itself; otherwise the pointer shows every row's reading.
  const tooltip = useTooltipPlacement(gap?.anchor ?? cursor, width, gap?.top ?? 0)
  useDismissOnEscape(cursor !== null || gap !== null, () => {
    setCursor(null)
    window.clearTimeout(closing.current)
    setHoveredGap(null)
    setFocusedGap(null)
  })

  if (tabled.length === 0) {
    return <p className="usage-empty">No limit readings in this range yet.</p>
  }

  const height = rows.length * (ROW + ROW_GAP) + AXIS
  const instant = cursor === null ? null : axis.instantAt(cursor)
  const kinds = new Set(rows.flatMap((row) => limitSegments(row.points, end).map((segment) => segment.kind)))
  return (
    <div className="usage-chart" ref={container}>
      {rows.length === 0 ? null : (
        <>
          <svg
            aria-labelledby={`${hatch}-title`}
            height={height}
            onMouseLeave={() => setCursor(null)}
            onMouseMove={(event) => {
              const pixel = event.nativeEvent.offsetX
              setCursor(pixel >= PLOT.left && pixel <= width - PLOT.right ? pixel : null)
            }}
            role="group"
            width={width}
          >
            <title id={`${hatch}-title`}>
              {`Limits used over time, one row per window: ${rows
                .map((row) => row.name)
                .join(", ")}. The table below lists every reading.`}
            </title>
            <defs>
              <pattern height="6" id={hatch} patternTransform="rotate(45)" patternUnits="userSpaceOnUse" width="6">
                <line className="usage-hatch" x1="0" x2="0" y1="0" y2="6" />
              </pattern>
            </defs>
            {rows.map((row, index) => (
              <Row
                end={end}
                from={props.range.from}
                hatch={hatch}
                key={row.id}
                onGapFocus={setFocusedGap}
                onGapHover={hoverGap}
                row={row}
                top={index * (ROW + ROW_GAP)}
                width={width}
                x={axis.x}
              />
            ))}
            {end < props.range.to ? (
              <g aria-hidden="true">
                {rows.map((row, index) => (
                  <line
                    className="usage-now"
                    key={row.id}
                    x1={axis.x(end)}
                    x2={axis.x(end)}
                    y1={index * (ROW + ROW_GAP) + LABEL}
                    y2={index * (ROW + ROW_GAP) + ROW}
                  />
                ))}
                <text className="usage-now-label" textAnchor="middle" x={axis.x(end)} y={height - AXIS + 12}>
                  now
                </text>
              </g>
            ) : null}
            {timeTicks(props.range, width, 72, props.range.bucket === "hour" ? 1 : 24).map((tick) => (
              <text className="usage-axis-label" key={tick.at} textAnchor="middle" x={axis.x(tick.at)} y={height - 4}>
                {tick.label}
              </text>
            ))}
            {cursor === null ? null : (
              <line className="usage-crosshair" x1={cursor} x2={cursor} y1={0} y2={height - AXIS} />
            )}
          </svg>
          <ul aria-label="How to read the rows" className="usage-legend usage-legend-quiet">
            <li>
              <span className="usage-key usage-key-level" />
              share used
            </li>
            <li>
              <span className="usage-key usage-key-near" />
              {NEAR_PERCENT}% mark
            </li>
            {kinds.has("reset") ? (
              <li>
                <span className="usage-key usage-key-reset" />
                reset, not read since
              </li>
            ) : null}
            {kinds.has("unknown") ? (
              <li>
                <span className="usage-key usage-key-unknown" />
                could not be read
              </li>
            ) : null}
          </ul>
        </>
      )}
      <details className="usage-readings" onToggle={(event) => setTableOpen(event.currentTarget.open)}>
        <summary>Limit readings as a table</summary>
        {tableOpen ? (
          <table className="usage-table">
            <thead>
              <tr>
                <th scope="col">Limit</th>
                <th scope="col">From</th>
                <th scope="col">Reading</th>
              </tr>
            </thead>
            <tbody>
              {tabled.flatMap((series) =>
                series.points.map((point) => (
                  <tr key={`${series.agent}:${series.label}:${series.windowMinutes}:${point.at}`}>
                    <th scope="row">{fullWindowName(series)}</th>
                    <td>{formatInstant(point.at)}</td>
                    <td>{readingText(point.reading)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : null}
      </details>
      {rows.length === 0 ? null : gap !== null ? (
        <div
          className="usage-tooltip usage-tooltip-hoverable"
          onMouseEnter={keepGap}
          onMouseLeave={() => hoverGap(null)}
          ref={tooltip.ref}
          role="status"
          style={tooltip.style}
        >
          <div className="usage-tooltip-title">{gap.window} could not be read</div>
          <div className="usage-tooltip-muted">
            {formatInstant(gap.from)} to {formatInstant(gap.to)}
          </div>
          <div>{gap.text}</div>
        </div>
      ) : instant === null || cursor === null ? null : (
        <div className="usage-tooltip" ref={tooltip.ref} role="status" style={tooltip.style}>
          <div className="usage-tooltip-title">{formatInstant(instant)}</div>
          {rows.map((row) => {
            const reading = instant > end ? undefined : readingAt(row.points, instant)
            return (
              <div key={row.id}>
                {row.name}: <strong>{reading === undefined ? "not read" : readingText(reading)}</strong>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
