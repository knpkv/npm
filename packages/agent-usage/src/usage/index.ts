/**
 * `@knpkv/agent-usage/usage` — the agent-usage page's two charts, safe to bundle for a browser: the
 * usage columns ({@link UsageChart}, stacked by any series the caller names) and the limit rows
 * ({@link LimitChart}), with the model that stacks cells and keeps colour slots, and the range
 * presets. Pair it with `@knpkv/agent-usage/usage.css` and Rly's stylesheet. Nothing here reads a
 * file or the network; the caller passes the range and `now`.
 *
 * @module
 */
export {
  assignSlots,
  limitLabel,
  type Measure,
  NAMED_SERIES,
  OTHER,
  type SeriesCell,
  type StackedUsage,
  stackSeries
} from "./chartModel.js"
export { LimitChart } from "./LimitChart.js"
export { type Preset, PRESETS, rangeOf, type ViewRange } from "./range.js"
export { formatMeasure, seriesColor, UsageChart } from "./UsageChart.js"
