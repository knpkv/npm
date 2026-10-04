/**
 * Limits over time as small multiples: one row per named window, on the same time axis as the
 * usage columns above, so a jump in a limit sits over the work that caused it. Each row is named
 * where it is drawn, so no line needs a colour to be told apart; a gap says whether the window
 * reset with nobody reading it since or a reading failed.
 *
 * @module
 */
import { useId, useState } from "react"
import type { LimitSeries } from "../shared/contracts.js"
import { PLOT, timeAxis, timeTicks } from "./axis.js"
import { readingAt } from "./chartModel.js"
import { describeReason, formatInstant, formatPercent } from "./format.js"
import { fullWindowName, type LimitRow, limitRows, limitSegments, NEAR_PERCENT } from "./limitsModel.js"
import type { ViewRange } from "./range.js"
import { useWidth } from "./useWidth.js"

const ROW = 56
const ROW_GAP = 12
const AXIS = 24
const LABEL = 16

const Row = (props: {
  readonly row: LimitRow
  readonly top: number
  readonly width: number
  readonly end: number
  readonly x: (at: number) => number
  readonly hatch: string
}) => {
  const plotTop = props.top + LABEL
  const plotHeight = ROW - LABEL
  const y = (percent: number) => plotTop + plotHeight - (Math.min(100, Math.max(0, percent)) / 100) * plotHeight
  const segments = limitSegments(props.row.points, props.end)
  const right = props.width - PLOT.right
  // One stroke and one fill per unbroken run of levels, so adjacent steps leave no seams.
  let line = ""
  let area = ""
  let run: { readonly from: number; readonly to: number } | null = null
  const closeRun = () => {
    if (run !== null) area += `V${y(0)}H${props.x(run.from)}Z`
    run = null
  }
  for (const segment of segments) {
    if (segment.kind !== "level") {
      closeRun()
      continue
    }
    if (run !== null && run.to === segment.from) {
      line += `V${y(segment.usedPercent)}H${props.x(segment.to)}`
      area += `V${y(segment.usedPercent)}H${props.x(segment.to)}`
      run = { from: run.from, to: segment.to }
    } else {
      closeRun()
      const start = `M${props.x(segment.from)},${y(segment.usedPercent)}H${props.x(segment.to)}`
      line += start
      area += start
      run = { from: segment.from, to: segment.to }
    }
  }
  closeRun()
  const finalReading = readingAt(props.row.points, props.end)
  return (
    <g>
      <text className="usage-row-label" x={PLOT.left} y={props.top + 11}>
        {props.row.name}
      </text>
      <text className="usage-row-value" textAnchor="end" x={right} y={props.top + 11}>
        {finalReading === undefined
          ? "—"
          : finalReading._tag === "Known"
            ? formatPercent(finalReading.usedPercent)
            : describeReason(finalReading.reason)}
      </text>
      <line className="usage-grid" x1={PLOT.left} x2={right} y1={y(100)} y2={y(100)} />
      <line className="usage-limit-near" x1={PLOT.left} x2={right} y1={y(NEAR_PERCENT)} y2={y(NEAR_PERCENT)} />
      <path className="usage-limit-area" d={area} />
      {segments.map((segment) =>
        segment.kind === "level" ? null : segment.kind === "unknown" ? (
          <rect
            className="usage-limit-unknown"
            fill={`url(#${props.hatch})`}
            height={plotHeight}
            key={`u${segment.from}`}
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
  const [tableOpen, setTableOpen] = useState(false)
  const hatch = `${useId()}-hatch`
  const axis = timeAxis(props.range, width)
  const rows = limitRows(props.series)
  // A range may run on past now (today ends at midnight); nothing after now has been read yet.
  const end = Math.min(props.range.to, props.now)
  const tabled = props.series.filter((series) => series.label !== "*")

  if (rows.length === 0) {
    return <p className="usage-empty">No limit readings in this range yet.</p>
  }

  const height = rows.length * (ROW + ROW_GAP) + AXIS
  const instant = cursor === null ? null : axis.instantAt(cursor)
  const kinds = new Set(rows.flatMap((row) => limitSegments(row.points, end).map((segment) => segment.kind)))
  const flip = cursor !== null && cursor > width / 2
  return (
    <div className="usage-chart" ref={container}>
      <svg
        aria-labelledby={`${hatch}-title`}
        height={height}
        onMouseLeave={() => setCursor(null)}
        onMouseMove={(event) => {
          const pixel = event.nativeEvent.offsetX
          setCursor(pixel >= PLOT.left && pixel <= width - PLOT.right ? pixel : null)
        }}
        role="img"
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
          <Row end={end} hatch={hatch} key={row.id} row={row} top={index * (ROW + ROW_GAP)} width={width} x={axis.x} />
        ))}
        {timeTicks(props.range, width, 72).map((tick) => (
          <text className="usage-axis-label" key={tick.at} textAnchor="middle" x={axis.x(tick.at)} y={height - 6}>
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
                    <td>
                      {point.reading._tag === "Known"
                        ? formatPercent(point.reading.usedPercent)
                        : describeReason(point.reading.reason)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ) : null}
      </details>
      {instant === null || cursor === null ? null : (
        <div
          className="usage-tooltip"
          role="status"
          style={flip ? { right: width - cursor + 12, top: 0 } : { left: cursor + 12, top: 0 }}
        >
          <div className="usage-tooltip-title">{formatInstant(instant)}</div>
          {rows.map((row) => {
            const reading = instant > end ? undefined : readingAt(row.points, instant)
            return (
              <div key={row.id}>
                {row.name}:{" "}
                <strong>
                  {reading === undefined
                    ? "not read"
                    : reading._tag === "Known"
                      ? formatPercent(reading.usedPercent)
                      : describeReason(reading.reason)}
                </strong>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
