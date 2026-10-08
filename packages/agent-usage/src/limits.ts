/**
 * `@knpkv/agent-usage/limits` — the limits part of agent-usage, safe to bundle for a browser: the
 * snapshot schemas, what `agent-usage limits` prints ({@link LimitsNow}), the model that turns the
 * latest snapshots into windows and tone words, and the "Limits now" cards. Pair it with
 * `@knpkv/agent-usage/limits.css` and Rly's stylesheet. Nothing here reads a file, a clock or the
 * network; the caller passes `now`.
 *
 * @module
 */
export {
  type AgentLimits,
  agentName,
  type LimitTone,
  limitTone,
  NEAR_PERCENT,
  relativeReset,
  STALE_AFTER_MILLIS,
  summarizeLimits,
  windowName,
  type WindowSummary
} from "./client/limitsModel.js"
export { LimitsSummary } from "./client/LimitsSummary.js"
export {
  Agent,
  Balance,
  BalanceReading,
  failureCovers,
  LimitReading,
  LimitSnapshot,
  UnknownReason
} from "./core/Model.js"
export { LimitsNow } from "./shared/contracts.js"
