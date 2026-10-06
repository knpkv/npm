import type { ComponentPropsWithRef, KeyboardEvent, ReactElement, Ref, RefCallback } from "react"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import * as Predicate from "../internal/predicates.js"
import {
  binColumns,
  binRates,
  chartTicks,
  chooseBinSize,
  moveFocus,
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
  /** A dashed mark at `level` percent, named in the key under the axis by `label` ("Near the limit, 80%"). */
  readonly near?: RlyBandMark
}

/** A level worth marking on a band, with the key text that names it. */
export interface RlyBandMark {
  readonly level: number
  readonly label: string
}

/** A stretch of the time axis to shade behind the bars and bands, named in a key under the axis. */
export interface RlyChartWindow {
  readonly from: number
  readonly to: number
  /** What the stretch is, for example "Current 5-hour window, resets 14:57". */
  readonly label: string
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
  /** A stretch of time to shade across the bands and bars, such as the current limit window. */
  readonly window?: RlyChartWindow
  /** Key text for band stretches with no reading ("No reading"); required when any band has one. */
  readonly noReadingLabel?: string
  /**
   * The caption for the scale: the tallest bar's rate per `binSize` columns. Bars plot rates, so a
   * folded or longer bin reads true against "per N hours".
   */
  readonly formatScale: (max: number, binSize: number) => string
  /** The axis label for a bin. */
  /** The axis label for an instant: a bin's start, or the axis end for the right-hand label. */
  readonly formatTick: (at: number, binSize: number) => string
  readonly selection: RlyChartSelection | null
  readonly onSelectionChange: (selection: RlyChartSelection | null) => void
  /** What the selection means, announced politely once it settles. */
  readonly describeSelection: (selection: RlyChartSelection | null) => string
  /** Plot height in pixels, without bands and axis; never under 24, since every bar is a pointer target. */
  readonly height?: number
}

const LABEL_WIDTH = 72
const ANNOUNCE_AFTER = 500
const MIN_TARGET = 24

/**
 * Hand the element to a caller's object or callback ref and return how to detach it: a React 19
 * callback ref's own cleanup when it returns one, otherwise the ref called (or set) with null.
 */
const attachRef = (ref: Ref<HTMLDivElement> | undefined, element: HTMLDivElement): (() => void) => {
  if (Predicate.isFunction(ref)) {
    const cleanup = ref(element)
    return Predicate.isFunction(cleanup) ? cleanup : () => ref(null)
  }
  if (ref === null || ref === undefined) return () => undefined
  ref.current = element
  return () => {
    ref.current = null
  }
}

/** Measures the root's inline size while still handing the root to the caller's ref. */
const useInlineSize = (
  fallback: number,
  callerRef: Ref<HTMLDivElement> | undefined
): readonly [number, RefCallback<HTMLDivElement>] => {
  const [size, setSize] = useState(fallback)
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null) return
      const detach = attachRef(callerRef, element)
      const observer = new ResizeObserver(([entry]) => {
        if (entry !== undefined) setSize(entry.contentRect.width)
      })
      observer.observe(element)
      return () => {
        observer.disconnect()
        detach()
      }
    },
    [callerRef]
  )
  return [size, ref]
}

/** A stretch of the plot on the shared 0–1000 time scale. */
interface AxisSpan {
  readonly x: number
  readonly width: number
}

/** Where an instant falls on the time axis, from 0 to 1, clamped to the drawn range. */
const axisFraction = (at: number, from: number, to: number): number =>
  Math.max(0, Math.min(1, (at - from) / Math.max(1, to - from)))

const Band = ({
  band,
  from,
  to,
  window
}: {
  readonly band: RlyStepBand
  readonly from: number
  readonly to: number
  readonly window: RlyChartWindow | undefined
}) => {
  const x = (at: number): number => axisFraction(at, from, to) * 1000
  const near = band.near?.level
  return (
    <div className={style("band")} data-band={band.id}>
      <span className={style("bandLabel")}>{requireText(band.label, "StackedBars band label")}</span>
      <svg aria-hidden="true" className={style("bandPlot")} preserveAspectRatio="none" viewBox="0 0 1000 100">
        {window === undefined ? null : (
          <rect
            className={style("window")}
            data-part="window"
            height={100}
            width={Math.max(0, x(window.to) - x(window.from))}
            x={x(window.from)}
          />
        )}
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
              data-tone={level >= 100 ? "full" : near !== undefined && level >= near ? "near" : "ok"}
              height={level}
              key={segment.from}
              width={width}
              x={left}
              y={100 - level}
            />
          )
        })}
        {near === undefined ? null : (
          <line className={style("near")} x1={0} x2={1000} y1={100 - near} y2={100 - near} />
        )}
        {/* The window's edges again over the levels, so a full or unknown stretch never hides it. */}
        {window === undefined ? null : (
          <rect
            className={style("windowEdge")}
            data-part="window-edge"
            height={100}
            width={Math.max(0, x(window.to) - x(window.from))}
            x={x(window.from)}
          />
        )}
      </svg>
    </div>
  )
}

/**
 * Stacked values per period on a time axis, with optional limit bands above. Bars, bands, the window
 * and the selection share one time scale, so a short final bin is drawn narrower. Narrow containers
 * bin periods so every bar stays at least 24px wide, a full pointer target; the selection keeps its columns across rebinning.
 * One tab stop: ←/→ move and select, Shift extends, Home/End jump, Escape clears. Click selects;
 * Shift+click, or a second touch tap elsewhere, extends. The SVG is hidden from assistive technology,
 * so callers render the same data beside it: a table at a readable resolution (a row per day for a
 * week of hours), a table of each band's intervals, and a `describeSelection` that names every
 * series' value in the span, so arrowing through the plot reaches each period's numbers.
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
  noReadingLabel,
  onSelectionChange,
  ref: callerRef,
  selection,
  window,
  ...props
}: StackedBarsProps): ReactElement => {
  const [width, ref] = useInlineSize(720, callerRef)
  const instructionsId = useId()
  // Bars are pointer targets, so each is at least 24px wide (WCAG 2.2 target size).
  const binSize = chooseBinSize(width, columns, MIN_TARGET)
  const bins = useMemo(() => binColumns(columns, binSize), [columns, binSize])
  // Heights are rates per nominal bin, so a longer (folded) bin is not taller just for holding more time.
  const rates = binRates(bins, columns, binSize)
  const max = Math.max(0, ...bins.map(({ total }, index) => total * (rates[index] ?? 1)))
  // Everything the bands draw is named in the key: each distinct near mark, and "no reading" if any.
  const nearLabels = [
    ...new Set(
      bands.flatMap((band) => (band.near === undefined ? [] : [requireText(band.near.label, "StackedBars near label")]))
    )
  ]
  const hasNoReading = bands.some((band) => band.segments.some((segment) => segment.level === null))
  const noReading = hasNoReading
    ? requireText(noReadingLabel ?? "", "StackedBars noReadingLabel (a band has a stretch with no reading)")
    : undefined
  const axisStart = columns[0]?.start ?? 0
  const axisEnd = columns[columns.length - 1]?.end ?? axisStart
  const ticks = chartTicks(
    bins.map((bin) => axisFraction(bin.start, axisStart, axisEnd) * width),
    width,
    LABEL_WIDTH
  )
  // The keyboard cursor is a column, so a click or a resize that rebins keeps it on the same time.
  const [cursor, setCursor] = useState<number | null>(null)
  // The first touch tap's column, so a rebin between taps still compares the same instant.
  const [pendingTap, setPendingTap] = useState<number | null>(null)
  // Only a touch tap may extend by tapping again; a mouse extends with Shift.
  const pointerType = useRef("mouse")
  const [announcement, setAnnouncement] = useState("")
  // The words, not the formatter's identity, decide when to announce, so parent renders don't postpone it.
  const description = describeSelection(selection)
  const binOf = (column: number): number => Math.min(bins.length - 1, Math.floor(column / binSize))
  const focus = cursor === null ? null : binOf(cursor)

  useEffect(() => {
    // Empty the region while the new words settle, so returning to the last announced selection is
    // announced again rather than left as an unchanged region.
    setAnnouncement("")
    const timer = setTimeout(() => setAnnouncement(description), ANNOUNCE_AFTER)
    return () => clearTimeout(timer)
  }, [description])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      if (selection === null) return
      event.preventDefault()
      setCursor(null)
      setPendingTap(null)
      onSelectionChange(null)
      return
    }
    // An empty chart has nothing to move to, so the browser keeps Home, End and the arrows.
    if (bins.length === 0) return
    const current = focus ?? (selection === null ? bins.length - 1 : binOf(selection.to))
    const next = moveFocus(event.key, current, bins.length - 1)
    if (next === null) return
    event.preventDefault()
    setCursor(bins[next]?.first ?? null)
    // The keyboard now owns the anchor, so a later tap starts a new touch span.
    setPendingTap(null)
    onSelectionChange(selectBin(selection, bins, next, event.shiftKey))
  }

  const from = columns[0]?.start ?? 0
  const to = columns[columns.length - 1]?.end ?? from
  // One time scale for everything drawn: the bands' 0–1000 viewBox, from the first column's start.
  const x = (at: number): number => axisFraction(at, from, to) * 1000
  const span = (start: number, end: number): AxisSpan => ({
    width: Math.max(0, x(end) - x(start)),
    x: x(start)
  })
  const shaded = window === undefined ? null : span(window.from, window.to)
  // The selection is drawn once from its own columns, behind the bars, so its edges stay visible
  // where the bars cover its fill and it survives a resize that rebins the columns.
  const selectionStart = selection === null ? undefined : columns[Math.max(0, selection.from)]
  const selectionEnd = selection === null ? undefined : columns[Math.min(columns.length - 1, selection.to)]
  const selected =
    selectionStart === undefined || selectionEnd === undefined ? null : span(selectionStart.start, selectionEnd.end)

  return (
    <div {...props} className={classNames(style("root"), className)} ref={ref}>
      {bands.map((band) => (
        <Band band={band} from={from} key={band.id} to={to} window={window} />
      ))}
      <div
        aria-describedby={instructionsId}
        aria-label={requireText(label, "StackedBars label")}
        aria-roledescription="chart"
        className={style("plot")}
        onBlur={() => setCursor(null)}
        onKeyDown={onKeyDown}
        role="group"
        style={{ blockSize: `${Math.max(MIN_TARGET, height)}px` }}
        tabIndex={0}
      >
        <span className={style("scale")}>{formatScale(max, binSize)}</span>
        <svg aria-hidden="true" className={style("bars")} preserveAspectRatio="none" viewBox="0 0 1000 100">
          {shaded === null || shaded.width <= 0 ? null : (
            <rect className={style("window")} data-part="window" height={100} width={shaded.width} x={shaded.x} />
          )}
          {selected === null || selected.width <= 0 ? null : (
            <rect
              className={style("selection")}
              data-part="selection"
              height={100}
              width={selected.width}
              x={selected.x}
            />
          )}
          {bins.map((bin, index) => {
            const slot = span(bin.start, bin.end)
            const inSelection = selection !== null && bin.last >= selection.from && bin.first <= selection.to
            return (
              <g
                data-focused={focus === index ? "true" : undefined}
                data-selected={inSelection ? "true" : undefined}
                key={bin.first}
                onClick={(event) => {
                  const touch = pointerType.current === "touch"
                  // A second tap extends only a live selection; a cleared one starts a new gesture.
                  const extend =
                    event.shiftKey ||
                    (touch &&
                      selection !== null &&
                      pendingTap !== null &&
                      (pendingTap < bin.first || pendingTap > bin.last))
                  onSelectionChange(selectBin(selection, bins, index, extend))
                  setCursor(bin.first)
                  setPendingTap(touch && !extend ? bin.first : null)
                }}
                onPointerDown={(event) => {
                  pointerType.current = event.pointerType
                }}
              >
                <rect className={style("hit")} height={100} width={slot.width} x={slot.x} />
                {bin.segments.map((segment) => {
                  const rate = rates[index] ?? 1
                  const top = max === 0 ? 0 : (((segment.offset + segment.value) * rate) / max) * 88
                  const size = max === 0 ? 0 : ((segment.value * rate) / max) * 88
                  return (
                    <rect
                      className={style("segment")}
                      data-series={String(segment.series)}
                      fill={rlySeriesColor(segment.series)}
                      height={size}
                      key={segment.id}
                      width={slot.width}
                      x={slot.x}
                      y={100 - top}
                    />
                  )
                })}
                <rect className={style("focusRing")} height={100} width={slot.width} x={slot.x} />
              </g>
            )
          })}
          {/* The window's edges again over the bars, so a narrow window stays visible where bars cover its fill. */}
          {shaded === null || shaded.width <= 0 ? null : (
            <rect
              className={style("windowEdge")}
              data-part="window-edge"
              height={100}
              width={shaded.width}
              x={shaded.x}
            />
          )}
        </svg>
      </div>
      <div aria-hidden="true" className={style("axis")}>
        {ticks.map((tick) => {
          const at = tick.anchor === "end" ? axisEnd : bins[tick.index]?.start
          if (at === undefined) return null
          return (
            <span
              className={style("tick")}
              data-anchor={tick.anchor}
              key={tick.anchor === "end" ? "end" : tick.index}
              // Physical sides, like the SVG's x axis, so labels stay under their bars in right-to-left text.
              style={tick.anchor === "end" ? { right: 0 } : { left: `${x(at) / 10}%` }}
            >
              {formatTick(at, binSize)}
            </span>
          )
        })}
      </div>
      {window === undefined && nearLabels.length === 0 && noReading === undefined ? null : (
        // Markerless flex lists lose list semantics in WebKit, so the role is restated.
        <ul className={style("keys")} role="list">
          {window === undefined ? null : (
            <li className={style("windowKey")}>
              <span aria-hidden="true" className={style("windowSwatch")} />
              {requireText(window.label, "StackedBars window label")}
            </li>
          )}
          {nearLabels.map((text) => (
            <li className={style("windowKey")} key={text}>
              <span aria-hidden="true" className={style("nearSwatch")} />
              {text}
            </li>
          ))}
          {noReading === undefined ? null : (
            <li className={style("windowKey")}>
              <span aria-hidden="true" className={style("unknownSwatch")} />
              {noReading}
            </li>
          )}
        </ul>
      )}
      <p className={style("hidden")} id={instructionsId}>
        {requireText(instructions, "StackedBars instructions")}
      </p>
      <p aria-live="polite" className={style("hidden")}>
        {announcement}
      </p>
    </div>
  )
}
