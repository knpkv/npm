/**
 * The Work tab's triage: which goals need the viewer, which are blocked, which are moving, and
 * which finished in the last 24 hours, plus the one-sentence summary above them.
 *
 * Pure: callers pass one snapshot. View-only derivation lives here; the goal model, its
 * projection and observed facts stay in `model.ts`/`projection.ts`.
 *
 * A goal needs the viewer when it has an open request: someone asked for an approval only a
 * person can give. Blocked follows the goal's recorded state. Done counts terminal goals updated
 * within 24 hours of the snapshot, labelled as such, never as "since you looked"; older terminal
 * goals stay listed last, as "Finished earlier", so a status filter still finds them.
 */
import type { WorkGoal, WorkRequest, WorkSnapshot } from "./model.js"

const DAY_MS = 86_400_000

/** How long a finished goal stays in the "Done in the last 24 hours" group. */
export const workTriageDoneWindowMs = DAY_MS

/** The groups, in reading order. */
export type WorkTriageGroup = "needs-you" | "blocked" | "moving" | "done" | "earlier"

export const workTriageGroups: ReadonlyArray<WorkTriageGroup> = ["needs-you", "blocked", "moving", "done", "earlier"]

export interface WorkTriageRow {
  readonly goal: WorkGoal
  readonly group: WorkTriageGroup
  /** Position in the snapshot, the projection's own order; ties fall back to it. */
  readonly index: number
  /** Open requests on this goal, oldest first. */
  readonly openRequests: ReadonlyArray<WorkRequest>
}

/** The sentence above the groups. */
export type WorkTriageSummary =
  | {
    readonly _tag: "Attention"
    readonly needsYou: number
    readonly blocked: number
    /** The request waiting longest, when one is open. */
    readonly oldestRequest: { readonly goal: WorkGoal; readonly request: WorkRequest } | null
  }
  | { readonly _tag: "Clear"; readonly moving: number; readonly latest: WorkGoal | null }
  | { readonly _tag: "Empty" }

export interface WorkTriage {
  readonly rows: ReadonlyArray<WorkTriageRow>
  readonly summary: WorkTriageSummary
}

const terminal = (goal: WorkGoal): boolean => goal.state === "completed" || goal.state === "deployed"

const openRequestsOf = (goal: WorkGoal): ReadonlyArray<WorkRequest> =>
  (goal.requests ?? []).filter((request) => request.state === "open").toSorted((a, b) => a.requestedAt - b.requestedAt)

const groupOf = (goal: WorkGoal, openRequests: ReadonlyArray<WorkRequest>, asOf: number): WorkTriageGroup => {
  if (openRequests.length > 0) return "needs-you"
  if (goal.state === "blocked") return "blocked"
  if (terminal(goal)) return asOf - goal.updatedAt <= workTriageDoneWindowMs ? "done" : "earlier"
  return "moving"
}

const groupOrder = { "needs-you": 0, blocked: 1, moving: 2, done: 3, earlier: 4 } satisfies Readonly<
  Record<WorkTriageGroup, number>
>

/**
 * Within "needs you", the oldest open request first; elsewhere, the most recently updated goal
 * first. Ties keep the snapshot's own order, so the order is stable across polls.
 */
const compareRows = (left: WorkTriageRow, right: WorkTriageRow): number => {
  const byGroup = groupOrder[left.group] - groupOrder[right.group]
  if (byGroup !== 0) return byGroup
  if (left.group === "needs-you") {
    const byRequest = (left.openRequests[0]?.requestedAt ?? 0) - (right.openRequests[0]?.requestedAt ?? 0)
    if (byRequest !== 0) return byRequest
  } else {
    const byUpdate = right.goal.updatedAt - left.goal.updatedAt
    if (byUpdate !== 0) return byUpdate
  }
  return left.index - right.index
}

/** Sorts one snapshot's goals into the triage groups and states the summary. */
export const workTriage = (snapshot: Pick<WorkSnapshot, "asOf" | "goals">): WorkTriage => {
  const rows = snapshot.goals
    .map((goal, index): WorkTriageRow => {
      const openRequests = openRequestsOf(goal)
      return { goal, group: groupOf(goal, openRequests, snapshot.asOf), index, openRequests }
    })
    .toSorted(compareRows)
  const needsYou = rows.filter((row) => row.group === "needs-you")
  const blocked = rows.filter((row) => row.group === "blocked").length
  if (needsYou.length > 0 || blocked > 0) {
    const first = needsYou[0]
    const request = first?.openRequests[0]
    return {
      rows,
      summary: {
        _tag: "Attention",
        blocked,
        needsYou: needsYou.length,
        oldestRequest: first === undefined || request === undefined ? null : { goal: first.goal, request }
      }
    }
  }
  if (rows.length === 0) return { rows, summary: { _tag: "Empty" } }
  const latest = rows.toSorted((a, b) => b.goal.updatedAt - a.goal.updatedAt)[0]?.goal ?? null
  return { rows, summary: { _tag: "Clear", latest, moving: rows.filter((row) => row.group === "moving").length } }
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** The summary as its one sentence: "3 goals need you, 2 blocked", "Nothing needs you", "No goals yet". */
export const workTriageSentence = (summary: WorkTriageSummary): string => {
  switch (summary._tag) {
    case "Attention":
      if (summary.needsYou === 0) return `Nothing needs you, ${summary.blocked} blocked`
      return summary.blocked === 0
        ? `${plural(summary.needsYou, "goal needs", "goals need")} you`
        : `${plural(summary.needsYou, "goal needs", "goals need")} you, ${summary.blocked} blocked`
    case "Clear":
      return "Nothing needs you"
    case "Empty":
      return "No goals yet"
  }
}

/** Group titles as the tab shows them. */
export const workTriageGroupTitle = {
  "needs-you": "Needs you",
  blocked: "Blocked",
  moving: "Moving",
  done: "Done in the last 24 hours",
  earlier: "Finished earlier"
} satisfies Readonly<Record<WorkTriageGroup, string>>
