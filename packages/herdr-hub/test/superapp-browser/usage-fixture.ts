import type { FleetLimits, FleetUsage, UsageQuery } from "@knpkv/herdr-connect/usage"

export const LONG_USAGE_HOST = [63, 63, 63, 61].map((length) => "h".repeat(length)).join(".")

/** Generic schema-compatible report fixtures; no account, cost, session or bot identity data. */
export const usageFixture = (query: UsageQuery, now: number, state: string): FleetUsage => {
  const count = query.range === "24h" ? 24 : query.range === "30d" ? 30 : 7
  const step = query.range === "24h" ? 3_600_000 : 86_400_000
  const from = Math.floor(now / step) * step - (count - 1) * step
  const periods = Array.from(
    { length: count },
    (_, index) => ({ key: String(from + index * step), start: from + index * step })
  )
  const totals = query.range === "24h"
    ? [20_000_000, 10_000_000, 5_000_000]
    : query.range === "30d"
    ? [900_000_000, 500_000_000, 215_000_000]
    : [218_000_000, 126_000_000, 68_000_000]
  const names = state === "empty-readings" ? ["atlas"] : state === "longhost"
    ? [LONG_USAGE_HOST, "birch", "cedar"]
    : state === "partial"
    ? ["atlas", "birch"]
    : ["atlas", "birch", "cedar"]
  return {
    hosts: state === "empty" ? [] : names.map((host, index) => ({
      host,
      readAt: now,
      reading: {
        _tag: "Read",
        skipped: 0,
        usage: {
          v: 1,
          machine: host,
          observedAt: state === "stale" && host === "birch" ? now - 3_600_000 : now,
          range: {
            preset: query.range,
            timeZone: query.timeZone,
            from,
            to: from + count * step,
            bucket: query.range === "24h" ? "hour" : "day"
          },
          periods,
          tokens: state === "empty-readings" ? [] : periods.flatMap((_, period) => [
            { period, agent: "claude", model: "model-a", tokens: Math.round((totals[index] ?? 0) * 0.65 / count) },
            { period, agent: "codex", model: "model-b", tokens: Math.round((totals[index] ?? 0) * 0.35 / count) }
          ]),
          limits: []
        }
      }
    })),
    failures: state === "partial" ? [{ host: "cedar", reason: "offline" }] : [],
    peersListed: true
  }
}

/** `host` reads its own limits; the shell fixture serves them as the hub's own read. */
export const limitsFixture = (now: number, state: string, host = "atlas"): FleetLimits => ({
  hosts: state === "empty" ? [] : [{
    host,
    readAt: now,
    reading: {
      _tag: "Read",
      skipped: 0,
      limits: {
        v: 1,
        machine: host,
        observedAt: now,
        latest: state === "empty-readings" ? [] : [
          {
            agent: "claude",
            machine: host,
            source: "claude-oauth-usage",
            label: "five_hour",
            windowMinutes: 300,
            observedAt: state === "stale" ? now - 3_600_000 : now,
            reading: { _tag: "Known", usedPercent: 72, resetsAt: now + 2 * 3_600_000 }
          },
          {
            agent: "claude",
            machine: host,
            source: "claude-oauth-usage",
            label: "seven_day",
            windowMinutes: 10_080,
            observedAt: now,
            reading: { _tag: "Known", usedPercent: 48, resetsAt: now + 3 * 86_400_000 }
          },
          {
            agent: "codex",
            machine: host,
            source: "codex-rollout",
            label: "seven_day",
            windowMinutes: 10_080,
            observedAt: now,
            reading: { _tag: "Known", usedPercent: 31, resetsAt: now + 2 * 86_400_000 }
          }
        ]
      }
    }
  }],
  failures: state === "partial" ? [{ host: "cedar", reason: "offline" }] : [],
  peersListed: true
})
