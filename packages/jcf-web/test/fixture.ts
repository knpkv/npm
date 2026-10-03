import type { WeekPlanResponse } from "../src/shared/contracts.js"

/** A small week with recorded time and two independently confirmable blocks. */
export const fixtureWeek = (monday = "2026-09-07", scope: WeekPlanResponse["scope"] = "both"): WeekPlanResponse => {
  const start = new Date(`${monday}T00:00:00`)
  const day = (offset: number) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, 12)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${
      String(date.getDate()).padStart(2, "0")
    }`
  }
  const at = (hour: number) => new Date(`${monday}T${String(hour).padStart(2, "0")}:00:00`).getTime()
  return {
    attributorAvailable: true,
    attributorCalls: 1,
    days: Array.from({ length: 7 }, (_, index) => day(index)),
    excludedDays: [],
    monday,
    unlinkedClockify: [],
    planId: `plan-${monday}-${scope}`,
    sessionCount: 4,
    sessionRootCount: 1,
    scope,
    notMine: [],
    ownershipChecked: scope !== "clockify",
    ownership: "assigned",
    unattributed: [],
    withheld: [],
    rows: [{
      rowId: "row-one",
      day: monday,
      ticketKey: "PROJ-123",
      ticketTitle: "Improve the weekly time review",
      clockifyDescription: "Review weekly time",
      clockifySeconds: scope === "jira" ? 0 : 3600,
      jiraSeconds: scope === "clockify" ? 0 : 3600,
      intervals: [{ source: scope === "jira" ? "jira" : "clockify", startMs: at(9), endMs: at(10) }],
      proposal: {
        activeSeconds: 7200,
        blocks: [
          { startMs: at(11), endMs: at(12), seconds: 3600, consumed: { clockify: 0, jira: 0 } },
          { startMs: at(14), endMs: at(15), seconds: 3600, consumed: { clockify: 0, jira: 0 } }
        ],
        clockifyDelta: scope === "jira" ? 0 : 7200,
        jiraDelta: scope === "clockify" ? 0 : 7200,
        confidence: null,
        maxSeconds: 7200,
        sessionCount: 2,
        signal: "branch"
      }
    }]
  }
}
