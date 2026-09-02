/**
 * Deciding what a live watch may write, and when.
 *
 * **Mental model**
 *
 * - **Settled, not current**: a block of presence is only final once no later prompt can still
 *   change it. Writing the block you are *in* would log a minute at a time and re-derive the same
 *   minutes on every tick, so nothing is written until the block has gone cold.
 * - **Deterministic evidence only**: a watch writes unattended, so it writes only what a branch, a
 *   worktree path, or a Standing Attribution places — evidence a person deliberately created.
 *   Anything a model had to guess at is held for `jcf sync reconcile --agent`, where it is shown
 *   before it is written.
 * - **Held, never dropped**: a proposal this tick cannot write is returned with the reason. The
 *   caller reports it, because time that silently fails to be logged is the failure this whole
 *   feature exists to prevent.
 *
 * **Gotchas**
 *
 * - The settle deadline is the block's own end plus a small grace, and that bound is exact rather
 *   than cautious. A block already runs one Idle Cap past its last prompt, and the only way a later
 *   prompt can extend it is by landing within an Idle Cap of that prompt — which is before the block
 *   ends. So once the block's end has passed, neither it nor its share of parallel work can change.
 *   The grace on top is for transcript-write latency, not for the arithmetic.
 * - Settling is judged on the *latest* span in a bucket, so a ticket returned to after lunch is held
 *   again until the afternoon block also goes cold. The morning block is already written by then,
 *   and the proposal that follows is only the remainder — subtracting what the sides hold is what
 *   makes that safe.
 *
 * @module
 */
import type { CreditedSpan, SessionProposal } from "./sessions.js"

/**
 * Seconds added to the Idle Cap before a block counts as settled.
 *
 * The Idle Cap alone is arithmetically sufficient. This covers the gap between a prompt being typed
 * and its line being readable in the transcript, which is small but not zero — and paying a minute
 * to never write a block twice is the right side of that trade.
 */
export const SETTLE_GRACE_SECONDS = 60

/** Attribution Signals a watch may write on: evidence a person created, not evidence a model chose. */
const UNATTENDED_SIGNALS: ReadonlyArray<SessionProposal["signal"]> = ["branch", "path", "standing"]

/** Why a proposal was not written on this tick. */
export type HoldReason =
  /** Work is still in progress, or too recent to be final. Written on a later tick. */
  | { readonly _tag: "Unsettled"; readonly settlesAtMs: number }
  /** Placed by a Coding Agent rather than by branch, path, or Standing Attribution. */
  | { readonly _tag: "NeedsReview" }

export interface HeldProposal {
  readonly proposal: SessionProposal
  readonly reason: HoldReason
}

export interface WatchDecision {
  /** Ready to write now, in the order they should be written. */
  readonly write: ReadonlyArray<SessionProposal>
  readonly held: ReadonlyArray<HeldProposal>
}

/** The last instant any of a bucket's blocks covers. */
const latestEnd = (spans: ReadonlyArray<CreditedSpan>): number =>
  spans.reduce((latest, span) => Math.max(latest, span.endMs), 0)

/**
 * When a bucket's evidence stops being able to change.
 *
 * The span already ends one Idle Cap past its last prompt, so only the transcript grace is added
 * here — adding the cap again would withhold every block for twice as long as the command says it
 * will. The bound is still exact: a later prompt can only extend this span by landing within an
 * Idle Cap of the last one, which is before the span's own end.
 */
export const settlesAt = (spans: ReadonlyArray<CreditedSpan>): number => latestEnd(spans) + SETTLE_GRACE_SECONDS * 1000

/**
 * Sort one tick's proposals into what may be written now and what must wait.
 *
 * Pure and clock-free: `nowMs` is passed in so the rule is a fact about time rather than about when
 * the test happened to run.
 */
export const decideWatchWrites = (
  proposals: ReadonlyArray<SessionProposal>,
  options: { readonly nowMs: number }
): WatchDecision => {
  const write: Array<SessionProposal> = []
  const held: Array<HeldProposal> = []

  for (const proposal of proposals) {
    if (!UNATTENDED_SIGNALS.includes(proposal.signal)) {
      held.push({ proposal, reason: { _tag: "NeedsReview" } })
      continue
    }
    const settlesAtMs = settlesAt(proposal.spans)
    if (options.nowMs < settlesAtMs) {
      held.push({ proposal, reason: { _tag: "Unsettled", settlesAtMs } })
      continue
    }
    write.push(proposal)
  }

  return { write, held }
}
