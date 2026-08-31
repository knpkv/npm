/** Browser-safe provider-neutral review contracts. @module */
import * as Schema from "effect/Schema"

const boundedIdentifier = (maximumLength: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumLength),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
  )

export const ReviewKind = Schema.Literals(["review", "security", "tests", "explain"])
export type ReviewKind = typeof ReviewKind.Type

export const ReviewExecutionProfile = Schema.Struct({
  id: boundedIdentifier(128),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  kind: ReviewKind,
  provider: boundedIdentifier(128),
  harness: boundedIdentifier(128),
  model: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  skillIds: Schema.Array(boundedIdentifier(256)).check(Schema.isMaxLength(24), Schema.isUnique())
})
export type ReviewExecutionProfile = typeof ReviewExecutionProfile.Type

export const ReviewThreadIdentity = Schema.Struct({
  namespace: boundedIdentifier(128),
  subjectId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  revisionId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  baseRevision: Schema.NullOr(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_024))
  ),
  headRevision: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_024))
})
export type ReviewThreadIdentity = typeof ReviewThreadIdentity.Type

/** Stable local key. Provider locators and credentials must not enter this browser-safe identity. */
export const reviewThreadKey = (identity: ReviewThreadIdentity): string =>
  JSON.stringify([
    identity.namespace,
    identity.subjectId,
    identity.revisionId,
    identity.baseRevision,
    identity.headRevision
  ])

export const sameReviewThread = (left: ReviewThreadIdentity, right: ReviewThreadIdentity): boolean =>
  reviewThreadKey(left) === reviewThreadKey(right)
