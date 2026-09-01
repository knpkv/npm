/** Pure state transitions for human finding dispositions. @module */
import * as Schema from "effect/Schema"
import {
  MAXIMUM_RELAY_REVIEW_TURNS,
  type PullRequestRelayReviewResponse,
  type RelayReviewConversationTurn,
  type RelayReviewFinding
} from "../server/Api.js"
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

export interface RelayReviewCompletion {
  readonly expectedIdentity: string
  readonly identity: string
  readonly skillIds: ReadonlyArray<string>
  readonly turns: ReadonlyArray<RelayReviewConversationTurn>
  readonly value: PullRequestRelayReviewResponse
}

/** Replace a review result without dropping the conversation already shown for this PR. */
export const replaceRelayReviewPreservingTurns = (
  turns: ReadonlyArray<RelayReviewConversationTurn>,
  next: Omit<RelayReviewCompletion, "turns">
): RelayReviewCompletion => ({ ...next, turns })

/** Keep PR turns across reruns, but bind finding turns to an unchanged snapshot. */
export const reconcileReviewConversationTurns = (
  previous: PullRequestRelayReviewResponse | null,
  next: PullRequestRelayReviewResponse,
  turns: ReadonlyArray<RelayReviewConversationTurn>
): ReadonlyArray<RelayReviewConversationTurn> => {
  if (previous === null) return turns
  const nextFindings = new Map(
    next.result.findings.map((finding): [string, string] => [finding.id, findingIdentity(finding)])
  )
  const previousFindings = new Map(
    previous.result.findings.map((finding): [string, string] => [finding.id, findingIdentity(finding)])
  )
  return turns.filter(({ findingId }) => {
    if (findingId === "PR") return true
    const previousIdentity = previousFindings.get(findingId)
    return previousIdentity !== undefined && previousIdentity === nextFindings.get(findingId)
  })
}

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
  if (stale && outcome === "failed" && current === undefined) return { dispositions, stale: false }
  return {
    dispositions: {
      ...dispositions,
      [submittedFinding.id]: stale && outcome === "posted" ? "posted-stale" : outcome
    },
    stale
  }
}

/** Retain the newest bounded conversation window accepted by the continuation API. */
export const appendReviewTurn = (
  turns: ReadonlyArray<RelayReviewConversationTurn>,
  turn: RelayReviewConversationTurn
): ReadonlyArray<RelayReviewConversationTurn> => {
  const candidates = [...turns, turn]
  const retained: Array<ReadonlyArray<RelayReviewConversationTurn>> = []
  const encoder = new TextEncoder()
  let bytes = 2
  let count = 0
  for (let index = candidates.length - 1; index >= 0;) {
    const candidate = candidates[index]
    if (candidate === undefined) {
      index -= 1
      continue
    }
    let exchange: ReadonlyArray<RelayReviewConversationTurn>
    if (candidate.role === "assistant") {
      const user = candidates[index - 1]
      if (user?.role !== "user" || user.findingId !== candidate.findingId) {
        index -= 1
        continue
      }
      exchange = [user, candidate]
      index -= 2
    } else {
      exchange = [candidate]
      index -= 1
    }
    const exchangeBytes = exchange.reduce(
      (total, item, exchangeIndex) =>
        total + encoder.encode(JSON.stringify(item)).byteLength + (count === 0 && exchangeIndex === 0 ? 0 : 1),
      0
    )
    if (
      count + exchange.length > MAXIMUM_RELAY_REVIEW_TURNS || bytes + exchangeBytes > MAXIMUM_RELAY_REVIEW_TURNS_BYTES
    ) {
      break
    }
    retained.push(exchange)
    count += exchange.length
    bytes += exchangeBytes
  }
  return retained.reverse().flat()
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
      if (disposition === "posting") return [finding.id, disposition]
      return [finding.id, disposition === "posted" || disposition === "posted-stale" ? "posted-stale" : "pending"]
    }
    return [finding.id, disposition]
  }))
}
