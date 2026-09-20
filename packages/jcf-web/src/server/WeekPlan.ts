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
import { IssueFacts, SourceConsumption, Time } from "@knpkv/jira-clockify"
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
  /** Server-held attribution and ownership snapshot. Never accepted from a browser payload. */
  readonly report: ReconcileService.SessionProposalReport
  readonly ownership: OwnershipInput
  readonly planId: string
  readonly createdAtMillis: number
  readonly plan: WeekPlanResponse
  readonly evidence: ReadonlyMap<string, RowEvidence>
  /** Server-only scopes bound by a complete read or first explicitly enabled confirmation. */
  readonly boundScopes: { clockify: string | null; jira: string | null }
  /** Source blocks consumed under corrected ticket labels, independently for each provider. */
  readonly consumption: SourceConsumption.Consumption
  /** Jira targets with successful writes that bypass eventually consistent JQL discovery. */
  readonly jiraReceiptIssueKeys: Set<string>
}

/** In-memory allocation position; the durable provider binding still names only the source cluster. */
export const evidenceBlockKey = (row: string, block: AgentSessions.CreditedBlock): string =>
  JSON.stringify([row, block.sourceStartMs ?? block.startMs, block.allocationIndex ?? 0])

/** Durable source identity carried by entries written under a corrected ticket. */
export const evidenceMarker = (row: string, block: AgentSessions.CreditedBlock): string =>
  SourceConsumption.marker(row, block.sourceStartMs ?? block.startMs)

/** Rebuild corrected-ticket consumption against the blocks in this read. */
export const reconcileConsumption = (
  report: ReconcileService.SessionProposalReport,
  previous: HeldPlan["consumption"] = new Map()
): HeldPlan["consumption"] => {
  const consumptionRows = [
    ...report.recorded,
    ...report.unlinkedClockify.map((slice) => ({
      day: slice.day,
      intervals: slice.entry === undefined ? [] : [{ entry: slice.entry }]
    }))
  ]
  const reconciled: HeldPlan["consumption"] = new Map()
  for (const credit of report.attributed) {
    const recorded = report.recorded.find((row) => row.ticketKey === credit.ticketKey && row.day === credit.day)
    const sourceRowId = `${credit.day}:${credit.ticketKey}`
    const markedByBlock = SourceConsumption.consumptionForBlocks(
      consumptionRows,
      sourceRowId,
      credit.blocks,
      report.sides,
      report.sourceEntries
    )
    for (const [index, block] of credit.blocks.entries()) {
      const key = evidenceBlockKey(sourceRowId, block)
      const old = previous.get(key) ?? { clockify: 0, jira: 0 }
      const marked = markedByBlock[index] ?? { clockify: 0, jira: 0 }
      const ordinaryClockify = SourceConsumption.recordedSecondsInBlock(
        block,
        recorded?.intervals ?? [],
        "clockify"
      )
      const ordinaryJira = SourceConsumption.recordedSecondsInBlock(block, recorded?.intervals ?? [], "jira")
      const value = {
        clockify: report.sides.clockify
          ? Math.min(block.seconds, marked.clockify + ordinaryClockify)
          : old.clockify,
        jira: report.sides.jira
          ? Math.min(block.seconds, marked.jira + ordinaryJira)
          : old.jira
      }
      if (value.clockify > 0 || value.jira > 0) reconciled.set(key, value)
      else reconciled.delete(key)
    }
  }
  return reconciled
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
export const isOwnedByMe = IssueFacts.isOwnedByMe

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

/** An absent key in the server-reconciled map means this block has no provider consumption. */
const consumedForBlock = (
  row: string,
  block: AgentSessions.CreditedBlock,
  consumption: HeldPlan["consumption"]
) => consumption.get(evidenceBlockKey(row, block)) ?? { clockify: 0, jira: 0 }

const toWire = (draft: RowDraft, consumption: HeldPlan["consumption"]): WeekRowResponse => ({
  clockifyDescription: draft.clockifyDescription,
  clockifySeconds: draft.clockifySeconds,
  day: draft.day,
  intervals: draft.intervals,
  jiraSeconds: draft.jiraSeconds,
  rowId: rowId(draft.ticketKey, draft.day),
  ticketKey: draft.ticketKey,
  ticketTitle: draft.ticketTitle,
  proposal: draft.proposal === undefined ? undefined : {
    activeSeconds: draft.proposal.activeSeconds,
    blocks: draft.proposal.blocks.map((block) => ({
      ...(block.clockifyRefusal !== undefined && { clockifyRefusal: block.clockifyRefusal }),
      consumed: consumedForBlock(rowId(draft.ticketKey, draft.day), block, consumption),
      endMs: block.endMs,
      seconds: block.seconds,
      startMs: block.startMs,
      ...(block.sourceStartMs !== undefined && { sourceStartMs: block.sourceStartMs })
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

/** Reproject browser blocks when retention changes the authoritative consumed-time map. */
export const withProjectedConsumption = (held: HeldPlan, consumption: HeldPlan["consumption"]): HeldPlan => ({
  ...held,
  consumption,
  plan: {
    ...held.plan,
    rows: held.plan.rows.map((row) =>
      row.proposal === undefined
        ? row
        : {
          ...row,
          proposal: {
            ...row.proposal,
            blocks: row.proposal.blocks.map((block) => ({
              ...block,
              consumed: consumedForBlock(row.rowId, block, consumption)
            }))
          }
        }
    )
  }
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
  /** Initial scans use their opaque plan ID; later snapshots supply fresh or retained entry handles. */
  readonly entryRevision?: (entry: ReconcileService.RecordedEntry) => string
  /** Defaults to true for explicit scans; recorded-only reads must pass false. */
  readonly sessionScanAvailable?: boolean | undefined
  readonly consumption?: HeldPlan["consumption"] | undefined
  readonly jiraReceiptIssueKeys?: HeldPlan["jiraReceiptIssueKeys"] | undefined
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
    draft.intervals = recorded.intervals.map((interval) => {
      const projected = { endMs: interval.endMs, source: interval.source, startMs: interval.startMs }
      if (interval.entry === undefined) return projected
      return {
        ...projected,
        entry: { ...interval.entry, revision: options.entryRevision?.(interval.entry) ?? options.planId }
      }
    })
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

  const consumption = reconcileConsumption(options.report, options.consumption)
  const rows = [...drafts.values()]
    .sort((a, b) => (a.ticketKey === b.ticketKey ? a.day.localeCompare(b.day) : a.ticketKey.localeCompare(b.ticketKey)))
    .map((draft) => toWire(draft, consumption))

  return {
    report: options.report,
    boundScopes: {
      clockify: options.report.sourceScopes?.clockify ?? null,
      jira: options.report.sourceScopes?.jira ?? null
    },
    ownership,
    createdAtMillis: options.createdAtMillis,
    evidence,
    consumption,
    jiraReceiptIssueKeys: options.jiraReceiptIssueKeys ?? new Set(),
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
      unlinkedClockify: options.report.unlinkedClockify.filter((entry) => inWeek.has(entry.day)).map((
        { entry, ...slice }
      ) => {
        if (entry === undefined) return slice
        return { ...slice, entry: { ...entry, revision: options.entryRevision?.(entry) ?? options.planId } }
      }),
      scope: options.scope,
      sessionCount: options.report.sessionCount,
      sessionScanAvailable: options.sessionScanAvailable ?? true,
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

export { MINIMUM_WRITE_SECONDS, type ProposedWrite, proposeWrite, selectedBlocks } from "../shared/writePlanning.js"
