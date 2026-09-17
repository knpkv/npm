/** Pure selection and result-retention transitions shared by review clients. @module */
import type { ReviewExecutionProfile, ReviewThreadIdentity } from "./model.js"
import { sameReviewThread } from "./model.js"

export type ReviewProfileResolution =
  | { readonly _tag: "Resolved"; readonly profile: ReviewExecutionProfile }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unknown"; readonly profileId: string }

/** Resolve an explicit selection fail-closed; only an absent selection may use the configured default. */
export const resolveReviewProfile = (
  profiles: ReadonlyArray<ReviewExecutionProfile>,
  selectedProfileId: string | null,
  defaultProfileId: string
): ReviewProfileResolution => {
  const profileId = selectedProfileId ?? defaultProfileId
  const profile = profiles.find(({ id }) => id === profileId)
  return profile === undefined
    ? selectedProfileId === null
      ? { _tag: "Missing" }
      : { _tag: "Unknown", profileId }
    : { _tag: "Resolved", profile }
}

export interface CompletedReview<Result> {
  readonly identity: ReviewThreadIdentity
  readonly profile: ReviewExecutionProfile
  readonly result: Result
}

export type ReviewResultPresentation<Result> =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Current"; readonly completed: CompletedReview<Result> }
  | { readonly _tag: "Previous"; readonly completed: CompletedReview<Result> }
  | { readonly _tag: "Stale"; readonly completed: CompletedReview<Result> }

/** Classify retained output without changing product-owned execution or persistence state. */
export const presentReviewResult = <Result>(
  identity: ReviewThreadIdentity,
  completed: CompletedReview<Result> | null,
  latestRunFailed: boolean
): ReviewResultPresentation<Result> => {
  if (completed === null) return { _tag: "Empty" }
  if (!sameReviewThread(identity, completed.identity)) return { _tag: "Stale", completed }
  return latestRunFailed
    ? { _tag: "Previous", completed }
    : { _tag: "Current", completed }
}
