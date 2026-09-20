/**
 * Accepting a row, and logging time by hand.
 *
 * **Mental model**
 *
 * - **Held evidence, live arithmetic.** The plan says what the sessions accounted for; Jira and
 *   Clockify are asked again, at this moment, what they already hold. The write is the difference.
 *   That is the property that makes confirming the same row twice safe, and it is why nothing here
 *   trusts a number that came from a browser except the two a person is allowed to choose.
 * - **An override re-tallies the bucket it moves to.** A row moved to another Issue Key may land on a
 *   day that already holds time the plan knew nothing about; sizing the write from the plan would log
 *   that time twice.
 * - **Outcomes, not HTTP.** Every refusal is a tagged value, so the transport maps them to status
 *   codes and a test reads them directly.
 *
 * @module
 */
import { AgentWrite, Time } from "@knpkv/jira-clockify"
import type { ReconcileService } from "@knpkv/jira-clockify"
import { Effect } from "effect"
import { MINIMUM_WRITE_SECONDS, prepareProposal } from "../shared/writePlanning.js"
import type { WriteResultResponse } from "./Api.js"
import { evidenceBlockKey, evidenceMarker, type HeldPlan, reconcileConsumption } from "./WeekPlan.js"
import { planSides } from "./WeekPlan.js"

/** The engine operations these functions need. Narrow, so a test provides only what it must. */
export type WriteCapableService = Pick<
  ReconcileService.ReconcileServiceContract,
  "applyToClockify" | "applyToJira" | "refreshRecordedTime"
>

/** What a confirmation did, or why it did nothing. */
export type ConfirmOutcome =
  | { readonly _tag: "Written"; readonly result: WriteResultResponse }
  | { readonly _tag: "NothingOwed"; readonly result: WriteResultResponse }
  | { readonly _tag: "UnknownRow" }
  /** A block position that is not part of this row — a page confirming against a plan that moved. */
  | { readonly _tag: "UnknownBlocks" }
  | { readonly _tag: "PastEvidence"; readonly maxSeconds: number }
  | { readonly _tag: "BelowMinimum"; readonly minimumSeconds: number }
  | { readonly _tag: "RunningTimer"; readonly reason: string }
  | { readonly _tag: "NoTargets" }

export interface ConfirmRequest {
  readonly rowId: string
  /** Which of the row's blocks to write, by position. Absent means the whole row. */
  readonly blocks: ReadonlyArray<number> | undefined
  readonly seconds: number | undefined
  readonly ticketKey: string | undefined
  readonly note: string | undefined
  /** Which systems to write. Absent means the ones the plan was read under. */
  readonly targets: AgentWrite.WriteTargets | undefined
}

/**
 * Nothing was owed on the sides that were asked for.
 *
 * A side nobody asked about is `Skipped` rather than `NothingOwed`: its gap may well still be there,
 * and saying "already holds this time" about a system that was never read would be a claim this run
 * cannot make.
 */
const nothingOwed = (description: string, targets: AgentWrite.WriteTargets): WriteResultResponse => {
  const asked: AgentWrite.SideOutcome = { _tag: "NothingOwed" }
  const unasked: AgentWrite.SideOutcome = { _tag: "Skipped" }
  const clockify = targets.clockify ? asked : unasked
  const jira = targets.jira ? asked : unasked
  return {
    clockify,
    description,
    jira,
    lines: ["· already logged where asked — nothing written", ...AgentWrite.writeOutcomeLines({ clockify, jira })]
  }
}

/**
 * Write one confirmed row.
 *
 * `summaryOf` supplies the issue title Clockify has no other way to know. It is asked for after the
 * row is known to be writable and is expected to answer null on failure: a missing title must never
 * cost a write that is otherwise correct.
 */
export const confirmProposal = (options: {
  readonly service: WriteCapableService
  readonly plan: HeldPlan
  readonly request: ConfirmRequest
  readonly summaryOf: (ticketKey: string) => Effect.Effect<string | null>
}): Effect.Effect<ConfirmOutcome, ReconcileService.ReconcileError> =>
  Effect.gen(function*() {
    const evidence = options.plan.evidence.get(options.request.rowId)
    if (evidence === undefined) return { _tag: "UnknownRow" } satisfies ConfirmOutcome
    const proposal = evidence.proposal
    let consumption = options.plan.consumption
    const prepared = prepareProposal({
      evidence: { ...proposal, credited: proposal.sessionSeconds },
      request: options.request,
      targets: planSides(options.plan),
      consumed: (block, source) => consumption.get(evidenceBlockKey(evidence.rowId, block))?.[source] ?? 0
    })
    if (prepared._tag !== "Prepared") return prepared

    // Re-read the requested providers and timer state from retained evidence. Cached browser totals
    // never authorize writes, and a timer started after the week was read must still withhold its day.
    const refreshed = yield* options.service.refreshRecordedTime(
      Time.isoWeekPeriod(new Date(`${options.plan.plan.monday}T12:00:00`)),
      { ...options.plan.report, sides: prepared.targets },
      { jiraIssueKeys: [...options.plan.jiraReceiptIssueKeys, prepared.ticketKey] }
    )
    consumption = reconcileConsumption(refreshed, consumption)
    options.plan.consumption.clear()
    for (const [key, value] of consumption) options.plan.consumption.set(key, value)
    const excluded = refreshed.excludedDays.find(({ day }) => day === prepared.day)
    if (excluded !== undefined) {
      return { _tag: "RunningTimer", reason: excluded.reason } satisfies ConfirmOutcome
    }
    const write = prepared.plan(refreshed.recorded)
    if (write._tag === "PastEvidence" || write._tag === "BelowMinimum") return write

    const retainedTitle = options.plan.ownership.facts.get(prepared.ticketKey)?.title ?? null
    const summary = retainedTitle ?? (prepared.targets.jira ? yield* options.summaryOf(prepared.ticketKey) : null)
    const description = AgentWrite.entryDescription({
      note: options.request.note ?? null,
      provenance: prepared.provenance,
      summary
    })
    if (write._tag === "NothingOwed") {
      return { _tag: "NothingOwed", result: nothingOwed(description, prepared.targets) } satisfies ConfirmOutcome
    }

    // The suffix helps import legacy writes. The private provider-ID binding remains authoritative
    // when a saved entry is relabeled or its description is edited outside jcf.
    const providerWrite = {
      ...write,
      clockify: {
        ...write.clockify,
        segments: write.clockify.segments.map((segment) => ({
          ...segment,
          description: `${description}\n${evidenceMarker(evidence.rowId, segment.block)}`
        }))
      },
      jira: {
        ...write.jira,
        segments: write.jira.segments.map((segment) => ({
          ...segment,
          description: `${description}\n${evidenceMarker(evidence.rowId, segment.block)}`
        }))
      }
    }
    const outcome = yield* AgentWrite.applyPlannedWrite(options.service, providerWrite, description, evidence.rowId)
    for (const source of ["clockify", "jira"] satisfies ReadonlyArray<keyof AgentWrite.WriteOutcome>) {
      const side = outcome[source]
      if (side._tag !== "Written" && side._tag !== "PartiallyWritten") continue
      if (source === "jira") options.plan.jiraReceiptIssueKeys.add(prepared.ticketKey)
      let remaining = side.seconds
      for (const segment of write[source].segments) {
        if (remaining <= 0) break
        const block = segment.block
        const key = evidenceBlockKey(evidence.rowId, block)
        const previous = consumption.get(key) ?? { clockify: 0, jira: 0 }
        const added = Math.min(remaining, segment.seconds, Math.max(0, block.seconds - previous[source]))
        const value = { ...previous, [source]: previous[source] + added }
        consumption.set(key, value)
        options.plan.consumption.set(key, value)
        remaining -= added
      }
    }
    return {
      _tag: "Written",
      result: {
        clockify: outcome.clockify,
        description,
        jira: outcome.jira,
        lines: AgentWrite.writeOutcomeLines(outcome)
      }
    } satisfies ConfirmOutcome
  })

export interface ManualRequest {
  readonly day: string
  readonly ticketKey: string
  readonly seconds: number
  readonly startClock: string | undefined
  readonly note: string | undefined
  readonly targets: AgentWrite.WriteTargets
}

/**
 * Log time no session evidences.
 *
 * Not a proposal, so not sized to a gap and not routed through `applyProposal`: a person typing
 * thirty minutes means add thirty minutes to both systems, the way `jcf timer log` has always
 * behaved. Nothing is subtracted, so typing it twice logs it twice — which is what typing it twice
 * means.
 */
export const logManualEntry = (options: {
  readonly service: Pick<WriteCapableService, "applyToClockify" | "applyToJira">
  readonly request: ManualRequest
  readonly summaryOf: (ticketKey: string) => Effect.Effect<string | null>
}): Effect.Effect<WriteResultResponse> =>
  Effect.gen(function*() {
    const { request } = options
    const description = AgentWrite.entryDescription({
      note: request.note ?? null,
      provenance: AgentWrite.byHand,
      summary: request.targets.jira ? yield* options.summaryOf(request.ticketKey) : null
    })
    const startedAt = request.startClock === undefined
      ? undefined
      : new Date(`${request.day}T${request.startClock}:00`)

    const clockify: AgentWrite.SideOutcome = !request.targets.clockify
      ? { _tag: "Skipped" }
      : yield* options.service
        .applyToClockify(request.ticketKey, request.day, request.seconds, description, startedAt)
        .pipe(
          Effect.map((created): AgentWrite.SideOutcome =>
            created
              ? { _tag: "Written", seconds: request.seconds }
              : { _tag: "Refused", message: "the entry was not created" }
          ),
          Effect.catch((error) => Effect.succeed<AgentWrite.SideOutcome>({ _tag: "Refused", message: error.message }))
        )
    if (!request.targets.jira) {
      const jira: AgentWrite.SideOutcome = { _tag: "Skipped" }
      return { clockify, description, jira, lines: AgentWrite.writeOutcomeLines({ clockify, jira }) }
    }
    const posted = yield* options.service.applyToJira(
      request.ticketKey,
      request.day,
      request.seconds,
      description,
      startedAt
    )
    const jira: AgentWrite.SideOutcome = posted._tag === "Posted"
      ? { _tag: "Written", seconds: request.seconds }
      : posted._tag === "NotLoggedIn"
      ? { _tag: "NotLoggedIn" }
      : { _tag: "Refused", message: posted.message }
    return { clockify, description, jira, lines: AgentWrite.writeOutcomeLines({ clockify, jira }) }
  })

export { MINIMUM_WRITE_SECONDS }
