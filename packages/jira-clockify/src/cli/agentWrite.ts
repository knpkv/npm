/**
 * Writing one Proposed Worklog, shared by `jcf sync reconcile --agent` and `jcf watch`.
 *
 * **Mental model**
 *
 * - **One write path**: both commands derive proposals from the same evidence and must put the same
 *   text in the same two places. A second implementation would drift, and the drift would only ever
 *   be visible in someone else's timesheet.
 * - **Say it before writing it**: the entry text lands in two systems other people read, so the
 *   caller prints it first. Nothing here writes anything the user has not already been shown.
 *
 * @module
 */
import * as Console from "effect/Console"
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
 * Where a written entry says it came from. Provenance for a human reading the row months later,
 * never load-bearing: the tally keys on the `[KEY]` prefix and the day, so editing this text away
 * in Clockify's web UI cannot re-enable double-logging.
 */
export const PROVENANCE = "Reconciled from Claude Agent Session"

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
}): string => {
  const parts = [
    ...(options.summary === null ? [] : [clip(options.summary, ENTRY_SUMMARY_WIDTH)]),
    ...(options.note === null || options.note.trim() === "" ? [] : [options.note.trim()])
  ]
  return parts.length === 0 ? PROVENANCE : `${parts.join(" — ")} (${PROVENANCE})`
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
 * What one write attempt actually achieved, per side.
 *
 * Per side rather than a single boolean because the two fail independently and a caller that
 * summarises what it wrote must not count a side that refused. `keepGoing` is false only for
 * `NotLoggedIn`: every remaining Jira write would fail the same way, and twenty rows that all fail
 * is worse than stopping at the first.
 */
export interface WriteOutcome {
  readonly clockifySeconds: number
  readonly jiraSeconds: number
  readonly keepGoing: boolean
}

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
    let clockifySeconds = 0
    if (proposal.clockifyDelta > 0) {
      const ok = yield* service
        .applyToClockify(
          proposal.ticketKey,
          proposal.day,
          proposal.clockifyDelta,
          description,
          writeAnchor(proposal.spans, proposal.clockifySeconds)
        )
        .pipe(
          Effect.catch((error) => Console.log(`    ✗ Clockify: ${error.message}`).pipe(Effect.as(false)))
        )
      if (ok) {
        clockifySeconds = proposal.clockifyDelta
        yield* Console.log(`    ✓ created Clockify entry`)
      }
    }
    if (proposal.jiraDelta > 0) {
      const outcome = yield* service.applyToJira(
        proposal.ticketKey,
        proposal.day,
        proposal.jiraDelta,
        description,
        writeAnchor(proposal.spans, proposal.jiraSeconds)
      )
      if (outcome._tag === "Posted") {
        yield* Console.log(`    ✓ posted to Jira`)
        return { clockifySeconds, jiraSeconds: proposal.jiraDelta, keepGoing: true }
      }
      if (outcome._tag === "NotLoggedIn") {
        yield* Console.log(`    ✗ ${NOT_LOGGED_IN_HINT}`)
        return { clockifySeconds, jiraSeconds: 0, keepGoing: false }
      }
      yield* Console.log(`    ✗ Jira: ${outcome.message}`)
    }
    return { clockifySeconds, jiraSeconds: 0, keepGoing: true }
  })
