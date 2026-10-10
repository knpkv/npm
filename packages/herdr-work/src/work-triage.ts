/**
 * The Work tab's triage: which goals need the viewer, which are blocked, which are moving, which
 * have not started, and which finished in the last 24 hours, plus the one-sentence summary above them.
 *
 * Pure: callers pass one snapshot. View-only derivation lives here; the goal model, its
 * projection and observed facts stay in `model.ts`/`projection.ts`.
 *
 * A goal needs the viewer when it has an open request: someone asked for an approval only a
 * person can give. Blocked and finished follow the displayed state: the observed overlay's when it
 * has one (a merged pull request is done, a closed one abandoned), else the recorded state. Done
 * counts goals that finished within 24 hours of the snapshot (the pull request's close time when
 * that is what finished them, else the goal's last update), labelled as such, never as "since
 * you looked"; older finished goals stay listed last, as "Finished earlier", so a status filter
 * still finds them.
 */
import type { WorkDisplayState, WorkGoal, WorkRequest, WorkSnapshot } from "./model.js"

const DAY_MS = 86_400_000

/** How long a finished goal stays in the "Finished in the last 24 hours" group. */
export const workTriageDoneWindowMs = DAY_MS

/** The groups, in reading order. */
export type WorkTriageGroup = "needs-you" | "blocked" | "moving" | "planned" | "done" | "earlier"

export const workTriageGroups: ReadonlyArray<WorkTriageGroup> = [
  "needs-you",
  "blocked",
  "moving",
  "planned",
  "done",
  "earlier"
]

export interface WorkTriageRow {
  readonly goal: WorkGoal
  /** The state the tab shows: observed when the overlay has one, else recorded. */
  readonly displayState: WorkDisplayState
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

/**
 * Which displayed states have finished. Keyed by every WorkDisplayState, so a new state must be
 * placed here to compile.
 */
const terminalState = {
  planned: false,
  working: false,
  blocked: false,
  review: false,
  deployed: true,
  completed: true,
  abandoned: true
} satisfies Readonly<Record<WorkDisplayState, boolean>>

const openRequestsOf = (goal: WorkGoal): ReadonlyArray<WorkRequest> =>
  (goal.requests ?? []).filter((request) => request.state === "open").toSorted((a, b) => a.requestedAt - b.requestedAt)

/**
 * One group per goal, first match wins. An open request outranks every state, so a blocked goal
 * with an open request is in "needs you" and not in the blocked count. A request without an
 * approval target still counts: a person must act, even when the hub link is missing.
 */
const groupOf = (
  finishedAt: number,
  displayState: WorkDisplayState,
  openRequests: ReadonlyArray<WorkRequest>,
  asOf: number
): WorkTriageGroup => {
  if (openRequests.length > 0) return "needs-you"
  if (displayState === "blocked") return "blocked"
  if (terminalState[displayState]) return asOf - finishedAt <= workTriageDoneWindowMs ? "done" : "earlier"
  // Not started yet: listed after the work that is moving, never counted as moving.
  if (displayState === "planned") return "planned"
  return "moving"
}

const groupOrder = { "needs-you": 0, blocked: 1, moving: 2, planned: 3, done: 4, earlier: 5 } satisfies Readonly<
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

/**
 * Sorts one snapshot's goals into the triage groups and states the summary. A bounded snapshot
 * leaves out finished goals first (counted in `goalsOmitted`), so open goals are all here unless
 * finished ones alone could not make room; only then can a zero undercount.
 */
export const workTriage = (snapshot: Pick<WorkSnapshot, "asOf" | "goals" | "observed">): WorkTriage => {
  const overlay = new Map((snapshot.observed ?? []).map((entry) => [entry.goalId, entry]))
  const rows = snapshot.goals
    .map((goal, index): WorkTriageRow => {
      const openRequests = openRequestsOf(goal)
      const observed = overlay.get(goal.id) ?? null
      const displayState = observed?.displayState ?? goal.state
      // A goal its owner already recorded as finished finished then; one finished only by its observed
      // pull request finished when that pull request closed.
      const finishedAt = terminalState[goal.state]
        ? goal.updatedAt
        : (observed?.pullRequest?.fact.closedAt ?? goal.updatedAt)
      return {
        displayState,
        goal,
        group: groupOf(finishedAt, displayState, openRequests, snapshot.asOf),
        index,
        openRequests
      }
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

/**
 * `present` for the live snapshot; `past` for a historical window, which is the state as of its
 * time, not now: requests answered since still count there, and newer ones are missing.
 */
export type WorkTriageTense = "present" | "past"

/**
 * The summary as its one sentence: "3 goals need you, 2 blocked", "Nothing needs you", "No goals
 * yet"; in the past tense "3 goals needed you, 2 blocked", "Nothing needed you", "No goals".
 */
export const workTriageSentence = (summary: WorkTriageSummary, tense: WorkTriageTense = "present"): string => {
  const [one, many, nothing] = tense === "present"
    ? ["goal needs", "goals need", "Nothing needs you"]
    : ["goal needed", "goals needed", "Nothing needed you"]
  switch (summary._tag) {
    case "Attention":
      if (summary.needsYou === 0) return `${nothing}, ${summary.blocked} blocked`
      return summary.blocked === 0
        ? `${plural(summary.needsYou, one, many)} you`
        : `${plural(summary.needsYou, one, many)} you, ${summary.blocked} blocked`
    case "Clear":
      return nothing
    case "Empty":
      return tense === "present" ? "No goals yet" : "No goals"
  }
}

/** Group titles as the tab shows them. */
export const workTriageGroupTitle = {
  "needs-you": "Needs you",
  blocked: "Blocked",
  moving: "Moving",
  planned: "Not started",
  // Completed, deployed and abandoned alike; each row's state word says which.
  done: "Finished in the last 24 hours",
  earlier: "Finished earlier"
} satisfies Readonly<Record<WorkTriageGroup, string>>
