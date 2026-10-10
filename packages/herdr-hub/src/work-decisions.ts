/**
 * The Work board's request bars on a host that decides approvals. A goal's approval request is
 * decided in place through the same call as the Approvals tab, and the board reads the same state:
 * the hub jobs this host lists as decidable, the decision waiting for the hub, and the hub's answer.
 * Pure: the host owns the clock, the sending decision and the answer.
 *
 * @module
 */
import type { WorkRequestAnswer, WorkRequestDecisions } from "@knpkv/herdr-work/react"
import type { ApprovalDecision } from "./approval-decision.js"
import type { DecisionAnswer } from "./countdown-model.js"
import type { DecisionStatus } from "./countdown-view.js"
import type { DashboardSnapshot } from "./dashboard-model.js"

/** The board's word for an answer: the hub took it, refused it, or the outcome is not known yet. */
export const answerOutcome = (answer: DecisionAnswer): WorkRequestAnswer["outcome"] =>
  answer._tag === "Accepted" ? "accepted" : answer._tag === "Refused" ? "refused" : "uncertain"

/**
 * The expiry of a job this host can decide now: a time, `null` without one, `undefined` when it is
 * not listed here as pending, approvals are off, or the request can't be decided from this host.
 */
export const decidableExpiry = (snapshot: DashboardSnapshot, jobId: string): number | null | undefined => {
  if (!snapshot.approvalsEnabled) return undefined
  const record = snapshot.pendingApprovals.local.find(({ id }) => id === jobId)
  if (record === undefined || !record.approvalAvailable) return undefined
  return record.approvalExpiresAt ?? null
}

/**
 * The board's decisions for `snapshot` at hub time `now`. An answer belongs to the request it
 * decided: the same job listed again with another expiry is a new request, whose bar starts ready
 * instead of inheriting the old answer.
 */
export const workRequestDecisionsFor = ({
  now,
  onDecision,
  sending,
  snapshot,
  status
}: {
  readonly now: number
  readonly onDecision: (decision: ApprovalDecision) => void
  readonly sending: ApprovalDecision | null
  readonly snapshot: DashboardSnapshot
  readonly status: DecisionStatus | null
}): WorkRequestDecisions => {
  const listed = status === null ? undefined : decidableExpiry(snapshot, status.jobId)
  const current = status !== null && (listed === undefined || listed === status.expiresAt)
  return {
    answer: status !== null && current ? { jobId: status.jobId, outcome: status.outcome, text: status.text } : null,
    expiresAt: (jobId) => decidableExpiry(snapshot, jobId),
    now,
    onDecision,
    sending
  }
}
