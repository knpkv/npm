import type { RelayReviewResult, RelayReviewVerificationResult } from "../RelayReview.js"

export type FindingDisposition =
  | "acknowledged"
  | "failed"
  | "pending"
  | "posted"
  | "posted-stale"
  | "posting"
  | "rejected"

export interface RelayReviewReconciliation {
  readonly added: ReadonlyArray<string>
  readonly changed: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly reopened: ReadonlyArray<string>
}

/** Rejects self-contradictory agent verification claims before they reach the human-facing receipt. */
export const consistentRelayVerificationOutcome = (
  findingId: string,
  review: RelayReviewResult,
  claimed: RelayReviewVerificationResult["outcome"]
): RelayReviewVerificationResult["outcome"] => {
  const retained = review.findings.some((finding) => finding.id === findingId)
  if (claimed === "still-actionable") return retained ? claimed : "inconclusive"
  if (claimed === "resolved" || claimed === "superseded") return retained ? "inconclusive" : claimed
  return claimed
}

export const relayReviewReconciliationLabel = (value: RelayReviewReconciliation): string =>
  [
    value.added.length > 0 ? `+${value.added.length}` : null,
    value.changed.length > 0 ? `~${value.changed.length}` : null,
    value.removed.length > 0 ? `-${value.removed.length}` : null,
    value.reopened.length > 0 ? `${value.reopened.length} reopened` : null
  ].filter((part): part is string => part !== null).join(" · ") || "No finding changes"

/** Stable snapshot used to bind asynchronous post receipts to the exact reviewed finding content. */
export const relayFindingFingerprint = (finding: RelayReviewResult["findings"][number]): string =>
  JSON.stringify(finding)

/** States that still require an explicit human resolution. */
export const findingDispositionNeedsResolution = (disposition: FindingDisposition): boolean =>
  disposition === "pending" || disposition === "failed" || disposition === "posted-stale"

/** Accepts a provider post receipt only for the unchanged finding snapshot that initiated it. */
export const relayFindingPostReceiptMatches = (
  posting: { readonly findingId: string; readonly findingIndex: number; readonly fingerprint: string },
  currentFinding: RelayReviewResult["findings"][number] | undefined,
  receipt: { readonly findingId: string; readonly findingIndex: number }
): boolean =>
  receipt.findingId === posting.findingId &&
  receipt.findingIndex === posting.findingIndex &&
  currentFinding !== undefined &&
  relayFindingFingerprint(currentFinding) === posting.fingerprint

/** Head worktrees can represent only after-side line coordinates truthfully. */
export const relayFindingHeadEditorLine = (
  finding: RelayReviewResult["findings"][number] | null,
  selectedPath: string
): number | undefined =>
  finding?.location.scope === "line" &&
    finding.location.side === "after" &&
    finding.location.filePath === selectedPath
    ? finding.location.line
    : undefined

export interface RelayFindingSessionReply {
  readonly findingId: string
  readonly message: string
}

/** Binds an asynchronous review-session receipt to the finding that initiated it. */
export const relayFindingSessionReceiptMatches = (
  finding: Pick<RelayReviewResult["findings"][number], "id"> | null,
  receipt: { readonly findingId: string } | undefined
): boolean => finding !== null && receipt?.findingId === finding.id

/** Keeps a completed conversation or verification receipt on the finding that produced it. */
export const relayFindingSessionReply = (
  finding: Pick<RelayReviewResult["findings"][number], "id"> | null,
  reply: RelayFindingSessionReply | undefined
): RelayFindingSessionReply | undefined =>
  relayFindingSessionReceiptMatches(finding, reply) && reply !== undefined && reply.message.length > 0
    ? reply
    : undefined

/** Wraps finding navigation so the deck never dead-ends at its first or last card. */
export const adjacentFindingIndex = (count: number, index: number, direction: -1 | 1): number => {
  if (count <= 0) return 0
  return (index + direction + count) % count
}

/** Finds the next finding that still needs a human decision, wrapping once. */
export const nextPendingFindingIndex = (
  findingIds: ReadonlyArray<string>,
  dispositions: Readonly<Record<string, FindingDisposition>>,
  index: number
): number => {
  for (let offset = 1; offset <= findingIds.length; offset += 1) {
    const candidate = (index + offset) % findingIds.length
    const id = findingIds[candidate]
    if (id !== undefined && findingDispositionNeedsResolution(dispositions[id] ?? "pending")) return candidate
  }
  return index
}

/** Reopens changed local decisions and marks already-published copies as stale. */
export const reconcileRelayReviewSession = (
  previous: RelayReviewResult,
  next: RelayReviewResult,
  dispositions: Readonly<Record<string, FindingDisposition>>
): {
  readonly dispositions: Readonly<Record<string, FindingDisposition>>
  readonly reconciliation: RelayReviewReconciliation
} => {
  const previousById = new Map(previous.findings.map((finding) => [finding.id, finding]))
  const nextById = new Map(next.findings.map((finding) => [finding.id, finding]))
  const added = next.findings.filter((finding) => !previousById.has(finding.id)).map((finding) => finding.id)
  const removed = previous.findings.filter((finding) => !nextById.has(finding.id)).map((finding) => finding.id)
  const changed = next.findings
    .filter((finding) => {
      const prior = previousById.get(finding.id)
      return prior !== undefined && relayFindingFingerprint(prior) !== relayFindingFingerprint(finding)
    })
    .map((finding) => finding.id)
  const changedIds = new Set(changed)
  const nextDispositions: Record<string, FindingDisposition> = {}
  const reopened: Array<string> = []
  for (const finding of next.findings) {
    const current = dispositions[finding.id] ?? "pending"
    if (!changedIds.has(finding.id)) {
      nextDispositions[finding.id] = current
      continue
    }
    if (current === "posted" || current === "posted-stale") {
      nextDispositions[finding.id] = "posted-stale"
      continue
    }
    nextDispositions[finding.id] = "pending"
    if (current !== "pending") reopened.push(finding.id)
  }
  return {
    dispositions: nextDispositions,
    reconciliation: { added, changed, removed, reopened }
  }
}

/** Compact deck marker: current card, undecided, accepted, rejected, posted, or stale-posted. */
export const findingDispositionMarker = (disposition: FindingDisposition, current: boolean): string => {
  if (current) return "◆"
  switch (disposition) {
    case "acknowledged":
      return "✓"
    case "rejected":
      return "×"
    case "posted":
      return "↑"
    case "posted-stale":
      return "!"
    case "failed":
      return "!"
    case "posting":
      return "…"
    case "pending":
      return "·"
  }
}
