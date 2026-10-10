// The stories' fixture week, from the week.json snapshot (see generate.ts), shaped the way the page
// passes it to its components; mirrors viewOf in stories/CurrentScreen.stories.tsx.
import { assignSlots, bookingLabel, OTHER, stackUsage } from "../../src/usage/chartModel.js"
import type { ServerStatus } from "../../src/shared/contracts.js"
import type { buildWeek, Scenario } from "../../stories/fixtures/week.js"
import weeks from "./week.json"

type Week = ReturnType<typeof buildWeek>

export const viewOf = (scenario: Scenario) => {
  // week.json is buildWeek output serialized by generate.ts; every field is plain JSON.
  const week: Week = weeks[scenario]
  const stacked = stackUsage(week.usage, "cost", null)
  const tokens = stackUsage(week.usage, "tokens", null)
  const named = stacked.series.map((series) => series.id).filter((id) => id !== OTHER)
  const slots = assignSlots(new Map(), named)
  const labels = new Map(week.usage.bookings.map((summary) => [summary.id, bookingLabel(summary.booking)]))
  return {
    week,
    stacked,
    tokens,
    named: new Set(named),
    slots,
    labelOf: (id: string) => (id === OTHER ? "Other" : (labels.get(id) ?? id)),
    range: week.range
  }
}

export const healthyStatus: ServerStatus = {
  machine: "workstation",
  ingest: null,
  ingestFailure: null,
  limitsFailure: null,
  ticketLookupFailures: []
}
