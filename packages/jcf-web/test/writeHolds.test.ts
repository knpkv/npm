/** A held provider draws no suggestions, so the week must still say why it is quiet. */
import { expect, it } from "@effect/vitest"
import { heldWriteProviders, ignoredTicketTotals, withIgnoreDecision } from "../src/client/writeHolds.js"
import type { WeekPlanResponse, WriteHolds } from "../src/shared/contracts.js"
import { fixtureWeek } from "./fixture.js"

const withHolds = (plan: WeekPlanResponse, holds: typeof WriteHolds.Type): WeekPlanResponse => ({
  ...plan,
  rows: plan.rows.map((row) =>
    row.proposal === undefined ? row : { ...row, proposal: { ...row.proposal, writeBlocked: holds } }
  )
})

it("names every held provider, Jira first, and nothing for an unheld or missing week", () => {
  expect(heldWriteProviders(null)).toEqual([])
  expect(heldWriteProviders(fixtureWeek())).toEqual([])
  expect(heldWriteProviders(withHolds(fixtureWeek(), { jira: "review-required" }))).toEqual(["Jira"])
  expect(heldWriteProviders(withHolds(fixtureWeek(), { clockify: "review-required", jira: "review-required" })))
    .toEqual(["Jira", "Clockify"])
})

it("sums each ignored ticket across the week, by ticket", () => {
  expect(ignoredTicketTotals(null)).toEqual([])
  const plan: WeekPlanResponse = {
    ...fixtureWeek(),
    ignored: [
      { ticketKey: "PROJ-2", day: "2026-07-06", seconds: 600 },
      { ticketKey: "PROJ-1", day: "2026-07-06", seconds: 60 },
      { ticketKey: "PROJ-2", day: "2026-07-07", seconds: 300 }
    ]
  }
  expect(ignoredTicketTotals(plan)).toEqual([{ ticketKey: "PROJ-1", seconds: 60 }, {
    ticketKey: "PROJ-2",
    seconds: 900
  }])
})

it("keeps an ignored ticket with no time this week restorable, at zero", () => {
  const plan: WeekPlanResponse = { ...fixtureWeek(), ignoredTickets: ["PROJ-3"], ignored: [] }
  expect(ignoredTicketTotals(plan)).toEqual([{ ticketKey: "PROJ-3", seconds: 0 }])
})

// A click on Ignore must change the calendar at once; the rescan only refines the numbers.
it("hides an ignored ticket's suggestions immediately and lists it, and restore only updates the list", () => {
  const week = fixtureWeek()
  const target = week.rows.find((row) => row.proposal !== undefined)
  if (target === undefined) return expect.unreachable()
  const ignored = withIgnoreDecision(week, target.ticketKey, [target.ticketKey])
  expect(ignored.rows.filter((row) => row.ticketKey === target.ticketKey).every((row) => row.proposal === undefined))
    .toBe(true)
  expect(ignored.rows.filter((row) => row.ticketKey !== target.ticketKey)).toEqual(
    week.rows.filter((row) => row.ticketKey !== target.ticketKey)
  )
  expect(ignoredTicketTotals(ignored).map((total) => total.ticketKey)).toEqual([target.ticketKey])
  expect(ignoredTicketTotals(ignored)[0]?.seconds).toBeGreaterThan(0)

  const restored = withIgnoreDecision(ignored, target.ticketKey, [])
  expect(ignoredTicketTotals(restored)).toEqual([])
})
