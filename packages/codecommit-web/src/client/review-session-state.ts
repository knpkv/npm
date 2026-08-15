/** Pure state transitions for human finding dispositions. @module */
import type { RelayReviewFinding } from "../server/Api.js"

export type FindingDisposition =
  | "pending"
  | "posting"
  | "posted"
  | "posted-stale"
  | "acknowledged"
  | "rejected"
  | "failed"

export type FindingDispositions = Readonly<Record<string, FindingDisposition>>

export const initialFindingDispositions = (
  findings: ReadonlyArray<RelayReviewFinding>
): FindingDispositions =>
  Object.fromEntries(
    findings.map((finding): [string, FindingDisposition] => [finding.id, "pending"])
  )

const findingIdentity = (finding: RelayReviewFinding): string => JSON.stringify(finding)

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
