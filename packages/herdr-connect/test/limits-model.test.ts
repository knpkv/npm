import type { LimitSnapshot } from "@knpkv/agent-usage/limits"
import { describe, expect, it } from "vitest"
import { connectLimitsView } from "../src/limits-model.js"
import type { FleetLimits, HostLimits } from "../src/limits.js"

const HOUR = 3_600_000
const MINUTE = 60_000

/** A host whose clock reads `hostNow` when it answered, with the given snapshots. */
const read = (host: string, hostNow: number, latest: ReadonlyArray<LimitSnapshot>, skipped = 0): HostLimits => ({
  host,
  readAt: hostNow,
  reading: { _tag: "Read", limits: { v: 1, machine: host, observedAt: hostNow, latest }, skipped }
})

const window = (
  host: string,
  label: "five_hour" | "seven_day",
  usedPercent: number,
  observedAt: number,
  agent: "claude" | "codex" = "claude"
): LimitSnapshot => ({
  agent,
  machine: host,
  source: agent === "claude" ? "claude-oauth-usage" : "codex-rollout",
  label,
  windowMinutes: label === "five_hour" ? 300 : 10_080,
  observedAt,
  reading: { _tag: "Known", usedPercent, resetsAt: observedAt + 3 * HOUR }
})

const fleet = (...hosts: ReadonlyArray<HostLimits>): FleetLimits => ({ hosts, failures: [], peersListed: true })

describe("connectLimitsView", () => {
  it("names each agent once, by the window closest to its limit on any host", () => {
    const t = 1_000 * HOUR
    const view = connectLimitsView(
      fleet(
        read("SER8", t, [window("SER8", "five_hour", 30, t - MINUTE), window("SER8", "seven_day", 48, t - MINUTE)]),
        read("PI", t, [window("PI", "five_hour", 86, t - MINUTE)])
      ),
      0
    )
    expect(view.line).toEqual([{ agent: "claude", tone: "near", text: "Claude 86% 5-hour" }])
    expect(view.hosts.map((host) => host.host)).toEqual(["SER8", "PI"])
  })

  it("reads each host on its own clock, however far it is from this page's", () => {
    // PI's clock is three hours ahead of SER8's; both readings are a minute old on their own clock.
    const t = 1_000 * HOUR
    const view = connectLimitsView(
      fleet(
        read("SER8", t, [window("SER8", "seven_day", 48, t - MINUTE)]),
        read("PI", t + 3 * HOUR, [window("PI", "seven_day", 20, t + 3 * HOUR - MINUTE, "codex")])
      ),
      5 * MINUTE
    )
    expect(view.hosts.map((host) => host.now)).toEqual([t + 5 * MINUTE, t + 3 * HOUR + 5 * MINUTE])
    expect(view.line.map((item) => item.text)).toEqual(["Claude 48% weekly", "Codex 20% weekly"])
  })

  it("calls an old reading unknown on the line", () => {
    const t = 1_000 * HOUR
    const view = connectLimitsView(fleet(read("SER8", t, [window("SER8", "seven_day", 48, t - MINUTE)])), 20 * MINUTE)
    expect(view.line).toEqual([{ agent: "claude", tone: "unknown", text: "Claude unknown" }])
  })

  it("says which hosts gave no reading, and what a newer agent-usage left out", () => {
    const t = 1_000 * HOUR
    const view = connectLimitsView(
      {
        hosts: [
          read("SER8", t, [], 2),
          { host: "MBP", readAt: t, reading: { _tag: "Unavailable", reason: "unsupported_version", detail: "" } }
        ],
        failures: [{ host: "PI", reason: "offline" }],
        peersListed: false
      },
      0
    )
    expect(view.notes).toEqual([
      "SER8: 2 readings are from a newer agent-usage and not shown",
      "agent-usage on MBP is newer than this hub; update hostd to read it",
      "No reading from PI (offline)",
      "Other machines unknown: the hub couldn't list the fleet"
    ])
    expect(view.off).toBe(false)
  })

  it("is off when no host is set up to read limits", () => {
    const off = (host: string): HostLimits => ({
      host,
      readAt: 0,
      reading: { _tag: "Unavailable", reason: "not_configured", detail: "" }
    })
    expect(connectLimitsView(fleet(off("SER8"), off("PI")), 0).off).toBe(true)
  })
})
