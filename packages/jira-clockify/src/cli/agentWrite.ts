/**
 * Writing one Proposed Worklog, shared by `jcf sync reconcile --agent`, `jcf watch`, and any other
 * surface that offers a proposal for confirmation.
 *
 * **Mental model**
 *
 * - **One write path**: every surface derives proposals from the same evidence and must put the same
 *   text in the same two places. A second implementation would drift, and the drift would only ever
 *   be visible in someone else's timesheet.
 * - **Say it before writing it**: the entry text lands in two systems other people read, so the
 *   caller shows it first. Nothing here writes anything the user has not already been shown.
 * - **Reports, never prints.** A write returns what each side did and the caller renders it. A
 *   terminal has a console to print to and an HTTP handler has a response to fill; a write path that
 *   printed could only ever serve the first, and the second would grow its own copy of these rules.
 *
 * @module
 */
import * as Effect from "effect/Effect"
import type { CreditedSpan, SessionProposal } from "../agent/sessions.js"
import type { ReconcileServiceContract } from "../services/ReconcileService.js"
import { formatDuration } from "../utils/time.js"
import { NOT_LOGGED_IN_HINT } from "./fetchTicket.js"

/** Clip `text` to `width`, marking that something was dropped. */
export const clip = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, width - 1)}…`

/**
 * What accepting one row would write, naming only the sides that are actually short.
 *
 * Collapsed to "to both" when the two gaps are equal, which is the usual case for time neither
 * side ever recorded — spelling the same number out twice reads like a mistake.
 */
export const proposalTargets = (proposal: SessionProposal): string => {
  if (proposal.clockifyDelta > 0 && proposal.clockifyDelta === proposal.jiraDelta) {
    return `+${formatDuration(proposal.clockifyDelta)} to both`
  }
  const targets: Array<string> = []
  if (proposal.clockifyDelta > 0) targets.push(`+${formatDuration(proposal.clockifyDelta)} Clockify`)
  if (proposal.jiraDelta > 0) targets.push(`+${formatDuration(proposal.jiraDelta)} Jira`)
  return targets.join(", ")
}

/**
 * How the amount on a written entry was arrived at.
 *
 * The distinction is not decoration. `session` says the number is what a transcript evidences, which
 * is the claim ADR-0006 lets the tool make; the other two say a person chose it. A row whose amount
 * was typed over must not keep claiming a transcript stands behind it.
 */
export type WriteOrigin = "session" | "session-adjusted" | "manual"

/**
 * Where a written entry says it came from. Provenance for a human reading the row months later,
 * never load-bearing: the tally keys on the `[KEY]` prefix and the day, so editing this text away
 * in Clockify's web UI cannot re-enable double-logging.
 */
export const PROVENANCE = "Reconciled from Claude Agent Session"

const PROVENANCE_BY_ORIGIN: Record<WriteOrigin, string> = {
  manual: "Entered by hand",
  session: PROVENANCE,
  "session-adjusted": `${PROVENANCE}, amount set by hand`
}

/** What an entry of this origin says about itself. */
export const provenanceOf = (origin: WriteOrigin): string => PROVENANCE_BY_ORIGIN[origin]

/** Keeps the issue title from crowding out the sentence that says what was actually done. */
const ENTRY_SUMMARY_WIDTH = 80

/**
 * What a written entry says about itself: the issue title, what was done, and where it came from.
 *
 * An entry that says only "reconciled from an Agent Session" answers the wrong question. The one
 * asked of a timesheet months later is *what* the time went on, and by then the Issue Key alone is
 * a lookup and the transcript is gone. So the title goes in — Clockify has no other way to know it —
 * and the note goes in after it, as the one thing neither system can reconstruct.
 *
 * Both halves are optional, for different reasons: Jira may be unreachable, and a session whose
 * prompts never say what was done gets no sentence rather than an invented one. The provenance stays
 * last and unconditional — a reader has to be able to tell that a line was written by a tool from a
 * session, not typed by hand.
 */
export const entryDescription = (options: {
  readonly summary: string | null
  readonly note: string | null
  /** Defaults to `session` — the only origin the CLI's own commands write. */
  readonly origin?: WriteOrigin | undefined
}): string => {
  const provenance = provenanceOf(options.origin ?? "session")
  const parts = [
    ...(options.summary === null ? [] : [clip(options.summary, ENTRY_SUMMARY_WIDTH)]),
    ...(options.note === null || options.note.trim() === "" ? [] : [options.note.trim()])
  ]
  return parts.length === 0 ? provenance : `${parts.join(" — ")} (${provenance})`
}

/**
 * Where a write should say the work began, given what that side already holds.
 *
 * A proposal covers a whole `(Issue Key, day)` bucket, but the amount written is only the gap. Under
 * `jcf watch` that gap arrives block by block: the morning is written when it settles, and the
 * afternoon follows as its own write against the same bucket. Anchoring both at the bucket's first
 * instant would file the afternoon's hours at 09:00 — a second Clockify entry laid directly over the
 * first, and a Jira worklog dated to work that had not started yet.
 *
 * So the anchor skips the blocks that side already accounts for and starts at the first one it does
 * not. Approximate where work ran in parallel, because `seconds` is a *share* of those blocks rather
 * than their wall clock — but the error is then bounded by one block, against a whole day before.
 */
export const writeAnchor = (
  spans: ReadonlyArray<CreditedSpan>,
  alreadyRecordedSeconds: number
): Date | undefined => {
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs)
  let remaining = alreadyRecordedSeconds
  for (const span of ordered) {
    const seconds = (span.endMs - span.startMs) / 1000
    if (remaining >= seconds) {
      remaining -= seconds
      continue
    }
    return new Date(span.startMs + remaining * 1000)
  }
  // Every block is already spoken for. Reached only when a side is not short, so nothing is written
  // with this anchor — but the end of the last block is the one instant that cannot overlap what is
  // already recorded, where the first block is the one instant guaranteed to.
  const last = ordered[ordered.length - 1]
  return last === undefined ? undefined : new Date(last.endMs)
}

/**
 * What one side of a write did.
 *
 * `NothingOwed` is not a failure and not a write: the side already holds the proposal's time, which
 * is the ordinary outcome of topping up a day only one system missed. Keeping it distinct from a
 * `Written` of zero is what stops a summary counting it as work logged.
 */
export type SideOutcome =
  | { readonly _tag: "Written"; readonly seconds: number }
  | { readonly _tag: "NothingOwed" }
  | { readonly _tag: "Refused"; readonly message: string }
  /** Jira only: the session expired, so every later Jira write would fail the same way. */
  | { readonly _tag: "NotLoggedIn" }

/**
 * What one write attempt achieved, per side.
 *
 * Per side rather than a single boolean because the two fail independently, and a caller that
 * summarises what it wrote must not count a side that refused.
 */
export interface WriteOutcome {
  readonly clockify: SideOutcome
  readonly jira: SideOutcome
}

const sideSeconds = (outcome: SideOutcome): number => outcome._tag === "Written" ? outcome.seconds : 0

/** Seconds this write actually put on Clockify. */
export const clockifyWritten = (outcome: WriteOutcome): number => sideSeconds(outcome.clockify)

/** Seconds this write actually put on Jira. */
export const jiraWritten = (outcome: WriteOutcome): number => sideSeconds(outcome.jira)

/**
 * Whether a run should go on to the next row.
 *
 * False only for an expired Jira session: every remaining Jira write would fail the same way, and
 * twenty rows that all fail is worse than stopping at the first. A Clockify refusal, or a Jira
 * refusal about *this* row, says nothing about the next one.
 */
export const keepGoing = (outcome: WriteOutcome): boolean => outcome.jira._tag !== "NotLoggedIn"

/**
 * One line per side saying what happened, in the words every surface should use.
 *
 * Here rather than in each caller so a terminal and a browser cannot describe the same write
 * differently. Silent about a side that owed nothing — a row where only Jira was short should not
 * report a Clockify non-event.
 */
export const writeOutcomeLines = (outcome: WriteOutcome): ReadonlyArray<string> => {
  const lines: Array<string> = []
  if (outcome.clockify._tag === "Written") lines.push("✓ created Clockify entry")
  if (outcome.clockify._tag === "Refused") lines.push(`✗ Clockify: ${outcome.clockify.message}`)
  if (outcome.jira._tag === "Written") lines.push("✓ posted to Jira")
  if (outcome.jira._tag === "Refused") lines.push(`✗ Jira: ${outcome.jira.message}`)
  if (outcome.jira._tag === "NotLoggedIn") lines.push(`✗ ${NOT_LOGGED_IN_HINT}`)
  return lines
}

const nothingOwed: SideOutcome = { _tag: "NothingOwed" }

/** Write one confirmed proposal, sizing each side to its own gap. */
export const applyProposal = (
  service: Pick<ReconcileServiceContract, "applyToClockify" | "applyToJira">,
  proposal: SessionProposal,
  description: string
): Effect.Effect<WriteOutcome, never, never> =>
  Effect.gen(function*() {
    // Anchored to real activity rather than left to the service's local-noon fallback, which files a
    // 00:17 session as a lunchtime block — wrong on its face to anyone reading the timesheet later.
    // Per side, because the two can already hold different amounts and so start in different blocks.
    const clockify: SideOutcome = proposal.clockifyDelta > 0
      ? yield* service
        .applyToClockify(
          proposal.ticketKey,
          proposal.day,
          proposal.clockifyDelta,
          description,
          writeAnchor(proposal.spans, proposal.clockifySeconds)
        )
        .pipe(
          Effect.map((created): SideOutcome =>
            created
              ? { _tag: "Written", seconds: proposal.clockifyDelta }
              : { _tag: "Refused", message: "the entry was not created" }
          ),
          Effect.catch((error) => Effect.succeed<SideOutcome>({ _tag: "Refused", message: error.message }))
        )
      : nothingOwed

    if (proposal.jiraDelta <= 0) return { clockify, jira: nothingOwed }

    const posted = yield* service.applyToJira(
      proposal.ticketKey,
      proposal.day,
      proposal.jiraDelta,
      description,
      writeAnchor(proposal.spans, proposal.jiraSeconds)
    )
    const jira: SideOutcome = posted._tag === "Posted"
      ? { _tag: "Written", seconds: proposal.jiraDelta }
      : posted._tag === "NotLoggedIn"
      ? { _tag: "NotLoggedIn" }
      : { _tag: "Refused", message: posted.message }
    return { clockify, jira }
  })
