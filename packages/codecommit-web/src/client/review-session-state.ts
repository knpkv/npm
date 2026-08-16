/** Pure state transitions for human finding dispositions. @module */
import * as Schema from "effect/Schema"
import { MAXIMUM_RELAY_REVIEW_TURNS, type RelayReviewConversationTurn, type RelayReviewFinding } from "../server/Api.js"
import { MAXIMUM_RELAY_REVIEW_TURNS_BYTES } from "../server/review/ReviewPromptBudget.js"

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

/** Record a local decision without discarding an existing provider publication receipt. */
export const applyFindingDecision = (
  dispositions: FindingDispositions,
  findingId: string,
  decision: "acknowledged" | "rejected"
) => {
  const current = dispositions[findingId]
  if (current === "posting" || current === "posted" || current === "posted-stale") return dispositions
  return { ...dispositions, [findingId]: decision } satisfies FindingDispositions
}

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
): ReadonlyArray<RelayReviewConversationTurn> => {
  const candidates = [...turns, turn].slice(-MAXIMUM_RELAY_REVIEW_TURNS)
  const retained: Array<RelayReviewConversationTurn> = []
  const encoder = new TextEncoder()
  let bytes = 2
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]
    if (candidate === undefined) continue
    const candidateBytes = encoder.encode(JSON.stringify(candidate)).byteLength + (retained.length === 0 ? 0 : 1)
    if (bytes + candidateBytes > MAXIMUM_RELAY_REVIEW_TURNS_BYTES) break
    retained.push(candidate)
    bytes += candidateBytes
  }
  return retained.reverse()
}

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
    return [finding.id, disposition]
  }))
}
