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
import type { WriteResultResponse } from "./Api.js"
import type { HeldPlan } from "./WeekPlan.js"
import { MINIMUM_WRITE_SECONDS, planSides, proposeWrite } from "./WeekPlan.js"

/** The engine operations these functions need. Narrow, so a test provides only what it must. */
export type WriteCapableService = Pick<
  ReconcileService.ReconcileServiceContract,
  "applyToClockify" | "applyToJira" | "compare"
>

/** What a confirmation did, or why it did nothing. */
export type ConfirmOutcome =
  | { readonly _tag: "Written"; readonly result: WriteResultResponse }
  | { readonly _tag: "NothingOwed"; readonly result: WriteResultResponse }
  | { readonly _tag: "UnknownRow" }
  | { readonly _tag: "PastEvidence"; readonly maxSeconds: number }
  | { readonly _tag: "BelowMinimum"; readonly minimumSeconds: number }
  | { readonly _tag: "NoTargets" }

export interface ConfirmRequest {
  readonly rowId: string
  readonly seconds: number | undefined
  readonly ticketKey: string | undefined
  readonly note: string | undefined
  /** Which systems to write. Absent means the ones the plan was read under. */
  readonly targets: AgentWrite.WriteTargets | undefined
}

/** Local midnight of a `YYYY-MM-DD`, and the half-open day after it. */
const dayPeriod = (day: string) => {
  const from = new Date(`${day}T00:00:00`)
  return { from, to: new Date(Time.nextLocalMidnight(from.getTime())) }
}

/**
 * Nothing was owed on the sides that were asked for.
 *
 * A side nobody asked about is `Skipped` rather than `NothingOwed`: its gap may well still be there,
 * and saying "already holds this time" about a system that was never read would be a claim this run
 * cannot make.
 */
const nothingOwed = (description: string, targets: AgentWrite.WriteTargets): WriteResultResponse => {
  const asked = { _tag: "NothingOwed" } as const
  const unasked = { _tag: "Skipped" } as const
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
    if (evidence === undefined) return { _tag: "UnknownRow" } as const
    const proposal = evidence.proposal
    const ticketKey = options.request.ticketKey ?? proposal.ticketKey
    // The plan's own scope by default: someone reading a Jira-only week and confirming a row means
    // Jira, and a payload that says otherwise had to say so.
    const targets = options.request.targets ?? planSides(options.plan)
    if (!targets.clockify && !targets.jira) return { _tag: "NoTargets" } as const

    // Only the systems in play are re-read. A Clockify tally nobody is writing to is a request that
    // can only fail a run that never needed it.
    const recorded = yield* options.service.compare(dayPeriod(proposal.day), { sides: targets })
    const bucket = recorded.find((row) => row.ticketKey === ticketKey && row.day === proposal.day)
    const heldClockifySeconds = bucket?.clockifySeconds ?? 0
    const heldJiraSeconds = bucket?.jiraSeconds ?? 0

    const write = proposeWrite({
      credited: proposal.sessionSeconds,
      heldClockifySeconds,
      heldJiraSeconds,
      requested: options.request.seconds,
      targets
    })
    if (write._tag === "PastEvidence") return { _tag: "PastEvidence", maxSeconds: write.maxSeconds } as const
    if (write._tag === "BelowMinimum") {
      return { _tag: "BelowMinimum", minimumSeconds: write.minimumSeconds } as const
    }

    const provenance: AgentWrite.WriteProvenance = {
      amountSetByHand: options.request.seconds !== undefined &&
        options.request.seconds !== proposal.sessionSeconds,
      evidence: "session",
      ticketSetByHand: ticketKey !== proposal.ticketKey
    }
    const description = AgentWrite.entryDescription({
      note: options.request.note ?? null,
      provenance,
      summary: yield* options.summaryOf(ticketKey)
    })
    if (write._tag === "NothingOwed") {
      return { _tag: "NothingOwed", result: nothingOwed(description, targets) } as const
    }

    const outcome = yield* AgentWrite.applyProposal(
      options.service,
      {
        ...proposal,
        clockifyDelta: write.clockifyDelta,
        clockifySeconds: heldClockifySeconds,
        jiraDelta: write.jiraDelta,
        jiraSeconds: heldJiraSeconds,
        ticketKey
      },
      description,
      targets
    )
    return {
      _tag: "Written",
      result: {
        clockify: outcome.clockify,
        description,
        jira: outcome.jira,
        lines: AgentWrite.writeOutcomeLines(outcome)
      }
    } as const
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
      summary: yield* options.summaryOf(request.ticketKey)
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
