/**
 * Chart 1: usage per period, stacked by Booking, in API-equivalent dollars or tokens.
 *
 * @module
 */
import { useMemo, useRef, useState } from "react"
import type { UsageReport } from "../shared/contracts.js"
import { niceTicks, PLOT, timeAxis } from "./axis.js"
import { type Measure, OTHER, type StackedUsage } from "./chartModel.js"
import { formatPeriod, formatTokens, formatUsd } from "./format.js"
import type { ViewRange } from "./range.js"
import { useWidth } from "./useWidth.js"

const HEIGHT = 260

export const seriesColor = (id: string, slots: ReadonlyMap<string, number>): string =>
  id === OTHER ? "var(--usage-series-other)" : `var(--usage-series-${(slots.get(id) ?? 0) + 1})`

interface Hover {
  readonly period: number
  readonly id: string
  readonly left: number
  readonly top: number
}

export const formatMeasure = (measure: Measure, value: number): string =>
  measure === "cost" ? formatUsd(value) : formatTokens(value)

export const UsageChart = (props: {
  readonly report: UsageReport
  readonly stacked: StackedUsage
  readonly range: ViewRange
  readonly measure: Measure
  readonly slots: ReadonlyMap<string, number>
  readonly labelOf: (id: string) => string
}) => {
  const container = useRef<HTMLDivElement>(null)
  const width = useWidth(container, 960)
  const [hover, setHover] = useState<Hover | null>(null)
  const axis = timeAxis(props.range, width)
  const ticks = useMemo(() => niceTicks(props.stacked.max), [props.stacked.max])
  const top = ticks.at(-1) ?? 0
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom
  const y = (value: number) => PLOT.top + plotHeight - (top === 0 ? 0 : (value / top) * plotHeight)
  const { periods } = props.report
  const labelEvery = Math.max(1, Math.ceil(periods.length / Math.max(1, Math.floor(width / 72))))

  return (
    <div className="usage-chart" ref={container}>
      <svg aria-label={`Usage per ${props.range.bucket}, stacked by booking`} height={HEIGHT} role="img" width={width}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="usage-grid" x1={PLOT.left} x2={width - PLOT.right} y1={y(tick)} y2={y(tick)} />
            <text className="usage-axis-label" textAnchor="end" x={PLOT.left - 8} y={y(tick) + 4}>
              {formatMeasure(props.measure, tick)}
            </text>
          </g>
        ))}
        {props.stacked.columns.map((column) => {
          const period = periods[column.period]
          if (period === undefined) return null
          const end = periods[column.period + 1]?.start ?? props.range.to
          const left = axis.x(period.start) + 1
          const barWidth = Math.max(1, axis.x(end) - axis.x(period.start) - 2)
          return (
            <g key={period.key}>
              {column.segments.map((segment, index) => {
                const yTop = y(segment.from + segment.value)
                // A 2px surface gap between stacked segments; the topmost keeps its rounded end.
                const height = Math.max(1, y(segment.from) - yTop - (index === 0 ? 0 : 2))
                return (
                  <rect
                    className="usage-segment"
                    data-hovered={hover?.period === column.period && hover.id === segment.id}
                    fill={seriesColor(segment.id, props.slots)}
                    height={height}
                    key={segment.id}
                    onMouseLeave={() => setHover(null)}
                    onMouseMove={(event) =>
                      setHover({
                        period: column.period,
                        id: segment.id,
                        left: event.nativeEvent.offsetX,
                        top: event.nativeEvent.offsetY
                      })
                    }
                    rx={index === column.segments.length - 1 ? Math.min(4, barWidth / 2) : 0}
                    width={barWidth}
                    x={left}
                    y={yTop}
                  />
                )
              })}
              {column.period % labelEvery === 0 ? (
                <text
                  className="usage-axis-label"
                  textAnchor="middle"
                  x={left + barWidth / 2}
                  y={HEIGHT - PLOT.bottom + 18}
                >
                  {formatPeriod(period.start, props.range.bucket)}
                </text>
              ) : null}
            </g>
          )
        })}
        <line className="usage-baseline" x1={PLOT.left} x2={width - PLOT.right} y1={y(0)} y2={y(0)} />
      </svg>
      {hover === null ? null : <UsageTooltip {...props} hover={hover} />}
    </div>
  )
}

const UsageTooltip = (props: {
  readonly hover: Hover
  readonly stacked: StackedUsage
  readonly report: UsageReport
  readonly range: ViewRange
  readonly measure: Measure
  readonly labelOf: (id: string) => string
}) => {
  const column = props.stacked.columns[props.hover.period]
  const segment = column?.segments.find((candidate) => candidate.id === props.hover.id)
  const period = props.report.periods[props.hover.period]
  if (column === undefined || segment === undefined || period === undefined) return null
  return (
    <div className="usage-tooltip" role="status" style={{ left: props.hover.left + 12, top: props.hover.top + 12 }}>
      <div className="usage-tooltip-title">{formatPeriod(period.start, props.range.bucket)}</div>
      <div>
        {props.labelOf(segment.id)}: <strong>{formatMeasure(props.measure, segment.value)}</strong>
      </div>
      <div className="usage-tooltip-muted">Total {formatMeasure(props.measure, column.total)}</div>
    </div>
  )
}
