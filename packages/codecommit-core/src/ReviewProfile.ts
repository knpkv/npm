/** Shared persisted and transported Relay review profile contract. @module */
import { Effect, Schema } from "effect"

/** Maximum prompt-only skills accepted by one persisted review profile. */
export const reviewProfileSkillLimit = 24

const decodingDefault = <A>(value: A): Effect.Effect<A, Schema.SchemaError> => Effect.succeed(value)

export const ReviewKind = Schema.Literals(["review", "security", "tests", "explain"])
export type ReviewKind = typeof ReviewKind.Type
export const reviewKindOptions = ReviewKind.literals

export const ReviewProvider = Schema.Literals(["codex"])
export type ReviewProvider = typeof ReviewProvider.Type

export const ReviewHarness = Schema.Literals(["native-codex"])
export type ReviewHarness = typeof ReviewHarness.Type

export const ReviewModel = Schema.Literals([
  "configured-default",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol"
])
export type ReviewModel = typeof ReviewModel.Type

export const reviewProviderOptions = ReviewProvider.literals
export const reviewHarnessOptions = ReviewHarness.literals
export const reviewModelOptions = ReviewModel.literals

export const ReviewProfileConfig = Schema.Struct({
  id: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z][a-z0-9-]*$/u)
  ),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(80)),
  kind: ReviewKind,
  provider: ReviewProvider.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault("codex"))),
  harness: ReviewHarness.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault("native-codex"))),
  model: ReviewModel.pipe(Schema.withDecodingDefaultTypeKey(decodingDefault("configured-default"))),
  skillIds: Schema.Array(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256))
  ).check(Schema.isMaxLength(reviewProfileSkillLimit), Schema.isUnique())
})
export type ReviewProfileConfig = typeof ReviewProfileConfig.Type

export const defaultReviewProfiles: ReadonlyArray<ReviewProfileConfig> = [
  {
    id: "thorough",
    name: "Thorough review",
    kind: "review",
    provider: "codex",
    harness: "native-codex",
    model: "configured-default",
    skillIds: ["builtin:pr-review", "builtin:pr-review-diff"]
  },
  {
    id: "security",
    name: "Security review",
    kind: "security",
    provider: "codex",
    harness: "native-codex",
    model: "configured-default",
    skillIds: ["builtin:pr-review-diff"]
  },
  {
    id: "tests",
    name: "Test review",
    kind: "tests",
    provider: "codex",
    harness: "native-codex",
    model: "configured-default",
    skillIds: ["builtin:pr-review-diff"]
  },
  {
    id: "explain",
    name: "Explain change",
    kind: "explain",
    provider: "codex",
    harness: "native-codex",
    model: "configured-default",
    skillIds: []
  }
]

export const ReviewConfig = Schema.Struct({
  defaultProfileId: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z][a-z0-9-]*$/u)
  ).pipe(Schema.withDecodingDefaultTypeKey(decodingDefault("thorough"))),
  profiles: Schema.Array(ReviewProfileConfig).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(12)
  ).pipe(Schema.withDecodingDefaultTypeKey(decodingDefault(defaultReviewProfiles)))
}).check(
  Schema.makeFilter(
    ({ defaultProfileId, profiles }) =>
      new Set(profiles.map(({ id }) => id)).size === profiles.length &&
      profiles.some(({ id }) => id === defaultProfileId),
    { expected: "unique review profile ids containing the default profile" }
  )
)
export type ReviewConfig = typeof ReviewConfig.Type

export const defaultReviewConfig: ReviewConfig = {
  defaultProfileId: "thorough",
  profiles: defaultReviewProfiles
}
