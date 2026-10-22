import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { designReadings, UsageDesignFixture } from "../scripts/design-fixture.js"
import { limitsPage } from "../src/usage-limits-page.js"

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
