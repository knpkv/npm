/**
 * The Approvals tab's countdown model: which pending request expires first, how its clock reads,
 * when the clock ticks, what crosses a threshold worth announcing, and how the hub's answer to a
 * decision is worded. Pure: the view passes `now`.
 *
 * The clock is display only. A request is expired when the hub says so (its record is `expired`,
 * or it has left the pending list), never because the client clock reached zero; at zero the row
 * reads "expiring" and its actions stay usable, so the hub's refusal is what the reader sees.
 *
 * @module
 */
import { Data } from "effect"
import { jobTitle } from "./activity-history.js"
import type { SanitizedJobRecord } from "./approval-request.js"
import type { DashboardSnapshot, PendingApproval } from "./dashboard-model.js"

/** Under this much time left the clock keeps seconds and ticks every second. */
export const SOON_MS = 5 * 60_000

/** Under this much time left the request is announced once and its word turns to "about to expire". */
export const IMMINENT_MS = 60_000

/** One pending request, decided here (`Local`) or on the host that owns it (`Remote`). */
export type PendingItem = Data.TaggedEnum<{
  Local: { readonly record: SanitizedJobRecord }
  Remote: { readonly approval: PendingApproval; readonly approvalUrl: string; readonly host: string }
}>

/** Constructors and exhaustive `$match` for {@link PendingItem}. */
export const PendingItem = Data.taggedEnum<PendingItem>()

/** What every row and the detail read from an item, whichever host owns it. */
export interface PendingFacts {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly host: string
  readonly actor: string
  readonly createdAt: number
  readonly expiresAt: number | null
}

export const factsOf = (item: PendingItem, localHost: string): PendingFacts =>
  PendingItem.$match(item, {
    Local: ({ record }) => ({
      actor: record.actor,
      createdAt: record.createdAt,
      expiresAt: record.approvalExpiresAt ?? null,
      host: localHost,
      id: record.id,
      kind: record.payload.kind,
      title: jobTitle(record)
    }),
    Remote: ({ approval, host }) => ({
      actor: approval.actor,
      createdAt: approval.createdAt,
      expiresAt: approval.approvalExpiresAt,
      host,
      id: approval.id,
      kind: approval.payload.kind,
      title: jobTitle(approval)
    })
  })

/** Rows key: a job id is only unique on its own host. */
export const itemKey = (facts: Pick<PendingFacts, "host" | "id">): string => `${facts.host}:${facts.id}`

/**
 * Every pending request, local and remote, soonest expiry first; requests without an expiry go
 * last, newest first among equals.
 */
export const pendingItems = (snapshot: DashboardSnapshot): ReadonlyArray<PendingItem> => {
  const items = [
    ...snapshot.pendingApprovals.local.map((record) => PendingItem.Local({ record })),
    ...snapshot.pendingApprovals.remote.map((remote) =>
      PendingItem.Remote({ approval: remote.approval, approvalUrl: remote.approvalUrl, host: remote.host })
    )
  ]
  const expiry = (item: PendingItem): number => factsOf(item, snapshot.host).expiresAt ?? Number.POSITIVE_INFINITY
  return items.sort(
    (left, right) =>
      expiry(left) - expiry(right) ||
      factsOf(right, snapshot.host).createdAt - factsOf(left, snapshot.host).createdAt
  )
}

/** "52s", "4m 12s", "11m": seconds only matter under five minutes. Never negative. */
export const countdownText = (leftMs: number): string => {
  const seconds = Math.max(0, Math.floor(leftMs / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `${seconds}s`
  return leftMs < SOON_MS ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${minutes}m`
}

/** How close a request is to its expiry, for its word and its clock's ink. */
export type Urgency = "calm" | "soon" | "imminent" | "due"

export const urgencyOf = (leftMs: number): Urgency =>
  leftMs <= 0 ? "due" : leftMs < IMMINENT_MS ? "imminent" : leftMs < SOON_MS ? "soon" : "calm"

/** The clock for one request: its text, or "expiring" at zero while the hub has not answered. */
export const clockText = (expiresAt: number | null, now: number): string | null => {
  if (expiresAt === null) return null
  const left = expiresAt - now
  return left <= 0 ? "expiring" : countdownText(left)
}

/**
 * How much of a request's approval window is used, for its row's LimitTrack: `value` in percent of
 * the window, with the near mark where five minutes remain. `null` without an expiry or a window.
 */
export const windowUsed = (
  createdAt: number,
  expiresAt: number | null,
  now: number
): { readonly value: number; readonly near: number } | null => {
  if (expiresAt === null || expiresAt <= createdAt) return null
  const window = expiresAt - createdAt
  return {
    near: Math.min(100, Math.max(0, 100 - (SOON_MS / window) * 100)),
    value: Math.min(100, Math.max(0, ((now - createdAt) / window) * 100))
  }
}

/** Tick every second while any clock shows seconds, otherwise every 15 seconds. */
export const tickInterval = (expiries: ReadonlyArray<number | null>, now: number): number =>
  expiries.some((expiresAt) => expiresAt !== null && expiresAt - now < SOON_MS + 1000) ? 1000 : 15_000

/**
 * Requests whose clock crossed into the last minute between two readings, for one polite
 * announcement each. Ticking text is never announced.
 */
export const crossedIntoLastMinute = (
  facts: ReadonlyArray<PendingFacts>,
  previousNow: number,
  now: number
): ReadonlyArray<PendingFacts> =>
  facts.filter(
    ({ expiresAt }) => expiresAt !== null && expiresAt - previousNow >= IMMINENT_MS && expiresAt - now < IMMINENT_MS
  )

/** "52s ago", "4m ago", "2h 5m ago", for decisions and request ages. */
export const agoText = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
}

/** A finished approval decision, newest first in "Recently decided". */
export interface DecidedItem {
  readonly record: SanitizedJobRecord
  readonly outcome: "Approved" | "Rejected" | "Expired"
  readonly by: string | null
  readonly at: number
}

export const decidedOf = (record: SanitizedJobRecord): DecidedItem | null => {
  if (record.rejectedBy != null) {
    return { at: record.rejectedAt ?? record.updatedAt, by: record.rejectedBy, outcome: "Rejected", record }
  }
  if (record.status === "expired") {
    return { at: record.expiredAt ?? record.updatedAt, by: null, outcome: "Expired", record }
  }
  if (record.approvedBy !== null) {
    return { at: record.approvedAt ?? record.updatedAt, by: record.approvedBy, outcome: "Approved", record }
  }
  return null
}

/** How the hub answered one decision, as the DecisionBar's announced status. */
export type DecisionAnswer = Data.TaggedEnum<{
  Accepted: { readonly decision: "approve" | "reject"; readonly record: SanitizedJobRecord }
  Refused: { readonly status: number }
  Unreachable: {}
}>

/** Constructors and exhaustive `$match` for {@link DecisionAnswer}. */
export const DecisionAnswer = Data.taggedEnum<DecisionAnswer>()

export const answerText = (answer: DecisionAnswer): string =>
  DecisionAnswer.$match(answer, {
    Accepted: ({ decision, record }) =>
      decision === "reject"
        ? "The hub recorded your rejection. Nothing will run."
        : record.status === "queued" || record.status === "running"
        ? "The hub recorded your approval; the job is queued."
        : "The hub recorded your approval.",
    Refused: ({ status }) =>
      status === 409
        ? "The hub refused: this request already changed (it expired or someone decided it). Nothing was applied."
        : status === 403
        ? "The hub refused: you can't decide this request."
        : status === 404
        ? "The hub no longer has this request. Nothing was applied."
        : `The hub refused the decision (HTTP ${String(status)}). Nothing was applied.`,
    Unreachable: () => "Couldn't reach the hub, so the decision may not have arrived. Refresh before trying again."
  })
