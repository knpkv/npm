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
import { AgentWrite, ReconcileService, SourceConsumption, Time } from "@knpkv/jira-clockify"
import type { PlannedWrite } from "@knpkv/jira-clockify/agent/writePlanning.js"
import { Clock, Effect, Predicate } from "effect"
import { MINIMUM_WRITE_SECONDS, prepareProposal } from "../shared/writePlanning.js"
import { ProposalRejectedError, type WriteResultResponse } from "./Api.js"
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

/** Everything a confirmation needs from a re-read of the providers, reconciled into the plan. */
interface FreshRead {
  readonly refreshed: ReconcileService.SessionProposalReport
  readonly expectedScopes: ReconcileService.ProviderScopes
}

type Prepared = Extract<ReturnType<typeof prepareProposal>, { readonly _tag: "Prepared" }>

/** A request sized against retained evidence and ready to be checked against a fresh read. */
interface Ready {
  readonly _tag: "Ready"
  readonly evidence: NonNullable<ReturnType<HeldPlan["evidence"]["get"]>>
  readonly prepared: Prepared
}

/** Size a request against the retained evidence; anything but `Prepared` is the outcome itself. */
const prepare = (plan: HeldPlan, request: ConfirmRequest) => {
  const evidence = plan.evidence.get(request.rowId)
  if (evidence === undefined) return { _tag: "UnknownRow" } satisfies ConfirmOutcome
  const prepared = prepareProposal({
    evidence: { ...evidence.proposal, credited: evidence.proposal.sessionSeconds },
    request,
    targets: planSides(plan),
    consumed: (block, source) => plan.consumption.get(evidenceBlockKey(evidence.rowId, block))?.[source] ?? 0
  })
  if (prepared._tag !== "Prepared") return prepared
  return { _tag: "Ready", evidence, prepared } satisfies Ready
}

/**
 * Re-read the providers and timer state, check the account is still the one the plan bound, and
 * reconcile the plan's consumption from that read. Cached browser totals never authorize writes,
 * and a timer started after the week was read must still withhold its day.
 *
 * Consumption is reconciled here, once per read: reconciling a later confirmation against a read
 * that predates an earlier write in the same batch would forget that write.
 */
const freshRead = (
  service: WriteCapableService,
  plan: HeldPlan,
  sides: AgentWrite.WriteTargets,
  ticketKeys: ReadonlyArray<string>
): Effect.Effect<FreshRead, ReconcileService.ReconcileError> =>
  Effect.gen(function*() {
    const refreshed = yield* service.refreshRecordedTime(
      Time.isoWeekPeriod(new Date(`${plan.plan.monday}T12:00:00`)),
      { ...plan.report, sides },
      { jiraIssueKeys: [...plan.jiraReceiptIssueKeys, ...ticketKeys] }
    )
    const retainedScopes = plan.boundScopes
    const currentScopes = refreshed.sourceScopes
    const expectedScopes = currentScopes === undefined
      ? undefined
      : {
        clockify: currentScopes.clockify === null
          ? null
          : retainedScopes.clockify ?? currentScopes.clockify,
        jira: currentScopes.jira === null ? null : retainedScopes.jira ?? currentScopes.jira
      }
    if (
      expectedScopes === undefined || currentScopes === undefined ||
      (sides.clockify && expectedScopes.clockify !== null && expectedScopes.clockify !== currentScopes.clockify) ||
      (sides.jira && expectedScopes.jira !== null && expectedScopes.jira !== currentScopes.jira)
    ) {
      return yield* new ReconcileService.ReconcileError({
        message: "The provider account changed or could not be verified; reload the week before confirming"
      })
    }
    if (sides.clockify && expectedScopes.clockify !== null) plan.boundScopes.clockify = expectedScopes.clockify
    if (sides.jira && expectedScopes.jira !== null) plan.boundScopes.jira = expectedScopes.jira
    const consumption = reconcileConsumption(refreshed, plan.consumption)
    plan.consumption.clear()
    for (const [key, value] of consumption) plan.consumption.set(key, value)
    return { refreshed, expectedScopes }
  })

/** Write one prepared request against a fresh read, recording what it consumed into the plan. */
const confirmAgainst = (
  options: {
    readonly service: WriteCapableService
    readonly plan: HeldPlan
    readonly request: ConfirmRequest
    readonly summaryOf: (ticketKey: string) => Effect.Effect<string | null>
  },
  ready: Ready,
  read: FreshRead
): Effect.Effect<ConfirmOutcome, ReconcileService.ReconcileError> =>
  Effect.gen(function*() {
    const { evidence, prepared } = ready
    const { expectedScopes, refreshed } = read
    const proposal = evidence.proposal
    const consumption = options.plan.consumption
    // The retained proposal predates any ignore made since this plan was read. Check the policy the
    // fresh read applied — for the row's own ticket and for a ticket the person retargeted to.
    const ignored = [proposal.ticketKey, prepared.ticketKey].find((key) => refreshed.ignoredTickets.includes(key))
    if (ignored !== undefined) {
      return yield* new ReconcileService.ReconcileError({
        message: `${ignored} is ignored; rescan the week before logging time to it`
      })
    }
    const excluded = refreshed.excludedDays.find(({ day }) => day === prepared.day)
    if (excluded !== undefined) {
      return { _tag: "RunningTimer", reason: excluded.reason } satisfies ConfirmOutcome
    }
    const unlinkedRows = refreshed.unlinkedClockify.map((slice) => ({
      intervals: slice.entry === undefined ? [] : [{ entry: slice.entry }]
    }))
    const ambiguous = SourceConsumption.unlinkedClockifyOverlaps(
      proposal.blocks,
      unlinkedRows,
      refreshed.sourceEntries
    )
    const freshPrepared = prepareProposal({
      evidence: {
        ...proposal,
        writeBlocked: refreshed.writeBlocked,
        blocks: proposal.blocks.map((block, index) => ({
          ...block,
          clockifyRefusal: ambiguous[index] === true ? "unlinked-overlap" : undefined
        })),
        credited: proposal.sessionSeconds
      },
      request: options.request,
      targets: planSides(options.plan),
      consumed: (block, source) => consumption.get(evidenceBlockKey(evidence.rowId, block))?.[source] ?? 0
    })
    if (freshPrepared._tag !== "Prepared") return freshPrepared
    const write = freshPrepared.plan(
      ReconcileService.recordedForExecution(refreshed.recorded, refreshed.jiraAvailability)
    )
    if (write._tag === "PastEvidence" || write._tag === "BelowMinimum") return write

    const retainedTitle = options.plan.ownership.facts.get(prepared.ticketKey)?.title ?? null
    const summary = retainedTitle ??
      (freshPrepared.targets.jira ? yield* options.summaryOf(freshPrepared.ticketKey) : null)
    const description = AgentWrite.entryDescription({
      note: options.request.note ?? null,
      provenance: freshPrepared.provenance,
      summary
    })
    // The suffix helps import legacy writes. The private provider-ID binding remains authoritative
    // when a saved entry is relabeled or its description is edited outside jcf.
    const providerWrite: PlannedWrite = write._tag === "NothingOwed"
      ? {
        _tag: "Write",
        writeBlocked: refreshed.writeBlocked,
        ticketKey: freshPrepared.ticketKey,
        day: freshPrepared.day,
        targets: freshPrepared.targets,
        clockify: { seconds: 0, segments: [], startedAt: undefined },
        jira: { seconds: 0, segments: [], startedAt: undefined }
      }
      : {
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
    const outcome = yield* AgentWrite.applyPlannedWrite(
      options.service,
      providerWrite,
      description,
      evidence.rowId,
      expectedScopes,
      refreshed.jiraAvailability
    )
    if (
      write._tag === "NothingOwed" &&
      outcome.clockify._tag === (freshPrepared.targets.clockify ? "NothingOwed" : "Skipped") &&
      outcome.jira._tag === (freshPrepared.targets.jira ? "NothingOwed" : "Skipped")
    ) {
      return { _tag: "NothingOwed", result: nothingOwed(description, freshPrepared.targets) } satisfies ConfirmOutcome
    }
    for (const source of ["clockify", "jira"] satisfies ReadonlyArray<keyof AgentWrite.WriteOutcome>) {
      const side = outcome[source]
      if (side._tag !== "Written" && side._tag !== "PartiallyWritten") continue
      if (source === "jira") options.plan.jiraReceiptIssueKeys.add(prepared.ticketKey)
      let remaining = side.seconds
      for (const segment of providerWrite[source].segments) {
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
    const ready = prepare(options.plan, options.request)
    if (ready._tag !== "Ready") return ready
    const read = yield* freshRead(options.service, options.plan, ready.prepared.targets, [ready.prepared.ticketKey])
    return yield* confirmAgainst(options, ready, read)
  })

/** One request's outcome in a batch; a provider or account failure stays with the request it hit. */
export type BatchConfirmOutcome = ConfirmOutcome | { readonly _tag: "Failed"; readonly message: string }

/**
 * Write several confirmed rows under one provider re-read.
 *
 * Each row's arithmetic depends only on its own ticket and day, so one read serves the batch. The
 * exception is a request whose ticket and day an earlier request in the batch already wrote: that
 * one re-reads first, because the earlier write changed exactly the totals it subtracts. Requests
 * run in order, and a failure is that request's outcome — the rest of the batch still runs.
 */
export const confirmProposals = (options: {
  readonly service: WriteCapableService
  readonly plan: HeldPlan
  readonly requests: ReadonlyArray<ConfirmRequest>
  readonly summaryOf: (ticketKey: string) => Effect.Effect<string | null>
}): Effect.Effect<ReadonlyArray<BatchConfirmOutcome>> =>
  Effect.gen(function*() {
    const readied = options.requests.map((request) => ({ request, ready: prepare(options.plan, request) }))
    const writable = readied.flatMap(({ ready }) => ready._tag === "Ready" ? [ready.prepared] : [])
    const sides = {
      clockify: writable.some((prepared) => prepared.targets.clockify),
      jira: writable.some((prepared) => prepared.targets.jira)
    }
    const failed = (error: ReconcileService.ReconcileError): BatchConfirmOutcome => ({
      _tag: "Failed",
      message: error.message
    })
    let read: FreshRead | ReconcileService.ReconcileError | undefined = undefined
    const written = new Set<string>()
    const outcomes: Array<BatchConfirmOutcome> = []
    for (const { ready, request } of readied) {
      if (ready._tag !== "Ready") {
        outcomes.push(ready)
        continue
      }
      const bucket = `${ready.prepared.ticketKey}\u0000${ready.prepared.day}`
      if (read === undefined || written.has(bucket)) {
        read = yield* freshRead(
          options.service,
          options.plan,
          sides,
          writable.map((prepared) => prepared.ticketKey)
        ).pipe(Effect.catch((error) => Effect.succeed(error)))
        written.clear()
      }
      if (Predicate.isTagged(read, "ReconcileError")) {
        outcomes.push(failed(read))
        continue
      }
      const outcome = yield* confirmAgainst({ ...options, request }, ready, read).pipe(
        Effect.catch((error) => Effect.succeed(failed(error)))
      )
      if (outcome._tag === "Written") written.add(bucket)
      outcomes.push(outcome)
    }
    return outcomes
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
}): Effect.Effect<WriteResultResponse, ProposalRejectedError> =>
  Effect.gen(function*() {
    const { request } = options
    const startedAt = new Date(`${request.day}T${request.startClock ?? "12:00"}:00`)
    const startMs = startedAt.getTime()
    if (
      !Number.isFinite(startMs) || Time.localDay(startedAt) !== request.day ||
      (request.startClock !== undefined && Time.formatClock(startedAt) !== request.startClock)
    ) {
      return yield* new ProposalRejectedError({ message: "That local start time does not exist on the chosen day" })
    }
    const nowMs = yield* Clock.currentTimeMillis
    if (startMs > nowMs) {
      return yield* new ProposalRejectedError({ message: "Start time is in the future" })
    }
    if (startMs + request.seconds * 1000 > nowMs) {
      return yield* new ProposalRejectedError({ message: "End time is in the future" })
    }
    const description = AgentWrite.entryDescription({
      note: request.note ?? null,
      provenance: AgentWrite.byHand,
      summary: request.targets.jira ? yield* options.summaryOf(request.ticketKey) : null
    })

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
      : posted._tag === "VerificationUnavailable"
      ? { _tag: "Refused", message: "the Jira account could not be verified; refresh before writing" }
      : { _tag: "Refused", message: posted.message }
    return { clockify, description, jira, lines: AgentWrite.writeOutcomeLines({ clockify, jira }) }
  })

export { MINIMUM_WRITE_SECONDS }
