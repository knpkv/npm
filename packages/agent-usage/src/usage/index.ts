/**
 * `@knpkv/agent-usage/usage` — the agent-usage page's two charts, safe to bundle for a browser: the
 * usage columns in tokens ({@link TokenUsageChart}, stacked by any series the caller names; the
 * page's cost measure is not offered here) and the limit rows ({@link LimitChart}), with the model that stacks cells and keeps colour slots, and the range
 * presets, and the {@link UsageNow} schema `agent-usage usage` prints. Pair it with `@knpkv/agent-usage/usage.css` and Rly's stylesheet. Nothing here reads a
 * file or the network; the caller passes the range and `now`.
 *
 * @module
 */
export { LimitSeries, TokenCell, UsageNow, UsagePreset } from "../shared/contracts.js"
export {
  assignSlots,
  limitLabel,
  NAMED_SERIES,
  OTHER,
  type SeriesCell,
  type StackedUsage,
  stackSeries
} from "./chartModel.js"
export { LimitChart } from "./LimitChart.js"
export { type Preset, PRESETS, rangeOf, type ViewRange } from "./range.js"
export { TokenUsageChart, type TokenUsageChartProps } from "./TokenUsageChart.js"
export { seriesColor } from "./UsageChart.js"
