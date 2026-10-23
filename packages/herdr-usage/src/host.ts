/**
 * `@knpkv/herdr-usage/host` — this machine's agent-usage readings: `readHostLimits` and `readHostUsage` run the
 * configured `agent-usage` command, bounded and cached, and say why in plain sentences when it can't answer.
 * hostd serves them to the hub as each peer's `/v1/connect/{limits,usage}/local`; the standalone Usage app
 * reads them directly.
 *
 * @module
 */
export { CommandFailed, failureSentence, reportFailure } from "./host/failure.js"
export {
  hostLimitsOutputMaxBytes,
  hostLimitsTimeout,
  readHostLimits,
  runCommand,
  type StaleWhileRevalidate,
  staleWhileRevalidate
} from "./host/limits.js"
export {
  hostUsageCacheEntries,
  hostUsageConcurrentReads,
  hostUsageTimeout,
  hostUsageTtl,
  readHostUsage,
  usageCache,
  usageCommandFor
} from "./host/usage.js"
