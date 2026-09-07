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
import type { AgentSessions, IssueFacts, ReconcileService } from "@knpkv/jira-clockify"
import { Time } from "@knpkv/jira-clockify"
import type {
  NotMineRowResponse,
  OwnershipMode,
  RecordedIntervalResponse,
  WeekPlanResponse,
  WeekRowResponse,
  WeekScopeName
} from "./Api.js"

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

/** The systems a plan was read under — what a confirmation writes to unless it says otherwise. */
export const planSides = (plan: HeldPlan): ReconcileService.ReconcileSides => sidesOfScope(plan.plan.scope)

interface RowDraft {
  clockifyDescription: string | null
  clockifySeconds: number
  day: string
  intervals: ReadonlyArray<RecordedIntervalResponse>
  jiraSeconds: number
  proposal: AgentSessions.SessionProposal | undefined
  ticketKey: string
  ticketTitle: string | null
}

/**
 * What Jira says about the tickets in a week, and whether it could be asked at all.
 *
 * Passed in rather than looked up here so this stays a pure function of one report plus one set of
 * answers — which is what makes the ownership rule testable without a Jira anywhere near it.
 */
export interface OwnershipInput {
  readonly facts: ReadonlyMap<string, IssueFacts.IssueFact>
  readonly checked: boolean
  readonly mode: OwnershipMode
  /** Issue Keys a person has said are theirs regardless. */
  readonly overrides: ReadonlyArray<string>
}

export const anyOwner: OwnershipInput = { checked: false, facts: new Map(), mode: "any", overrides: [] }

/**
 * Whether a row may be proposed on this Issue Key.
 *
 * Four ways to be yours, and only one way not to be: the mode is `any`, the key is overridden, Jira
 * says you are the assignee — or Jira was never asked. A row is withheld only on a positive answer
 * that names somebody else, because withholding on silence is how hours disappear.
 */
export const isOwnedByMe = (ticketKey: string, ownership: OwnershipInput): boolean => {
  if (ownership.mode === "any") return true
  if (ownership.overrides.includes(ticketKey)) return true
  const fact = ownership.facts.get(ticketKey)
  return fact === undefined || fact.mine
}

const emptyRow = (ticketKey: string, day: string): RowDraft => ({
  clockifyDescription: null,
  clockifySeconds: 0,
  day,
  intervals: [],
  jiraSeconds: 0,
  proposal: undefined,
  ticketKey,
  ticketTitle: null
})

/** Which systems a scope name puts in play. */
export const sidesOfScope = (scope: WeekScopeName): ReconcileService.ReconcileSides => ({
  clockify: scope !== "jira",
  jira: scope !== "clockify"
})

const toWire = (draft: RowDraft): WeekRowResponse => ({
  clockifyDescription: draft.clockifyDescription,
  clockifySeconds: draft.clockifySeconds,
  day: draft.day,
  intervals: draft.intervals,
  jiraSeconds: draft.jiraSeconds,
  rowId: rowId(draft.ticketKey, draft.day),
  ticketKey: draft.ticketKey,
  ticketTitle: draft.ticketTitle,
  ...(draft.proposal === undefined ? {} : {
    proposal: {
      activeSeconds: draft.proposal.activeSeconds,
      blocks: draft.proposal.blocks.map((block) => ({
        endMs: block.endMs,
        seconds: block.seconds,
        startMs: block.startMs
      })),
      clockifyDelta: draft.proposal.clockifyDelta,
      confidence: draft.proposal.confidence,
      jiraDelta: draft.proposal.jiraDelta,
      // The credited evidence, which is the ceiling on an edited amount — not the gap, which is
      // only what is missing right now and would fall to zero the moment one side is filled.
      maxSeconds: draft.proposal.sessionSeconds,
      sessionCount: draft.proposal.sessionIds.length,
      signal: draft.proposal.signal
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
  readonly scope: WeekScopeName
  readonly report: ReconcileService.SessionProposalReport
  /** What Jira says about these tickets. Omitted means nobody asked, so nothing is withheld. */
  readonly ownership?: OwnershipInput | undefined
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
    draft.intervals = recorded.intervals.map((interval) => ({
      endMs: interval.endMs,
      source: interval.source,
      startMs: interval.startMs
    }))
  }

  const ownership = options.ownership ?? anyOwner
  const evidence = new Map<string, RowEvidence>()
  const notMine: Array<NotMineRowResponse> = []
  for (const proposal of options.report.proposals) {
    if (!inWeek.has(proposal.day)) continue
    // A ticket Jira says belongs to somebody else keeps its hours and loses its offer: no proposal
    // on the row and no evidence held, so there is nothing for a confirmation to name either.
    if (!isOwnedByMe(proposal.ticketKey, ownership)) {
      notMine.push({
        assignee: ownership.facts.get(proposal.ticketKey)?.assignee ?? null,
        day: proposal.day,
        seconds: proposal.sessionSeconds,
        signal: proposal.signal,
        ticketKey: proposal.ticketKey,
        ticketTitle: ownership.facts.get(proposal.ticketKey)?.title ?? null
      })
      continue
    }
    const draft = draftFor(proposal.ticketKey, proposal.day)
    draft.proposal = proposal
    const id = rowId(proposal.ticketKey, proposal.day)
    evidence.set(id, { proposal, rowId: id })
  }

  // Titles last, so every row that exists gets one — including a row that only Clockify knows about.
  for (const draft of drafts.values()) {
    draft.ticketTitle = ownership.facts.get(draft.ticketKey)?.title ?? null
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
      notMine: notMine.sort((
        a,
        b
      ) => (a.day === b.day ? a.ticketKey.localeCompare(b.ticketKey) : a.day.localeCompare(b.day))),
      ownership: ownership.mode,
      ownershipChecked: ownership.checked,
      planId: options.planId,
      rows,
      scope: options.scope,
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
          ticketKey: credit.ticketKey,
          ticketTitle: ownership.facts.get(credit.ticketKey)?.title ?? null
        }))
    },
    planId: options.planId
  }
}

/**
 * The blocks a confirmation named, or every block when it named none.
 *
 * `undefined` for an index that is not a block of this row: a stale page confirming against a plan
 * that has been re-read is a case to refuse, not to write a guess for.
 */
export const selectedBlocks = (
  blocks: ReadonlyArray<AgentSessions.CreditedBlock>,
  chosen: ReadonlyArray<number> | undefined
): ReadonlyArray<AgentSessions.CreditedBlock> | undefined => {
  if (chosen === undefined) return blocks
  const picked: Array<AgentSessions.CreditedBlock> = []
  for (const index of [...new Set(chosen)].sort((a, b) => a - b)) {
    const block = blocks[index]
    if (block === undefined) return undefined
    picked.push(block)
  }
  return picked.length === 0 ? undefined : picked
}

/**
 * What accepting a row would write, given a live re-tally of the target bucket.
 *
 * Every number here is the server's: `credited` is the evidence the plan was built from, `selected`
 * is the part of it a person is accepting now, and `held` is what the two systems answered a moment
 * ago. `requested` is the only input a person supplies, and it is capped by the selection rather
 * than clamped to it — silently writing less than someone asked for is its own kind of wrong.
 *
 * **Why a side is sized against the whole row and not against the selection.** `credited - held` is
 * the room left in the day; the selection only says how much of that room to use now. Sizing a
 * block against `selected - held` instead would report "already logged" for the second block of any
 * row whose first block is already in — the arithmetic would treat the morning's entry as evidence
 * that the afternoon had been written too.
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
  /** The blocks being accepted now. Defaults to the whole row. */
  readonly selected?: number | undefined
  readonly requested: number | undefined
  readonly heldClockifySeconds: number
  readonly heldJiraSeconds: number
  /** Which systems are in play. A side that is out gets a zero delta, never a gap. */
  readonly targets?: { readonly clockify: boolean; readonly jira: boolean } | undefined
}): ProposedWrite => {
  const targets = options.targets ?? { clockify: true, jira: true }
  const selected = Math.min(options.selected ?? options.credited, options.credited)
  const requested = options.requested ?? selected
  if (requested > selected) return { _tag: "PastEvidence", maxSeconds: selected }
  if (requested < MINIMUM_WRITE_SECONDS) {
    return { _tag: "BelowMinimum", minimumSeconds: MINIMUM_WRITE_SECONDS }
  }
  const owed = (held: number, asked: boolean): number => {
    if (!asked) return 0
    // Room left in the day, then as much of it as this selection asks for.
    const room = Math.max(0, options.credited - held)
    const delta = Math.min(requested, room)
    // Under a minute is a rounding artefact rather than work: Jira floors worklogs to the minute.
    return delta < MINIMUM_WRITE_SECONDS ? 0 : delta
  }
  const clockifyDelta = owed(options.heldClockifySeconds, targets.clockify)
  const jiraDelta = owed(options.heldJiraSeconds, targets.jira)
  // Nothing left on either side asked for: the ordinary outcome of confirming a row twice, or of a
  // watch having taken it in between. Not a failure, and not a write.
  if (clockifyDelta === 0 && jiraDelta === 0) return { _tag: "NothingOwed" }
  return { _tag: "Write", clockifyDelta, jiraDelta }
}
