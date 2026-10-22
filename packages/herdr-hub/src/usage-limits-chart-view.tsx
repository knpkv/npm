import { Icon } from "@knpkv/rly/foundations"
import type { ReactElement } from "react"
import type { LimitsChart } from "./usage-limits-chart.js"

/**
 * The Limits page's token chart (06 Usage): every bar prints its value, and the legend says each tool's total in
 * text, so nothing is told by colour alone. The figure's accessible name reads every bar; the drawing is hidden.
 */
export const UsageLimitsChart = ({
  chart,
  overview
}: {
  readonly chart: LimitsChart
  /** Where "Fleet token overview" leads: the Tokens page. */
  readonly overview: string
}): ReactElement => (
  <figure className="usage-limits-chart" aria-label={chart.label} data-region="detail">
    <div className="usage-limits-chart-head">
      <h2>{chart.title}</h2>
      <a href={overview}>
        Fleet token overview
        <Icon name="chevron-right" size="small" decorative />
      </a>
    </div>
    <div
      className="usage-limits-bars"
      aria-hidden="true"
      style={{ gridTemplateColumns: `repeat(${String(chart.bars.length)}, minmax(0, 1fr))` }}
    >
      {chart.bars.map((bar, index) => (
        <div key={index} className="usage-limits-bar">
          <span className="usage-limits-bar-value">{bar.value}</span>
          <span className="usage-limits-bar-fill" style={{ blockSize: `${String(bar.height)}px` }} />
          <span className="usage-limits-bar-period">{bar.period}</span>
        </div>
      ))}
    </div>
    <figcaption>
      {chart.legend.map((entry) => (
        <span
          key={entry.text}
          data-total={entry.total ? "true" : undefined}
          data-unknown={entry.unknown ? "true" : undefined}
        >
          {entry.text}
        </span>
      ))}
    </figcaption>
  </figure>
)
