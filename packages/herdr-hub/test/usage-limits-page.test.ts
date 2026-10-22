import type { WindowSummary } from "@knpkv/agent-usage/limits"
import type { FleetLimits } from "@knpkv/herdr-connect/usage"
import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { designReadings, UsageDesignFixture } from "../scripts/design-fixture.js"
import { limitsPage, resetLabel, windowStatus } from "../src/usage-limits-page.js"

const raw = readFileSync(new URL("../../../design-refs/super-app/fixture.json", import.meta.url), "utf8")
const fixture = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), data: UsageDesignFixture }))
)(raw).data

/** The copy the 06 Usage reference prints for each readings state: the specification this page follows. */
const Expected = Schema.Struct({
  data: Schema.Struct({
    usageLimits: Schema.Struct({
      states: Schema.Record(
        Schema.String,
        Schema.Struct({
          summary: Schema.optionalKey(Schema.Struct({ verdict: Schema.String, note: Schema.String })),
          notices: Schema.optionalKey(Schema.Array(Schema.Struct({ title: Schema.String, text: Schema.String }))),
          limits: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                tool: Schema.Literals(["claude", "codex"]),
                state: Schema.optionalKey(Schema.Struct({ label: Schema.String, tone: Schema.String })),
                note: Schema.optionalKey(Schema.String)
              })
            )
          )
        })
      )
    })
  })
})
const expected = Schema.decodeUnknownSync(Schema.fromJsonString(Expected))(raw).data.usageLimits.states

const pageFor = (name: string) => {
  const state = fixture.usageLimits.states[name]
  if (state === undefined) return expect.unreachable(`Missing ${name} fixture`)
  return limitsPage(designReadings(fixture, state).limits, "atlas", 0, "UTC")
}

const readingStates = ["populated", "near-limit", "limit-reached", "stale", "sign-in-required"]

describe("Usage Limits page", () => {
  it.each(readingStates)("writes the reference verdict and notices for %s", (name) => {
    const page = pageFor(name)
    const want = expected[name]
    expect(page?.summary).toEqual(want?.summary)
    expect(page?.notices).toEqual(want?.notices ?? [])
  })

  it.each(readingStates)("draws one card per tool with the reference state and note for %s", (name) => {
    const page = pageFor(name)
    expect(page?.cards.map((card) => card.agent)).toEqual(["claude", "codex"])
    expect(page?.cards.map((card) => ({ state: card.state, note: card.note }))).toEqual(
      expected[name]?.limits?.map((limit) => ({ state: limit.state ?? null, note: limit.note ?? null }))
    )
  })

  it("reads the populated cards in the reference words", () => {
    expect(pageFor("populated")?.cards).toEqual([
      {
        agent: "claude",
        name: "Claude",
        read: "atlas, read 14:01",
        figure: 72,
        measures: "5-hour limit used",
        state: null,
        track: { value: 72, stale: false, label: "Claude 5-hour limit", valueText: "72% used" },
        details: [
          ["5-hour reset", "Today, 16:40"],
          ["Weekly limit", "48% used"],
          ["Weekly reset", "Wednesday, 07:00"]
        ],
        note: null
      },
      {
        agent: "codex",
        name: "Codex",
        read: "atlas, read 14:02",
        figure: 31,
        measures: "Weekly limit used",
        state: null,
        track: { value: 31, stale: false, label: "Codex weekly limit", valueText: "31% used" },
        details: [
          ["5-hour limit", "18% used"],
          ["5-hour reset", "Today, 17:15"],
          ["Weekly reset", "Tuesday, 03:29"]
        ],
        note: null
      }
    ])
  })

  it("keeps a stale level visible and says when it was read", () => {
    const claude = pageFor("stale")?.cards[0]
    expect(claude?.read).toBe("atlas, read 09:12")
    expect(claude?.track).toEqual({
      value: 64,
      stale: true,
      label: "Claude 5-hour limit",
      valueText: "64% used as of 09:12"
    })
  })

  it("never draws an unreadable limit as zero", () => {
    const codex = pageFor("sign-in-required")?.cards[1]
    expect(codex).toMatchObject({
      read: "atlas, sign-in required",
      figure: null,
      measures: "Weekly limit",
      track: null
    })
    expect(codex?.details).toEqual([
      ["5-hour limit", null],
      ["5-hour reset", null],
      ["Weekly reset", null]
    ])
  })

  it("has no page for a host without a limits reading", () => {
    const state = fixture.usageLimits.states.populated
    if (state === undefined) return expect.unreachable("Missing populated fixture")
    const fleet = designReadings(fixture, state).limits
    expect(limitsPage(fleet, "birch", 0, "UTC")).toBeNull()
    expect(
      limitsPage(
        {
          ...fleet,
          hosts: [{ host: "atlas", readAt: 0, reading: { _tag: "Unavailable", reason: "timeout", detail: "" } }]
        },
        "atlas",
        0,
        "UTC"
      )
    ).toBeNull()
  })
})

const now = Date.UTC(2026, 9, 11, 14, 2)
type Snapshot = Extract<FleetLimits["hosts"][number]["reading"], { readonly _tag: "Read" }>["limits"]["latest"][number]
const known = (
  agent: "claude" | "codex",
  label: "five_hour" | "seven_day",
  usedPercent: number,
  resetsAt: number,
  observedAt = now
): Snapshot => ({
  agent,
  machine: "atlas",
  source: agent === "claude" ? "claude-oauth-usage" : "codex-rollout",
  label,
  windowMinutes: label === "five_hour" ? 300 : 10_080,
  observedAt,
  reading: { _tag: "Known", usedPercent, resetsAt }
})
const unknown = (agent: "codex", label: "five_hour" | "seven_day", reason: "Fetch" | "AuthExpired"): Snapshot => ({
  ...known(agent, label, 0, 0),
  reading: { _tag: "Unknown", reason }
})
const fleetOf = (latest: ReadonlyArray<Snapshot>): FleetLimits => ({
  hosts: [{
    host: "atlas",
    readAt: now,
    reading: { _tag: "Read", skipped: 0, limits: { v: 1, machine: "atlas", observedAt: now, latest } }
  }],
  failures: [],
  peersListed: true
})
const at = (day: number, hour: number, minute: number) => Date.UTC(2026, 9, day, hour, minute)
const claudeRoom = [known("claude", "five_hour", 40, at(11, 16, 40)), known("claude", "seven_day", 20, at(14, 7, 0))]

describe("Usage Limits page edge cases", () => {
  it("says Unknown with its cause, not sign-in, when a read failed for another reason", () => {
    const page = limitsPage(
      fleetOf([...claudeRoom, unknown("codex", "five_hour", "Fetch"), unknown("codex", "seven_day", "Fetch")]),
      "atlas",
      0,
      "UTC"
    )
    expect(page?.cards[1]).toMatchObject({
      read: "atlas, could not be fetched",
      figure: null,
      state: { label: "Unknown", tone: "neutral" },
      note: "Unknown is not zero. Read again on atlas."
    })
    expect(page?.summary.verdict).toBe("Claude has room on atlas; Codex is Unknown.")
    expect(page?.summary.note).toContain("Codex can’t be read: could not be fetched.")
    expect(page?.notices.map((notice) => notice.title)).toEqual(["Codex limits can’t be read on atlas."])
  })

  it("keeps a tool with no reading as an Unknown card instead of leaving it out", () => {
    const page = limitsPage(fleetOf(claudeRoom), "atlas", 0, "UTC")
    expect(page?.cards.map((card) => [card.agent, card.figure, card.state?.label, card.read])).toEqual([
      ["claude", 40, undefined, "atlas, read 14:02"],
      ["codex", null, "Unknown", "atlas, nothing reported yet"]
    ])
    expect(page?.summary.verdict).toBe("Claude has room on atlas; Codex is Unknown.")
  })

  it("names the reset day wherever a reset on another day is printed", () => {
    const page = limitsPage(
      fleetOf([
        ...claudeRoom,
        known("codex", "five_hour", 10, at(11, 17, 15)),
        known("codex", "seven_day", 100, at(13, 3, 29))
      ]),
      "atlas",
      0,
      "UTC"
    )
    expect(page?.cards[1]?.note).toBe("New Codex work on atlas waits until Tuesday at 03:29.")
    expect(page?.summary).toEqual({
      verdict: "Codex is at its weekly limit on atlas.",
      note: "New Codex work waits until Tuesday at 03:29. Claude still has room: 40% 5-hour."
    })
    const week = limitsPage(
      fleetOf([known("claude", "five_hour", 85, at(11, 16, 40)), known("claude", "seven_day", 20, at(18, 7, 0))]),
      "atlas",
      0,
      "UTC"
    )
    expect(week?.cards[0]?.details[2]).toEqual(["Weekly reset", "Next Sunday, 07:00"])
    expect(week?.cards[0]?.note).toBe("15% left until 16:40.")
  })

  it("lets a current full limit lead the verdict over another tool's stale reading", () => {
    const page = limitsPage(
      fleetOf([
        known("claude", "five_hour", 64, at(11, 16, 40), at(11, 9, 12)),
        known("claude", "seven_day", 44, at(14, 7, 0), at(11, 9, 12)),
        known("codex", "five_hour", 10, at(11, 17, 15)),
        known("codex", "seven_day", 100, at(13, 3, 29))
      ]),
      "atlas",
      0,
      "UTC"
    )
    expect(page?.summary.verdict).toBe("Codex is at its weekly limit on atlas.")
    expect(page?.notices.map((notice) => notice.title)).toEqual(["Limits were last read at 09:12."])
  })

  it("takes near and full from agent-usage's own tone, which counts a projected run-out as near", () => {
    const window: Pick<WindowSummary, "freshness" | "usedPercent"> = { freshness: "current", usedPercent: 50 }
    expect(windowStatus({ ...window, tone: "near" })).toBe("near")
    expect(windowStatus({ ...window, usedPercent: 85, tone: "ok" })).toBe("ok")
  })
})

describe("Usage Limits reset words", () => {
  it("says next only for the same weekday a week out, and dates a reset already past", () => {
    expect(resetLabel(at(17, 7, 0), now, "UTC")).toBe("Saturday, 07:00")
    expect(resetLabel(at(18, 7, 0), now, "UTC")).toBe("Next Sunday, 07:00")
    expect(resetLabel(at(11, 9, 0), now, "UTC")).toBe("Sunday 11 October, 09:00")
    expect(resetLabel(at(11, 16, 40), now, "UTC")).toBe("Today, 16:40")
  })
})
