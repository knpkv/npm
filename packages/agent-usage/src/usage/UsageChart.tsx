/**
 * Chart 1: usage per period, stacked by series, in API-equivalent dollars or tokens. On the
 * agent-usage page a series is a Booking; elsewhere (the herdr hub) it is whatever the caller stacked,
 * such as an agent's model, in tokens only.
 *
 * Each period's column is one target for pointer, touch and keyboard alike: hovering, tapping or
 * focusing it shows the same breakdown, and arrow keys, Home and End move between columns with a
 * single tab stop for the chart.
 *
 * @module
 */
import { type KeyboardEvent, useMemo, useRef, useState } from "react"
import type { Period } from "../shared/contracts.js"
import { niceTicks, PLOT, timeAxis } from "./axis.js"
import { type Column, formatAxis, type Measure, OTHER, type StackedUsage } from "./chartModel.js"
import { formatPeriod, formatTokens, formatUsd } from "../limits/format.js"
import type { ViewRange } from "./range.js"
import { useDismissOnEscape, useTooltipPlacement } from "./useTooltipPlacement.js"
import { useWidth } from "./useWidth.js"

const HEIGHT = 260

export const seriesColor = (id: string, slots: ReadonlyMap<string, number>): string =>
  id === OTHER ? "var(--usage-series-other)" : `var(--usage-series-${(slots.get(id) ?? 0) + 1})`

export const formatMeasure = (measure: Measure, value: number): string =>
  measure === "cost" ? formatUsd(value) : formatTokens(value)

/** What a column says aloud: its period, total, and every Booking in it, largest first. */
const describeColumn = (column: Column, label: string, measure: Measure, labelOf: (id: string) => string): string => {
  const parts = [...column.segments]
    .sort((left, right) => right.value - left.value)
    .map((segment) => `${labelOf(segment.id)} ${formatMeasure(measure, segment.value)}`)
  return `${label}: ${formatMeasure(measure, column.total)} total${parts.length === 0 ? "" : `; ${parts.join(", ")}`}`
}

export interface UsageChartProps {
  /** The range's periods, oldest first: one column each. */
  readonly periods: ReadonlyArray<Period>
  readonly stacked: StackedUsage
  readonly range: ViewRange
  readonly measure: Measure
  readonly slots: ReadonlyMap<string, number>
  readonly labelOf: (id: string) => string
  /** The chart's accessible name: what a column is per, and what it is stacked by. */
  readonly label: string
}

export const UsageChart = (props: UsageChartProps) => {
  const [width, container] = useWidth(960)
  // Hover and focus open the breakdown independently; each ends only its own, so moving the pointer
  // off the chart keeps a focused column's breakdown and leaving focus keeps a hovered one.
  const [hovered, setHovered] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const active = hovered ?? focused
  const [focusable, setFocusable] = useState<number | null>(null)
  const targets = useRef(new Map<number, SVGRectElement>())
  const axis = timeAxis(props.range, width)
  const ticks = useMemo(() => niceTicks(props.stacked.max), [props.stacked.max])
  const top = ticks.at(-1) ?? 0
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom
  const y = (value: number) => PLOT.top + plotHeight - (top === 0 ? 0 : (value / top) * plotHeight)
  const { periods } = props
  const { columns } = props.stacked
  // Space labels by how wide they are, so "Mon, Sep 28" never runs into its neighbour on a phone.
  const columnWidth = Math.max(1, (width - PLOT.left - PLOT.right) / Math.max(1, periods.length))
  const labelWidth =
    Math.max(0, ...periods.map((period) => formatPeriod(period.start, props.range.bucket).length)) * 7 + 16
  const labelEvery = Math.max(1, Math.ceil(labelWidth / columnWidth))
  // The tab stop: the column last focused, else the latest one.
  const tabStop = focusable !== null && focusable < columns.length ? focusable : columns.length - 1

  const move = (event: KeyboardEvent<SVGRectElement>, from: number) => {
    const next =
      event.key === "ArrowRight"
        ? Math.min(columns.length - 1, from + 1)
        : event.key === "ArrowLeft"
          ? Math.max(0, from - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? columns.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    setFocusable(next)
    targets.current.get(next)?.focus()
  }

  const activeColumn = active === null ? undefined : columns[active]
  const activePeriod = active === null ? undefined : periods[active]
  const activeCentre =
    activePeriod === undefined
      ? 0
      : (axis.x(activePeriod.start) + axis.x(periods[(active ?? 0) + 1]?.start ?? props.range.to)) / 2
  const tooltip = useTooltipPlacement(activePeriod === undefined ? null : activeCentre, width, PLOT.top)
  useDismissOnEscape(active !== null, () => {
    setHovered(null)
    setFocused(null)
  })

  return (
    <div className="usage-chart" ref={container}>
      <svg aria-label={props.label} height={HEIGHT} onMouseLeave={() => setHovered(null)} role="group" width={width}>
        {ticks.map((tick) => (
          <g aria-hidden="true" key={tick}>
            <line className="usage-grid" x1={PLOT.left} x2={width - PLOT.right} y1={y(tick)} y2={y(tick)} />
            <text className="usage-axis-label" textAnchor="end" x={PLOT.left - 8} y={y(tick) + 4}>
              {formatAxis(props.measure, tick, ticks[1] ?? tick)}
            </text>
          </g>
        ))}
        {columns.map((column) => {
          const period = periods[column.period]
          if (period === undefined) return null
          const end = periods[column.period + 1]?.start ?? props.range.to
          const left = axis.x(period.start) + 1
          const barWidth = Math.max(1, axis.x(end) - axis.x(period.start) - 2)
          const label = formatPeriod(period.start, props.range.bucket)
          return (
            <g key={period.key}>
              <g aria-hidden="true" data-active={active === column.period}>
                {column.segments.map((segment, index) => {
                  const yTop = y(segment.from + segment.value)
                  // A 2px surface gap between stacked segments; the topmost keeps its rounded end.
                  const height = Math.max(1, y(segment.from) - yTop - (index === 0 ? 0 : 2))
                  return (
                    <rect
                      className="usage-segment"
                      fill={seriesColor(segment.id, props.slots)}
                      height={height}
                      key={segment.id}
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
                    {label}
                  </text>
                ) : null}
              </g>
              <rect
                aria-label={describeColumn(column, label, props.measure, props.labelOf)}
                className="usage-column-target"
                height={plotHeight}
                onBlur={() => setFocused(null)}
                onFocus={() => {
                  setFocusable(column.period)
                  setFocused(column.period)
                }}
                onKeyDown={(event) => move(event, column.period)}
                onMouseEnter={() => setHovered(column.period)}
                onPointerDown={() => setHovered(column.period)}
                ref={(element) => {
                  if (element === null) targets.current.delete(column.period)
                  else targets.current.set(column.period, element)
                }}
                role="img"
                tabIndex={column.period === tabStop ? 0 : -1}
                width={Math.max(1, axis.x(end) - axis.x(period.start))}
                x={axis.x(period.start)}
                y={PLOT.top}
              />
            </g>
          )
        })}
        <line
          aria-hidden="true"
          className="usage-baseline"
          x1={PLOT.left}
          x2={width - PLOT.right}
          y1={y(0)}
          y2={y(0)}
        />
      </svg>
      {activeColumn === undefined || activePeriod === undefined ? null : (
        <div className="usage-tooltip" ref={tooltip.ref} role="status" style={tooltip.style}>
          <div className="usage-tooltip-title">{formatPeriod(activePeriod.start, props.range.bucket)}</div>
          {[...activeColumn.segments].reverse().map((segment) => (
            <div className="usage-tooltip-row" key={segment.id}>
              <span className="usage-swatch" style={{ background: seriesColor(segment.id, props.slots) }} />
              {props.labelOf(segment.id)} <strong>{formatMeasure(props.measure, segment.value)}</strong>
            </div>
          ))}
          <div className="usage-tooltip-muted">Total {formatMeasure(props.measure, activeColumn.total)}</div>
        </div>
      )}
    </div>
  )
}
