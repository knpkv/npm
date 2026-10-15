/** Recorded finding status words shared by the card and its index. No actor/time inference. @module */
import type { ReviewDisposition, ReviewFinding } from "@knpkv/review"

/** Approved labels for recorded confidence, shared by a finding and its navigation row. */
export const reviewConfidenceWords = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence"
} satisfies Record<NonNullable<ReviewFinding["confidence"]>, string>

const dispositionWords = {
  Open: null,
  FixedVerify: "Fix pushed",
  Resolved: "Resolved",
  Dismissed: "Dismissed"
} satisfies Record<ReviewDisposition["_tag"], string | null>

const dismissalReasons = {
  false_positive: "False positive",
  wont_fix: "Won’t fix",
  already_fixed: "Already fixed elsewhere",
  other: "Other"
} satisfies Record<Extract<ReviewDisposition, { readonly _tag: "Dismissed" }>["reason"], string>

/** Recorded state only. The read model has no actor or resolution time to attribute. */
export function reviewDispositionText(disposition: ReviewDisposition): string | null {
  if (disposition._tag === "FixedVerify") {
    return `${dispositionWords.FixedVerify} in ${disposition.commit}, waiting for re-review`
  }
  if (disposition._tag === "Dismissed") {
    const note = disposition.note === null || disposition.note.length === 0 ? "" : `, ‘${disposition.note}’`
    return `${dispositionWords.Dismissed}: ${dismissalReasons[disposition.reason]}${note}`
  }
  return dispositionWords[disposition._tag]
}

/** Recorded status presentation is shared by the card and its navigation row. */
export const reviewDispositionTones = {
  Open: "neutral",
  FixedVerify: "caution",
  Resolved: "positive",
  Dismissed: "neutral"
} satisfies Record<ReviewDisposition["_tag"], "neutral" | "caution" | "positive">
