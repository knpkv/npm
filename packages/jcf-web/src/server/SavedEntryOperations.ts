/** Saved provider entries resolve only through retained weeks; generation consumes retained digests. */
import type { SavedEntries, SessionAttributor } from "@knpkv/jira-clockify"
import { AgentSessions, ReconcileService, SourceConsumption, Time } from "@knpkv/jira-clockify"
import { Clock, Effect } from "effect"
import {
  ApiError,
  type DescribeSavedEntryRequest,
  PlanExpiredError,
  ProposalRejectedError,
  type SavedEntry,
  type UpdateSavedEntryRequest
} from "../shared/contracts.js"
import { MINIMUM_WRITE_SECONDS } from "../shared/writePlanning.js"
import { buildWeekPlan, type HeldPlan } from "./WeekPlan.js"

/** Metadata must agree with its retained provider. A description edit may change its ticket prefix. */
export const findSavedEntry = (plan: HeldPlan, request: DescribeSavedEntryRequest): SavedEntry | undefined => {
  if (plan.plan.scope !== "both" && plan.plan.scope !== request.source) return undefined
  const matches = (entry: SavedEntry) => entry.source === request.source && entry.id === request.entryId
  for (const row of plan.plan.rows) {
    for (const interval of row.intervals) {
      if (
        interval.entry !== undefined && interval.source === request.source &&
        matches(interval.entry)
      ) return interval.entry
    }
  }
  return plan.plan.unlinkedClockify.find(({ entry }) =>
    entry !== undefined && entry.source === "clockify" && matches(entry)
  )?.entry
}

/** Provider refreshes keep the handle only when every expected field still describes the same entry. */
export const retainedEntryRevision = (plan: HeldPlan, entry: ReconcileService.RecordedEntry, fresh: string): string => {
  const previous = findSavedEntry(plan, { planId: plan.planId, source: entry.source, entryId: entry.id })
  return previous !== undefined && previous.source === entry.source && previous.id === entry.id &&
      previous.ticketKey === entry.ticketKey && previous.startMs === entry.startMs &&
      previous.endMs === entry.endMs && previous.description === entry.description
    ? previous.revision
    : fresh
}

/** Rebuild provider slices and proposal deltas locally so a failed totals refresh cannot undo a save. */
export const replaceSavedEntry = (plan: HeldPlan, entry: SavedEntry): HeldPlan => {
  const matches = (candidate: ReconcileService.RecordedEntry | undefined) =>
    candidate?.source === entry.source && candidate.id === entry.id
  const seconds = (interval: { readonly startMs: number; readonly endMs: number }) =>
    Math.round((interval.endMs - interval.startMs) / 1000)
  const tally = (source: SavedEntry["source"]): Array<ReconcileService.DayTally[number]> =>
    plan.report.recorded.flatMap((row) => {
      const intervals = row.intervals.filter((interval) => interval.source === source)
      const remaining = intervals.filter((interval) => !matches(interval.entry)).map((interval) => ({
        ...interval,
        day: row.day,
        ticketKey: row.ticketKey,
        seconds: seconds(interval),
        description: interval.entry === undefined
          ? (source === "clockify" ? row.clockifyDescription : null)
          : interval.entry.description
      }))
      const residual = (source === "clockify" ? row.clockifySeconds : row.jiraSeconds) -
        intervals.reduce((sum, interval) => sum + seconds(interval), 0)
      return residual === 0
        ? remaining
        : [...remaining, {
          day: row.day,
          ticketKey: row.ticketKey,
          seconds: residual,
          description: source === "clockify" ? row.clockifyDescription : null
        }]
    })
  const clockify = tally("clockify")
  const jira = tally("jira")
  const unlinked = plan.report.unlinkedClockify.filter((slice) => !matches(slice.entry))
  for (
    const { day, endMs, seconds: sliceSeconds, startMs } of Time.splitIntervalByLocalDay(
      entry.startMs,
      entry.endMs
    )
  ) {
    const slice = {
      entry,
      startMs,
      endMs,
      day,
      seconds: sliceSeconds,
      description: entry.description
    }
    if (entry.ticketKey !== null) {
      const target = entry.source === "clockify" ? clockify : jira
      target.push({ ...slice, ticketKey: entry.ticketKey })
    } else if (entry.source === "clockify") {
      unlinked.push(slice)
    }
  }
  const recorded = ReconcileService.buildReconcileRows(clockify, jira)
  const sourceEntries = plan.report.sourceEntries?.map((source) =>
    source.source === entry.source && source.id === entry.id
      ? { ...source, startMs: entry.startMs, endMs: entry.endMs }
      : source
  )
  const report = {
    ...plan.report,
    recorded,
    unlinkedClockify: unlinked,
    sourceEntries,
    proposals: AgentSessions.buildSessionProposals(plan.report.attributed, recorded, {
      minimumSeconds: MINIMUM_WRITE_SECONDS,
      excludedDays: plan.report.excludedDays.map((excluded) => excluded.day),
      sides: plan.report.sides,
      sourceEntries,
      consumptionRows: unlinked.map((slice) => ({
        day: slice.day,
        intervals: slice.entry === undefined ? [] : [{ entry: slice.entry }]
      }))
    })
  }
  return buildWeekPlan({
    planId: plan.planId,
    createdAtMillis: plan.createdAtMillis,
    monday: new Date(`${plan.plan.monday}T00:00:00`),
    scope: plan.plan.scope,
    sessionScanAvailable: plan.plan.sessionScanAvailable,
    consumption: plan.consumption,
    jiraReceiptIssueKeys: plan.jiraReceiptIssueKeys,
    ownership: plan.ownership,
    entryRevision: (candidate) =>
      matches(candidate) ? entry.revision : findSavedEntry(plan, {
        planId: plan.planId,
        source: candidate.source,
        entryId: candidate.id
      })?.revision ?? plan.planId,
    report
  })
}

/** A changed interval stays in the retained week and is at most one day. Long unchanged entries remain editable. */
export const validateSavedUpdate = Effect.fn("SavedEntryOperations.validate")(function*(
  plan: HeldPlan,
  expected: SavedEntry,
  request: UpdateSavedEntryRequest
) {
  const changed = expected.startMs !== request.startMs || expected.endMs !== request.endMs
  if (changed) {
    const nowMs = yield* Clock.currentTimeMillis
    if (request.startMs > nowMs || request.endMs > nowMs) {
      return yield* new ProposalRejectedError({ message: "Choose an interval that has already ended." })
    }
  }
  const period = Time.isoWeekPeriod(new Date(`${plan.plan.monday}T00:00:00`))
  if (changed && expected.source === "jira" && request.startMs < period.from.getTime()) {
    return yield* new ProposalRejectedError({
      message: "Choose a Jira worklog start within this week."
    })
  }
  if (
    request.endMs <= request.startMs ||
    (changed && (request.endMs - request.startMs > 86400000 || request.endMs <= period.from.getTime() ||
      request.startMs >= period.to.getTime()))
  ) {
    return yield* new ProposalRejectedError({
      message: "Choose a positive interval of at most 24 hours overlapping this week."
    })
  }
})

export const savedEntryFailure = (error: SavedEntries.SavedEntryError) => {
  switch (error.reason) {
    case "validation":
      return new ProposalRejectedError({ message: error.message })
    case "conflict":
      return new PlanExpiredError({ message: error.message })
    case "provider":
      return new ApiError({ message: error.message })
  }
}

/** Only individually overlapping sessions qualify. An unkeyed entry with several matches is ambiguous. */
export const describeSavedEntry = Effect.fn("SavedEntryOperations.describe")(function*(options: {
  readonly plan: HeldPlan
  readonly entry: SavedEntry
  readonly attributor: SessionAttributor.SessionAttributorContract
}) {
  const { attributor, entry, plan } = options
  const sessions = (plan.report.sessionEvidence ?? []).filter((session) =>
    (entry.ticketKey === null || session.ticketKey === entry.ticketKey) &&
    session.spans.some((span) => span.startMs < entry.endMs && span.endMs > entry.startMs) &&
    (plan.report.digests.get(session.sessionId)?.trim().length ?? 0) > 0
  )
  const ids = [...new Set(sessions.map((session) => session.sessionId))]
  if (ids.length === 0 || (entry.ticketKey === null && ids.length !== 1)) return { note: null, sessionCount: 0 }
  const digest = ids.map((id) => plan.report.digests.get(id)).join("\n\n").slice(0, 24000)
  const id = `${entry.source}:${entry.id}`
  const answers = yield* attributor.describe([{
    id,
    ticketKey: entry.ticketKey,
    summary: entry.ticketKey === null ? null : plan.ownership.facts.get(entry.ticketKey)?.title ?? null,
    digest
  }]).pipe(Effect.mapError((error) => new ApiError({ message: `Description generation failed: ${error.message}` })))
  const summary = answers.find((answer) => answer.id === id)?.note
  if (summary == null || summary.trim() === "") return { note: null, sessionCount: ids.length }
  const prefix = entry.source === "clockify" && entry.ticketKey !== null ? `[${entry.ticketKey}] ` : ""
  const suffix = SourceConsumption.markers(entry.description ?? "")[0] ?? ""
  const reserved = suffix === "" ? 0 : suffix.length + 1
  const note = `${prefix}${summary.slice(0, Math.max(0, 500 - prefix.length - reserved))}`
  return { note: suffix === "" ? note : `${note}\n${suffix}`, sessionCount: ids.length }
})
