/**
 * Deciding a goal's approval request inside the Work tab: what the host hands the board, and how
 * a request's clock and bar read. Pure: the host owns the clock (`now`), the sending decision and
 * the hub's answer; the board only presents them.
 *
 * The clock is display only. A request is decided or expired when the hub says so, never because
 * the client clock reached zero: at zero it reads "expiring" and the bar stays usable, so the hub's
 * refusal is what the reader sees.
 *
 * @module
 */
import type { WorkRequest } from "./model.js"

/** One decision on the hub job behind a request. */
export interface WorkRequestDecision {
  readonly jobId: string
  readonly decision: "approve" | "reject"
}

/**
 * The hub's own words about the last decision sent from this page, for the job it decided.
 * `outcome` is `accepted` when the hub took the decision, `refused` when it answered no, and
 * `uncertain` when the request failed in transit (a 5xx, an unreadable reply). An accepted answer
 * keeps the bar off until the host's pending list drops the job; an uncertain one gives way to the
 * outcome a later snapshot proves.
 */
export interface WorkRequestAnswer {
  readonly jobId: string
  readonly outcome: "accepted" | "refused" | "uncertain"
  readonly text: string
}

/**
 * What a host that can decide approvals gives the Work board. Without it (the LAN view, a host
 * that is not the hub) every request keeps its link to the hub.
 */
export interface WorkRequestDecisions {
  /**
   * The expiry of a hub job this host lists as pending: a time, `null` for a pending job without
   * one, `undefined` when this host cannot decide the job (not pending here, or another host's).
   */
  readonly expiresAt: (jobId: string) => number | null | undefined
  /**
   * Hub time: the snapshot's `observedAt` plus the time elapsed locally since it arrived, re-read
   * while any clock is visible. Expiries are hub times, so a browser clock ahead or behind must not
   * move them.
   */
  readonly now: number
  /** The decision waiting for the hub, if any. */
  readonly sending: WorkRequestDecision | null
  /** The hub's answer to the last decision sent from this page. */
  readonly answer: WorkRequestAnswer | null
  readonly onDecision: (decision: WorkRequestDecision) => void
}

/** Under this much time left the clock keeps seconds. */
export const workRequestSoonMs = 5 * 60_000

/** "52s", "4m 12s", "11m": seconds only matter under five minutes; "expiring" at zero. */
export const workRequestClockText = (expiresAt: number, now: number): string => {
  const left = expiresAt - now
  if (left <= 0) return "expiring"
  const seconds = Math.floor(left / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `${seconds}s`
  return left < workRequestSoonMs ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${minutes}m`
}

/** How a request can be decided on this page. */
export type WorkRequestDecidability =
  | { readonly _tag: "Here"; readonly jobId: string; readonly expiresAt: number | null }
  | { readonly _tag: "Elsewhere" }

/**
 * A request is decided here when the host lists its hub job as pending, or when this page already
 * sent a decision for it and holds the answer, so the bar and its announcement stay mounted after
 * the request leaves the queue.
 */
export const workRequestDecidability = (
  request: WorkRequest,
  decisions: WorkRequestDecisions | undefined
): WorkRequestDecidability => {
  const target = request.approvalTarget
  if (decisions === undefined || target === null) return { _tag: "Elsewhere" }
  const expiresAt = decisions.expiresAt(target.jobId)
  const answered = decisions.answer?.jobId === target.jobId || decisions.sending?.jobId === target.jobId
  if (expiresAt === undefined && !answered) return { _tag: "Elsewhere" }
  return { _tag: "Here", expiresAt: expiresAt ?? null, jobId: target.jobId }
}
