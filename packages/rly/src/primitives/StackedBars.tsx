import type { ComponentPropsWithRef, KeyboardEvent, ReactElement, RefObject } from "react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import {
  binColumns,
  chartTicks,
  chooseBinSize,
  moveFocus,
  type RlyChartBin,
  type RlyChartColumn,
  type RlyChartSelection,
  selectBin
} from "../internal/chart.js"
import { rlySeriesColor } from "./ChartLegend.js"
import styles from "./StackedBars.module.css"

const style = (name: string): string => cssClass(styles, name)
export type { RlyChartBin, RlyChartColumn, RlyChartSegment, RlyChartSelection } from "../internal/chart.js"

/** A level over time above the bars, on the same axis; `level: null` is a stretch with no reading. */
export interface RlyStepBand {
  readonly id: string
  readonly label: string
  readonly segments: ReadonlyArray<{ readonly from: number; readonly to: number; readonly level: number | null }>
  /** Draw a dashed mark at this level, in percent. */
  readonly near?: number
}

type StackedBarsBaseProps = Omit<ComponentPropsWithRef<"div">, "aria-label" | "children" | "onChange">
export type StackedBarsProps = StackedBarsBaseProps & {
  /** Names the chart, for example "Spend by booking". */
  readonly label: string
  /** How to read and operate the chart, in the caller's words; read after the label. */
  readonly instructions: string
  readonly columns: ReadonlyArray<RlyChartColumn>
  /** Bands of limit levels drawn above the bars, sharing their time axis. */
  readonly bands?: ReadonlyArray<RlyStepBand>
  /** The caption for the scale, given the tallest bin's total and the bin size in columns. */
  readonly formatScale: (max: number, binSize: number) => string
  /** The axis label for a bin. */
  readonly formatTick: (bin: RlyChartBin, binSize: number) => string
  readonly selection: RlyChartSelection | null
  readonly onSelectionChange: (selection: RlyChartSelection | null) => void
  /** What the selection means, announced politely once it settles. */
  readonly describeSelection: (selection: RlyChartSelection | null) => string
  /** Plot height in pixels, without bands and axis. */
  readonly height?: number
}

const LABEL_WIDTH = 72
const ANNOUNCE_AFTER = 500

const useInlineSize = (fallback: number): readonly [number, RefObject<HTMLDivElement | null>] => {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(fallback)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setSize(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [size, ref]
}

const Band = ({ band, from, to }: { readonly band: RlyStepBand; readonly from: number; readonly to: number }) => {
  const span = Math.max(1, to - from)
  const x = (at: number): number => Math.max(0, Math.min(1000, ((at - from) / span) * 1000))
  return (
    <div className={style("band")} data-band={band.id}>
      <span className={style("bandLabel")}>{requireText(band.label, "StackedBars band label")}</span>
      <svg aria-hidden="true" className={style("bandPlot")} preserveAspectRatio="none" viewBox="0 0 1000 100">
        {band.segments.map((segment) => {
          const left = x(segment.from)
          const width = x(segment.to) - left
          if (width <= 0) return null
          if (segment.level === null) {
            return <rect className={style("unknown")} height={100} key={segment.from} width={width} x={left} />
          }
          const level = Math.min(100, Math.max(0, segment.level))
          return (
            <rect
              className={style("level")}
              data-tone={level >= 100 ? "full" : band.near !== undefined && level >= band.near ? "near" : "ok"}
              height={level}
              key={segment.from}
              width={width}
              x={left}
              y={100 - level}
            />
          )
        })}
        {band.near === undefined ? null : (
          <line className={style("near")} x1={0} x2={1000} y1={100 - band.near} y2={100 - band.near} />
        )}
      </svg>
    </div>
  )
}

/**
 * Stacked values per period on a time axis, with optional limit bands above. Narrow containers bin
 * periods so every bar stays at least 6px wide. One tab stop: ←/→ move and select, Shift extends,
 * Home/End jump, Escape clears. Click selects; Shift+click, or a second tap elsewhere, extends.
 */
export const StackedBars = ({
  bands = [],
  className,
  columns,
  describeSelection,
  formatScale,
  formatTick,
  height = 180,
  instructions,
  label,
  onSelectionChange,
  selection,
  ...props
}: StackedBarsProps): ReactElement => {
  const [width, ref] = useInlineSize(720)
  const instructionsId = useId()
  const binSize = chooseBinSize(width, columns.length)
  const bins = useMemo(() => binColumns(columns, binSize), [columns, binSize])
  const max = Math.max(0, ...bins.map(({ total }) => total))
  const ticks = chartTicks(bins.length, width, LABEL_WIDTH)
  const [focus, setFocus] = useState<number | null>(null)
  const [pendingTap, setPendingTap] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const binOf = (column: number): number => Math.floor(column / binSize)

  useEffect(() => {
    const timer = setTimeout(() => setAnnouncement(describeSelection(selection)), ANNOUNCE_AFTER)
    return () => clearTimeout(timer)
  }, [describeSelection, selection])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      if (selection === null) return
      event.preventDefault()
      setFocus(null)
      onSelectionChange(null)
      return
    }
    const current = focus ?? (selection === null ? bins.length - 1 : binOf(selection.to))
    const next = moveFocus(event.key, current, bins.length - 1)
    if (next === null) return
    event.preventDefault()
    setFocus(next)
    onSelectionChange(selectBin(selection, bins, next, event.shiftKey))
  }

  const from = columns[0]?.start ?? 0
  const to = columns[columns.length - 1]?.end ?? from
  const percent = (index: number): string => `${(index / Math.max(1, bins.length)) * 100}%`

  return (
    <div {...props} className={classNames(style("root"), className)} ref={ref}>
      {bands.map((band) => (
        <Band band={band} from={from} key={band.id} to={to} />
      ))}
      <div
        aria-describedby={instructionsId}
        aria-label={requireText(label, "StackedBars label")}
        aria-roledescription="chart"
        className={style("plot")}
        onBlur={() => setFocus(null)}
        onKeyDown={onKeyDown}
        role="group"
        style={{ blockSize: `${height}px` }}
        tabIndex={0}
      >
        <span className={style("scale")}>{formatScale(max, binSize)}</span>
        <svg
          aria-hidden="true"
          className={style("bars")}
          preserveAspectRatio="none"
          viewBox={`0 0 ${Math.max(1, bins.length)} 100`}
        >
          {bins.map((bin, index) => {
            const selected = selection !== null && bin.first >= selection.from && bin.last <= selection.to
            return (
              <g
                data-focused={focus === index ? "true" : undefined}
                data-selected={selected ? "true" : undefined}
                key={bin.first}
                onClick={(event) => {
                  const extend = event.shiftKey || (pendingTap !== null && pendingTap !== index)
                  onSelectionChange(selectBin(selection, bins, index, extend))
                  setPendingTap(extend ? null : index)
                }}
              >
                <rect className={style("hit")} height={100} width={1} x={index} />
                {bin.segments.map((segment) => {
                  const top = max === 0 ? 0 : ((segment.offset + segment.value) / max) * 88
                  const size = max === 0 ? 0 : (segment.value / max) * 88
                  return (
                    <rect
                      className={style("segment")}
                      data-series={String(segment.series)}
                      fill={rlySeriesColor(segment.series)}
                      height={size}
                      key={segment.id}
                      width={1}
                      x={index}
                      y={100 - top}
                    />
                  )
                })}
                <rect className={style("focusRing")} height={100} width={1} x={index} />
              </g>
            )
          })}
        </svg>
      </div>
      <div aria-hidden="true" className={style("axis")}>
        {ticks.map((tick) => {
          const bin = bins[tick.index]
          if (bin === undefined) return null
          return (
            <span
              className={style("tick")}
              data-anchor={tick.anchor}
              key={tick.index}
              style={tick.anchor === "end" ? { insetInlineEnd: 0 } : { insetInlineStart: percent(tick.index) }}
            >
              {formatTick(bin, binSize)}
            </span>
          )
        })}
      </div>
      <p className={style("hidden")} id={instructionsId}>
        {requireText(instructions, "StackedBars instructions")}
      </p>
      <p aria-live="polite" className={style("hidden")}>
        {announcement}
      </p>
    </div>
  )
}
