/**
 * Chart 2: each Limit Window's used percentage as a step line, on the same time axis as the usage
 * columns above it, so a jump in a limit sits over the work that caused it.
 *
 * @module
 */
import { useState } from "react"
import type { LimitSeries } from "../shared/contracts.js"
import { PLOT, timeAxis } from "./axis.js"
import { limitLabel, readingAt, stepPath } from "./chartModel.js"
import { describeReason, formatInstant, formatPercent } from "./format.js"
import type { ViewRange } from "./range.js"
import { useWidth } from "./useWidth.js"

const HEIGHT = 180
const PERCENT_TICKS = [0, 25, 50, 75, 100]

export const LimitChart = (props: { readonly series: ReadonlyArray<LimitSeries>; readonly range: ViewRange }) => {
  const [width, container] = useWidth(960)
  const [cursor, setCursor] = useState<number | null>(null)
  const axis = timeAxis(props.range, width)
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom
  const y = (percent: number) => PLOT.top + plotHeight - (Math.min(100, Math.max(0, percent)) / 100) * plotHeight
  // The source-wide Unknown series has no level to draw; the tiles carry its reason.
  const drawn = props.series.filter((series) => series.label !== "*")

  if (drawn.length === 0) {
    return <p className="usage-empty">No limit readings in this range yet.</p>
  }

  const instant = cursor === null ? null : axis.instantAt(cursor)
  return (
    <div className="usage-chart" ref={container}>
      <svg
        aria-label="Subscription limits used, percent"
        height={HEIGHT}
        onMouseLeave={() => setCursor(null)}
        onMouseMove={(event) => {
          const pixel = event.nativeEvent.offsetX
          setCursor(pixel >= PLOT.left && pixel <= width - PLOT.right ? pixel : null)
        }}
        role="img"
        width={width}
      >
        {PERCENT_TICKS.map((tick) => (
          <g key={tick}>
            <line className="usage-grid" x1={PLOT.left} x2={width - PLOT.right} y1={y(tick)} y2={y(tick)} />
            <text className="usage-axis-label" textAnchor="end" x={PLOT.left - 8} y={y(tick) + 4}>
              {tick}%
            </text>
          </g>
        ))}
        {drawn.map((series, index) => (
          <path
            className="usage-limit-line"
            d={stepPath(series.points, props.range.to, axis.x, y)}
            key={`${series.agent}:${series.label}`}
            stroke={`var(--usage-series-${(index % 8) + 1})`}
          />
        ))}
        {cursor === null ? null : (
          <line className="usage-crosshair" x1={cursor} x2={cursor} y1={PLOT.top} y2={HEIGHT - PLOT.bottom} />
        )}
      </svg>
      <ul className="usage-legend" aria-label="Limit windows">
        {drawn.map((series, index) => (
          <li key={`${series.agent}:${series.label}`}>
            <span className="usage-swatch" style={{ background: `var(--usage-series-${(index % 8) + 1})` }} />
            {limitLabel(series.agent, series.label, series.windowMinutes)}
          </li>
        ))}
      </ul>
      {instant === null || cursor === null ? null : (
        <div className="usage-tooltip" role="status" style={{ left: cursor + 12, top: PLOT.top }}>
          <div className="usage-tooltip-title">{formatInstant(instant)}</div>
          {drawn.map((series) => {
            const reading = readingAt(series.points, instant)
            return (
              <div key={`${series.agent}:${series.label}`}>
                {limitLabel(series.agent, series.label, series.windowMinutes)}:{" "}
                <strong>
                  {reading === undefined
                    ? "no reading"
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
