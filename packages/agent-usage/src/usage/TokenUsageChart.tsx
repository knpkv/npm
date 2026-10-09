/**
 * {@link UsageChart} for a surface that only ever has tokens, such as the herdr hub's Usage tab: the
 * measure is fixed, so no caller can label token counts as dollars.
 *
 * @module
 */
import type { ComponentProps } from "react"
import { UsageChart } from "./UsageChart.js"

export type TokenUsageChartProps = Omit<ComponentProps<typeof UsageChart>, "measure">

export const TokenUsageChart = (props: TokenUsageChartProps) => <UsageChart {...props} measure="tokens" />
