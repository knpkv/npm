/**
 * Turning one reconciliation report into the week the browser draws, and holding the evidence.
 *
 * **Mental model**
 *
 * - **One read answers the whole week.** A report already carries what both systems hold and what
 *   the sessions evidence, so allocated time and proposable time are two views of one payload rather
 *   than two round trips that could disagree.
 * - **A row is a `(Issue Key, day)` cell, and it exists if either side has anything.** A day tracked
 *   with a Timer has no proposal; a day nobody logged has no allocated seconds. Showing them in one
 *   grid is the point — the gap is only visible next to what is already there.
 * - **The evidence stays here.** The wire carries spans so the browser can draw when work happened,
 *   but a confirmation names a row, and this module is what turns that name back into the engine's
 *   own proposal. Nothing a browser sends can widen it.
 *
 * @module
 */
import type { AgentSessions, ReconcileService } from "@knpkv/jira-clockify"
import { Time } from "@knpkv/jira-clockify"
import type { WeekPlanResponse, WeekRowResponse } from "./Api.js"

/** How a confirmation names a row. Deterministic, so re-reading a week keeps the same names. */
export const rowId = (ticketKey: string, day: string): string => `${day}:${ticketKey}`

/** The seven local days of the ISO week beginning at `monday`. */
export const weekDays = (monday: Date): ReadonlyArray<string> => {
  const days: Array<string> = []
  let atMs = monday.getTime()
  for (let index = 0; index < 7; index++) {
    days.push(Time.localDay(new Date(atMs)))
    atMs = Time.nextLocalMidnight(atMs)
  }
  return days
}

/** One row's proposal as the engine produced it, kept whole for the write path. */
export interface RowEvidence {
  readonly rowId: string
  readonly proposal: AgentSessions.SessionProposal
}

/**
 * A plan the server still holds: what it sent, and the evidence behind every proposable row.
 *
 * Held rather than re-derived because deriving it reads every transcript in the window and may wake
 * a Coding Agent. Confirming four rows would otherwise pay for that four more times — and each run
 * could place a session differently from the plan the person was looking at.
 */
export interface HeldPlan {
  readonly planId: string
  readonly createdAtMillis: number
  readonly plan: WeekPlanResponse
  readonly evidence: ReadonlyMap<string, RowEvidence>
}

interface RowDraft {
  clockifyDescription: string | null
  clockifySeconds: number
  day: string
  jiraSeconds: number
  proposal: AgentSessions.SessionProposal | undefined
  ticketKey: string
}

const emptyRow = (ticketKey: string, day: string): RowDraft => ({
  clockifyDescription: null,
  clockifySeconds: 0,
  day,
  jiraSeconds: 0,
  proposal: undefined,
  ticketKey
})

const toWire = (draft: RowDraft): WeekRowResponse => ({
  clockifyDescription: draft.clockifyDescription,
  clockifySeconds: draft.clockifySeconds,
  day: draft.day,
  jiraSeconds: draft.jiraSeconds,
  rowId: rowId(draft.ticketKey, draft.day),
  ticketKey: draft.ticketKey,
  ...(draft.proposal === undefined ? {} : {
    proposal: {
      activeSeconds: draft.proposal.activeSeconds,
      clockifyDelta: draft.proposal.clockifyDelta,
      confidence: draft.proposal.confidence,
      jiraDelta: draft.proposal.jiraDelta,
      // The credited evidence, which is the ceiling on an edited amount — not the gap, which is
      // only what is missing right now and would fall to zero the moment one side is filled.
      maxSeconds: draft.proposal.sessionSeconds,
      sessionCount: draft.proposal.sessionIds.length,
      signal: draft.proposal.signal,
      spans: draft.proposal.spans.map((span) => ({ endMs: span.endMs, startMs: span.startMs }))
    }
  })
})

/**
 * Build the week the browser draws from one report.
 *
 * Rows are keyed by `(Issue Key, day)` and sorted by Issue Key then day, so a re-read after a write
 * puts every row back where the reader last saw it.
 */
export const buildWeekPlan = (options: {
  readonly planId: string
  readonly monday: Date
  readonly createdAtMillis: number
  readonly report: ReconcileService.SessionProposalReport
}): HeldPlan => {
  const days = weekDays(options.monday)
  // The report was read for exactly this week, so this only guards the two disagreeing. A row for
  // another week would have no column to sit in, and dropping it silently is worse than not sending
  // it at all.
  const inWeek = new Set(days)
  const drafts = new Map<string, RowDraft>()
  const draftFor = (ticketKey: string, day: string): RowDraft => {
    const id = rowId(ticketKey, day)
    const existing = drafts.get(id)
    if (existing !== undefined) return existing
    const created = emptyRow(ticketKey, day)
    drafts.set(id, created)
    return created
  }

  for (const recorded of options.report.recorded) {
    if (!inWeek.has(recorded.day)) continue
    const draft = draftFor(recorded.ticketKey, recorded.day)
    draft.clockifySeconds = recorded.clockifySeconds
    draft.jiraSeconds = recorded.jiraSeconds
    draft.clockifyDescription = recorded.clockifyDescription
  }

  const evidence = new Map<string, RowEvidence>()
  for (const proposal of options.report.proposals) {
    if (!inWeek.has(proposal.day)) continue
    const draft = draftFor(proposal.ticketKey, proposal.day)
    draft.proposal = proposal
    const id = rowId(proposal.ticketKey, proposal.day)
    evidence.set(id, { proposal, rowId: id })
  }

  const rows = [...drafts.values()]
    .sort((a, b) => (a.ticketKey === b.ticketKey ? a.day.localeCompare(b.day) : a.ticketKey.localeCompare(b.ticketKey)))
    .map(toWire)

  return {
    createdAtMillis: options.createdAtMillis,
    evidence,
    plan: {
      attributorAvailable: options.report.attributorAvailable,
      attributorCalls: options.report.attributorCalls,
      days,
      excludedDays: options.report.excludedDays
        .filter((excluded) => inWeek.has(excluded.day))
        .map((excluded) => ({ day: excluded.day, reason: excluded.reason })),
      monday: days[0]!,
      planId: options.planId,
      rows,
      sessionCount: options.report.sessionCount,
      sessionRootCount: options.report.sessionRootCount,
      unattributed: options.report.unattributed
        .filter((credit) => inWeek.has(credit.day))
        .map((credit) => ({
          cwds: [...credit.cwds],
          day: credit.day,
          seconds: credit.seconds,
          sessionCount: credit.sessionCount
        })),
      withheld: options.report.withheld
        .filter((credit) => inWeek.has(credit.day))
        .map((credit) => ({
          confidence: credit.confidence,
          day: credit.day,
          seconds: credit.seconds,
          ticketKey: credit.ticketKey
        }))
    },
    planId: options.planId
  }
}

/**
 * What accepting a row would write, given a live re-tally of the target bucket.
 *
 * Every number here is the server's: `credited` is the evidence the plan was built from, and `held`
 * is what the two systems answered a moment ago. `requested` is the only input a person supplies,
 * and it is capped by the evidence rather than clamped to it — silently writing less than someone
 * asked for is its own kind of wrong.
 */
export type ProposedWrite =
  | {
    readonly _tag: "Write"
    readonly clockifyDelta: number
    readonly jiraDelta: number
  }
  | { readonly _tag: "NothingOwed" }
  | { readonly _tag: "PastEvidence"; readonly maxSeconds: number }
  | { readonly _tag: "BelowMinimum"; readonly minimumSeconds: number }

/**
 * Below this a gap is noise rather than work: Jira floors worklogs to the minute, so a shorter write
 * could not be made faithfully even if it were offered. The same bound the engine proposes on.
 */
export const MINIMUM_WRITE_SECONDS = 60

export const proposeWrite = (options: {
  readonly credited: number
  readonly requested: number | undefined
  readonly heldClockifySeconds: number
  readonly heldJiraSeconds: number
}): ProposedWrite => {
  const requested = options.requested ?? options.credited
  if (requested > options.credited) return { _tag: "PastEvidence", maxSeconds: options.credited }
  if (requested < MINIMUM_WRITE_SECONDS) {
    return { _tag: "BelowMinimum", minimumSeconds: MINIMUM_WRITE_SECONDS }
  }
  const clockifyDelta = Math.max(0, requested - options.heldClockifySeconds)
  const jiraDelta = Math.max(0, requested - options.heldJiraSeconds)
  // Under a minute on both sides is the ordinary outcome of confirming a row twice, or of a watch
  // having taken it in between. It is not a failure and it is not a write.
  if (clockifyDelta < MINIMUM_WRITE_SECONDS && jiraDelta < MINIMUM_WRITE_SECONDS) return { _tag: "NothingOwed" }
  return {
    _tag: "Write",
    clockifyDelta: clockifyDelta < MINIMUM_WRITE_SECONDS ? 0 : clockifyDelta,
    jiraDelta: jiraDelta < MINIMUM_WRITE_SECONDS ? 0 : jiraDelta
  }
}
