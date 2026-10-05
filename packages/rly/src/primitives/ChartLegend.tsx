import type { ComponentPropsWithRef, ReactElement } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import styles from "./ChartLegend.module.css"

const style = (name: string): string => cssClass(styles, name)
/** Chart series slots in assignment order, then the neutral remainder for folded series. */
export const RLY_SERIES: readonly [1, 2, 3, 4, 5, 6, 7, 8, "other"] = [1, 2, 3, 4, 5, 6, 7, 8, "other"]
export type RlySeries = (typeof RLY_SERIES)[number]

/** The CSS colour of a series slot, for SVG fills and swatches alike. */
export const rlySeriesColor = (series: RlySeries): string => `var(--rly-color-series-${series})`

/** One series in a legend: a stable id, the caller's words, and its colour slot. */
export interface RlyChartLegendItem {
  readonly id: string
  readonly label: string
  readonly series: RlySeries
}

type ChartLegendBaseProps = Omit<ComponentPropsWithRef<"ul">, "aria-label" | "children">
export type ChartLegendProps = ChartLegendBaseProps & {
  /** Names the list for assistive technology, for example "Bookings by colour". */
  readonly label: string
  /** The series visible in the chart right now; keep each id on the same slot across updates. */
  readonly items: ReadonlyArray<RlyChartLegendItem>
}

/** Which colour is which series. Shown with every multi-series chart; renders nothing without series. */
export const ChartLegend = ({ className, items, label, ...props }: ChartLegendProps): ReactElement | null =>
  items.length === 0 ? null : (
    <ul
      {...props}
      aria-label={requireText(label, "ChartLegend label")}
      className={classNames(style("root"), className)}
    >
      {items.map((item) => (
        <li className={style("item")} key={item.id}>
          <span
            aria-hidden="true"
            className={style("swatch")}
            data-series={String(item.series)}
            style={{ background: rlySeriesColor(item.series) }}
          />
          {requireText(item.label, "ChartLegend item label")}
        </li>
      ))}
    </ul>
  )
