/** Ranking decides who wins contested parallel minutes; it must never invent or drop a ticket. */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  type JqlSearch,
  loggedByDay,
  type RankingFacts,
  readRankingFacts,
  ticketPriority
} from "../src/services/TicketRanking.js"

/** A Jira that answers each JQL from a table; an unknown query returns a page with no `issues`. */
const fakeJira = (answers: Readonly<Record<string, ReadonlyArray<string>>>) => {
  const queries: Array<string> = []
  const search: JqlSearch<never> = (jql) => {
    queries.push(jql)
    const keys = answers[jql]
    return Effect.succeed(keys === undefined ? {} : { issues: keys.map((key) => ({ key })) })
  }
  return { search, queries }
}

const SPRINT = "sprint in openSprints() AND assignee = currentUser()"

describe("ticket ranking", () => {
  it("ranks sprint before not-logged, and unknown facts all equal", () => {
    const facts: RankingFacts = {
      _tag: "Known",
      sprint: new Set(["RPS-1", "RPS-2"]),
      loggedByDay: new Map([["2026-09-28", new Set(["RPS-2", "RPS-3"])]])
    }
    const rank = ticketPriority(facts)
    expect([
      rank("RPS-1", "2026-09-28"),
      rank("RPS-2", "2026-09-28"),
      rank("RPS-4", "2026-09-28"),
      rank("RPS-3", "2026-09-28")
    ])
      .toEqual([3, 2, 1, 0])
    // Logged on another day does not count against this one.
    expect(rank("RPS-3", "2026-09-29")).toBe(1)
    expect(ticketPriority({ _tag: "Unknown", reason: "offline" })("RPS-1", "2026-09-28")).toBe(0)
  })

  // JQL cannot tie worklogAuthor and worklogDate to one worklog; only the tallied bodies can.
  it("takes logged days from my tallied worklogs, ignoring empty slices", () => {
    expect(loggedByDay([
      { ticketKey: "RPS-1", day: "2026-09-28", seconds: 600 },
      { ticketKey: "RPS-2", day: "2026-09-28", seconds: 0 },
      { ticketKey: "RPS-1", day: "2026-09-29", seconds: 60 }
    ])).toEqual(new Map([["2026-09-28", new Set(["RPS-1"])], ["2026-09-29", new Set(["RPS-1"])]]))
  })

  it.effect("reads only the open sprint from JQL and logged days from the tally", () =>
    Effect.gen(function*() {
      const jira = fakeJira({ [SPRINT]: ["RPS-1"] })
      const facts = yield* readRankingFacts(jira.search, [{ ticketKey: "RPS-2", day: "2026-09-28", seconds: 600 }])
      expect(facts).toEqual({
        _tag: "Known",
        sprint: new Set(["RPS-1"]),
        loggedByDay: new Map([["2026-09-28", new Set(["RPS-2"])]])
      })
      expect(jira.queries).toEqual([SPRINT])
    }))

  it.effect("is Unknown when the Jira tally could not be read", () =>
    Effect.gen(function*() {
      const jira = fakeJira({ [SPRINT]: ["RPS-1"] })
      const facts = yield* readRankingFacts(jira.search, undefined)
      expect(facts._tag).toBe("Unknown")
      expect(jira.queries).toEqual([])
    }))

  it.effect("is Unknown, not empty, when Jira cannot answer", () =>
    Effect.gen(function*() {
      const facts = yield* readRankingFacts(fakeJira({}).search, [])
      expect(facts._tag).toBe("Unknown")
    }))

  it.effect("is Unknown when a page has an issue without a key", () =>
    Effect.gen(function*() {
      const search: JqlSearch<never> = () => Effect.succeed({ issues: [{}] })
      const facts = yield* readRankingFacts(search, [])
      expect(facts._tag).toBe("Unknown")
    }))
})
