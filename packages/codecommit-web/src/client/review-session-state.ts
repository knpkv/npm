/** Pure state transitions for human finding dispositions. @module */
import * as Schema from "effect/Schema"
import { MAXIMUM_RELAY_REVIEW_TURNS, type RelayReviewConversationTurn, type RelayReviewFinding } from "../server/Api.js"

export const FindingDisposition = Schema.Literals([
  "pending",
  "posting",
  "posted",
  "posted-stale",
  "acknowledged",
  "rejected",
  "failed"
])
export type FindingDisposition = typeof FindingDisposition.Type

export type FindingDispositions = Readonly<Record<string, FindingDisposition>>

export const initialFindingDispositions = (
  findings: ReadonlyArray<RelayReviewFinding>
): FindingDispositions =>
  Object.fromEntries(
    findings.map((finding): [string, FindingDisposition] => [finding.id, "pending"])
  )

const findingIdentity = (finding: RelayReviewFinding): string => JSON.stringify(finding)

export interface FindingPublicationSettlement {
  readonly dispositions: FindingDispositions
  readonly stale: boolean
}

/** Bind a provider receipt to the exact finding snapshot that initiated publication. */
export const settleFindingPublication = (
  currentFindings: ReadonlyArray<RelayReviewFinding>,
  submittedFinding: RelayReviewFinding,
  dispositions: FindingDispositions,
  outcome: "posted" | "failed"
): FindingPublicationSettlement => {
  const current = currentFindings.find(({ id }) => id === submittedFinding.id)
  const stale = current === undefined || findingIdentity(current) !== findingIdentity(submittedFinding)
  if (stale && outcome === "failed") return { dispositions, stale: false }
  return {
    dispositions: {
      ...dispositions,
      [submittedFinding.id]: stale ? "posted-stale" : outcome
    },
    stale
  }
}

/** Retain the newest bounded conversation window accepted by the continuation API. */
export const appendReviewTurn = (
  turns: ReadonlyArray<RelayReviewConversationTurn>,
  turn: RelayReviewConversationTurn
): ReadonlyArray<RelayReviewConversationTurn> => [...turns, turn].slice(-MAXIMUM_RELAY_REVIEW_TURNS)

/** Preserve human decisions only while the agent finding remains byte-for-byte equivalent. */
export const reconcileFindingDispositions = (
  previous: ReadonlyArray<RelayReviewFinding>,
  next: ReadonlyArray<RelayReviewFinding>,
  dispositions: FindingDispositions
): FindingDispositions => {
  const previousById = new Map(previous.map((finding): [string, RelayReviewFinding] => [finding.id, finding]))
  return Object.fromEntries(next.map((finding): [string, FindingDisposition] => {
    const prior = previousById.get(finding.id)
    const disposition = dispositions[finding.id] ?? "pending"
    if (prior === undefined || findingIdentity(prior) !== findingIdentity(finding)) {
      return [finding.id, disposition === "posted" || disposition === "posted-stale" ? "posted-stale" : "pending"]
    }
    return [finding.id, disposition === "posting" ? "failed" : disposition]
  }))
}
