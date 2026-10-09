import { describe, expect, it } from "@effect/vitest"
import { usageTabView } from "../src/usage-model.js"
import type { FleetUsage, HostUsage, UsageNow } from "../src/usage.js"

const day = 86_400_000
const usage = (machine: string, observedAt: number, cells: UsageNow["tokens"], start = 0): UsageNow => ({
  v: 1,
  machine,
  observedAt,
  range: { preset: "7d", timeZone: "Europe/Amsterdam", from: start, to: start + 2 * day, bucket: "day" },
  periods: [{ key: "2026-10-08", start }, { key: "2026-10-09", start: start + day }],
  tokens: cells,
  limits: [{ agent: "claude", label: "five_hour", windowMinutes: 300, points: [] }]
})
const read = (host: string, value: UsageNow, skipped = 0): HostUsage => ({
  host,
  readAt: 0,
  reading: { _tag: "Read", usage: value, skipped }
})

describe("usageTabView", () => {
  it("stacks every host's tokens by agent and model on one calendar", () => {
    const fleet: FleetUsage = {
      hosts: [
        read("SER8", usage("SER8", 5_000, [{ period: 1, agent: "claude", model: "claude-opus-5", tokens: 300 }])),
        // A peer whose clock is a little behind: same keys, so the same columns.
        read(
          "PI",
          usage("PI", 4_000, [
            { period: 0, agent: "codex", model: "gpt-6", tokens: 50 },
            { period: 1, agent: "claude", model: "claude-opus-5", tokens: 100 }
          ], -1_000)
        )
      ],
      failures: [],
      peersListed: true
    }
    const view = usageTabView(fleet, 2_000)
    expect(view.periods.map((period) => period.key)).toEqual(["2026-10-08", "2026-10-09"])
    expect(view.cells).toEqual([
      { period: 1, id: "claude:claude-opus-5", value: 300 },
      { period: 0, id: "codex:gpt-6", value: 50 },
      { period: 1, id: "claude:claude-opus-5", value: 100 }
    ])
    expect(view.labels.get("codex:gpt-6")).toBe("Codex gpt-6")
    expect(view.totalTokens).toBe(450)
    // Each host's limits keep its own clock: its observedAt plus the time since the page got it.
    expect(view.hosts.map((host) => [host.host, host.now])).toEqual([["SER8", 7_000], ["PI", 6_000]])
  })

  it("says which hosts gave nothing, and why", () => {
    const fleet: FleetUsage = {
      hosts: [
        read("SER8", usage("SER8", 0, []), 2),
        { host: "MBP", readAt: 0, reading: { _tag: "Unavailable", reason: "not_configured", detail: "" } },
        {
          host: "NUC",
          readAt: 0,
          reading: { _tag: "Unavailable", reason: "failed", detail: "agent-usage: `agent-usage serve` is not running" }
        }
      ],
      failures: [{ host: "PI", reason: "offline" }],
      peersListed: false
    }
    expect(usageTabView(fleet, 0).notes).toEqual([
      "MBP: usage is not set up on this host.",
      "NUC: agent-usage serve is not running",
      "SER8: 2 entries from a newer agent-usage are not shown.",
      "PI is offline.",
      "The other machines could not be listed, so only this host is shown."
    ])
  })

  it("has no chart range until a host answers", () => {
    const view = usageTabView({ hosts: [], failures: [], peersListed: true }, 0)
    expect(view.range).toBeNull()
    expect(view.cells).toEqual([])
  })
})
