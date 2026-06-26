import { describe, expect, it } from "@effect/vitest"
import { deltaToApply, resolvePeriod } from "../src/cli/reconcile.js"
import { buildReconcileRows, localDay, parseTicketKey } from "../src/services/ReconcileService.js"

describe("parseTicketKey", () => {
  it("parses the bracket form `[KEY] summary`", () => {
    expect(parseTicketKey("[PROJ-12] Fix the widget")).toBe("PROJ-12")
  })

  it("parses the colon form `KEY: summary`", () => {
    expect(parseTicketKey("PROJ-12: Fix the widget")).toBe("PROJ-12")
  })

  // A bare colon prefix that isn't a ticket key must not be mistaken for one.
  it("does not treat arbitrary `word:` prefixes as a key", () => {
    expect(parseTicketKey("Meeting: standup")).toBeNull()
  })

  it("returns null for empty / missing descriptions", () => {
    expect(parseTicketKey("")).toBeNull()
    expect(parseTicketKey(null)).toBeNull()
    expect(parseTicketKey(undefined)).toBeNull()
  })
})

describe("localDay", () => {
  it("formats a date as local YYYY-MM-DD", () => {
    // Construct from local components to stay timezone-independent.
    expect(localDay(new Date(2026, 5, 23, 9, 30))).toBe("2026-06-23")
    expect(localDay(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01")
  })
})

describe("buildReconcileRows", () => {
  // Multiple entries on the same (ticket, day) on one side must sum, not duplicate.
  it("sums per (ticket, day) bucket across both sides", () => {
    const rows = buildReconcileRows(
      [
        { ticketKey: "PROJ-1", day: "2026-06-23", seconds: 3600 },
        { ticketKey: "PROJ-1", day: "2026-06-23", seconds: 1800 }
      ],
      [{ ticketKey: "PROJ-1", day: "2026-06-23", seconds: 3600 }]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ticketKey: "PROJ-1", day: "2026-06-23", clockifySeconds: 5400, jiraSeconds: 3600 })
  })

  // A bucket present on only one side still appears, with 0 on the other.
  it("includes one-sided buckets with zero on the missing side", () => {
    const rows = buildReconcileRows(
      [{ ticketKey: "PROJ-1", day: "2026-06-23", seconds: 3600 }],
      [{ ticketKey: "PROJ-2", day: "2026-06-24", seconds: 1800 }]
    )
    expect(rows).toEqual([
      { ticketKey: "PROJ-1", day: "2026-06-23", clockifySeconds: 3600, jiraSeconds: 0 },
      { ticketKey: "PROJ-2", day: "2026-06-24", clockifySeconds: 0, jiraSeconds: 1800 }
    ])
  })

  it("sorts by day then ticket for stable output", () => {
    const rows = buildReconcileRows(
      [
        { ticketKey: "PROJ-9", day: "2026-06-24", seconds: 60 },
        { ticketKey: "PROJ-2", day: "2026-06-23", seconds: 60 },
        { ticketKey: "PROJ-1", day: "2026-06-23", seconds: 60 }
      ],
      []
    )
    expect(rows.map((r) => `${r.day} ${r.ticketKey}`)).toEqual([
      "2026-06-23 PROJ-1",
      "2026-06-23 PROJ-2",
      "2026-06-24 PROJ-9"
    ])
  })

  it("returns an empty list when both sides are empty", () => {
    expect(buildReconcileRows([], [])).toEqual([])
  })
})

describe("deltaToApply", () => {
  const row = (clockifySeconds: number, jiraSeconds: number) => ({
    ticketKey: "PROJ-1",
    day: "2026-06-23",
    clockifySeconds,
    jiraSeconds
  })

  it("returns the gap the target is short in the chosen direction", () => {
    expect(deltaToApply(row(7200, 3600), "clockify-to-jira")).toBe(3600)
    expect(deltaToApply(row(3600, 7200), "jira-to-clockify")).toBe(3600)
  })

  // Reconciling clockify->jira never proposes shrinking Jira when Jira already has more.
  it("returns 0 when the target already has at least as much", () => {
    expect(deltaToApply(row(3600, 7200), "clockify-to-jira")).toBe(0)
    expect(deltaToApply(row(7200, 3600), "jira-to-clockify")).toBe(0)
  })

  // Sub-minute differences are noise (Jira floors to 60s) and must not be flagged.
  it("ignores differences under the 60s tolerance", () => {
    expect(deltaToApply(row(3630, 3600), "clockify-to-jira")).toBe(0)
    expect(deltaToApply(row(3660, 3600), "clockify-to-jira")).toBe(60)
  })
})

describe("resolvePeriod", () => {
  // A custom window is inclusive of both days → half-open [from 00:00, until+1 00:00).
  it("builds an inclusive custom window from --since/--until", () => {
    const period = resolvePeriod({ week: false, since: "2026-06-01", until: "2026-06-07" })
    expect("error" in period).toBe(false)
    if ("error" in period) return
    expect(localDay(period.from)).toBe("2026-06-01")
    // `to` is exclusive: the instant just before it is still 2026-06-07.
    expect(localDay(new Date(period.to.getTime() - 1))).toBe("2026-06-07")
  })

  it("spans 7 local days for --week (inclusive of today)", () => {
    const period = resolvePeriod({ week: true, since: undefined, until: undefined })
    expect("error" in period).toBe(false)
    if ("error" in period) return
    const days = Math.round((period.to.getTime() - period.from.getTime()) / (24 * 60 * 60 * 1000))
    expect(days).toBe(7)
  })

  it("rejects a reversed custom window", () => {
    const period = resolvePeriod({ week: false, since: "2026-06-07", until: "2026-06-01" })
    expect("error" in period).toBe(true)
  })

  it("rejects a malformed date", () => {
    const period = resolvePeriod({ week: false, since: "june 1", until: undefined })
    expect("error" in period).toBe(true)
  })
})
