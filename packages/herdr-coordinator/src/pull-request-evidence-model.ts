import { WorkGoalId } from "@knpkv/herdr-work/model"
import { Schema } from "effect"

const Text = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^[^\p{Cc}\p{Cs}]+$/u)
)
const Timestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })
)
const PullRequestNumber = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))

export const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
export type CommitSha = typeof CommitSha.Type

export const PullRequestEvidenceRequest = Schema.Struct({
  repository: Text,
  pullRequest: PullRequestNumber,
  expectedHead: CommitSha
})

const CheckConclusion = Schema.Literals(["pending", "success", "failure"])
const ReviewState = Schema.Literals(["approved", "changes_requested", "commented"])
const BotReviewer = Schema.Literals(["chatgpt-codex-connector[bot]", "coderabbitai[bot]"])
const BodyDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/** Issue-comment review evidence is deliberately not a GitHub approval. */
export const BotReviewEvidence = Schema.Struct({
  id: Text,
  reviewer: BotReviewer,
  repository: Text,
  pullRequest: PullRequestNumber,
  head: CommitSha,
  bodySha256: BodyDigest,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  verdict: Schema.Literals(["clean", "finding", "unknown"]),
  runId: Schema.NullOr(Text)
})
export interface BotReviewEvidence extends Schema.Schema.Type<typeof BotReviewEvidence> {}

export const PullRequestAtomicObservation = Schema.Struct({
  repository: Text,
  pullRequest: PullRequestNumber,
  headAtStart: CommitSha,
  headAtEnd: CommitSha,
  observedAt: Timestamp,
  requiredChecks: Schema.Array(Text).check(Schema.isMaxLength(256)),
  checks: Schema.Array(Schema.Struct({
    name: Text,
    head: CommitSha,
    conclusion: CheckConclusion
  })).check(Schema.isMaxLength(256)),
  threads: Schema.Array(Schema.Struct({
    id: Text,
    head: CommitSha,
    resolved: Schema.Boolean,
    outdated: Schema.Boolean
  })).check(Schema.isMaxLength(2_048)),
  reviews: Schema.Array(Schema.Struct({
    id: Text,
    reviewer: Text,
    head: CommitSha,
    state: ReviewState,
    submittedAt: Timestamp
  })).check(Schema.isMaxLength(256)),
  botReviews: Schema.Array(BotReviewEvidence).check(Schema.isMaxLength(2_048)),
  formalReview: Schema.Struct({
    requiredApprovals: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    requiresCodeOwnerReview: Schema.Boolean,
    decision: Schema.NullOr(Schema.Literals(["approved", "changes_requested", "review_required"]))
  }),
  owner: Schema.Struct({ id: Text, name: Text }),
  work: Schema.Struct({
    goalId: WorkGoalId,
    releaseGoalId: Schema.NullOr(WorkGoalId),
    relation: Schema.Literals(["current", "superseded"])
  })
})
export interface PullRequestAtomicObservation extends Schema.Schema.Type<typeof PullRequestAtomicObservation> {}

/** Complete gate input whose source-sensitive evidence is bound to one observed commit. */
export const PullRequestGateInput = Schema.Struct({
  repository: Text,
  pullRequest: PullRequestNumber,
  expectedHead: CommitSha,
  observedHead: CommitSha,
  observedAt: Timestamp,
  freshUntil: Timestamp,
  projectedAt: Timestamp,
  requiredChecks: Schema.Array(Text).check(Schema.isMaxLength(256)),
  checks: Schema.Array(Schema.Struct({
    name: Text,
    head: CommitSha,
    conclusion: CheckConclusion
  })).check(Schema.isMaxLength(256)),
  threads: Schema.Array(Schema.Struct({
    id: Text,
    head: CommitSha,
    resolved: Schema.Boolean,
    outdated: Schema.Boolean
  })).check(Schema.isMaxLength(2_048)),
  reviews: Schema.Array(Schema.Struct({
    id: Text,
    reviewer: Text,
    head: CommitSha,
    state: ReviewState,
    submittedAt: Timestamp
  })).check(Schema.isMaxLength(256)),
  botReviews: Schema.Array(BotReviewEvidence).check(Schema.isMaxLength(2_048)),
  formalReview: Schema.Struct({
    requiredApprovals: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    requiresCodeOwnerReview: Schema.Boolean,
    decision: Schema.NullOr(Schema.Literals(["approved", "changes_requested", "review_required"]))
  }),
  owner: Schema.Struct({ id: Text, name: Text }),
  work: Schema.Struct({
    goalId: WorkGoalId,
    releaseGoalId: Schema.NullOr(WorkGoalId),
    relation: Schema.Literals(["current", "superseded"])
  })
}).check(
  Schema.makeFilter(
    (input) => {
      const requiredChecks = new Set(input.requiredChecks)
      const checkNames = new Set(input.checks.map(({ name }) => name))
      const threadIds = new Set(input.threads.map(({ id }) => id))
      const reviewIds = new Set(input.reviews.map(({ id }) => id))
      const botReviewIds = new Set(input.botReviews.map(({ id }) => id))
      return input.observedHead === input.expectedHead &&
        input.requiredChecks.length > 0 &&
        requiredChecks.size === input.requiredChecks.length &&
        checkNames.size === input.checks.length &&
        threadIds.size === input.threads.length &&
        reviewIds.size === input.reviews.length &&
        botReviewIds.size === input.botReviews.length &&
        input.requiredChecks.every((name) => checkNames.has(name)) &&
        input.checks.every(({ head }) => head === input.expectedHead) &&
        input.threads.every(({ head }) => head === input.expectedHead) &&
        input.reviews.every(({ head, submittedAt }) =>
          head === input.expectedHead && submittedAt <= input.observedAt
        ) &&
        input.botReviews.every(({ createdAt, head, pullRequest, repository, updatedAt }) =>
          repository === input.repository && pullRequest === input.pullRequest &&
          head === input.expectedHead && createdAt <= updatedAt && updatedAt <= input.observedAt
        ) &&
        input.observedAt <= input.projectedAt &&
        input.projectedAt <= input.freshUntil &&
        input.freshUntil <= input.observedAt + 60_000
    },
    { expected: "complete, fresh, unique source-sensitive evidence bound to one exact head" }
  )
)
export interface PullRequestGateInput extends Schema.Schema.Type<typeof PullRequestGateInput> {}

export class PullRequestEvidenceSourceError extends Schema.TaggedError<PullRequestEvidenceSourceError>()(
  "PullRequestEvidenceSourceError",
  { detail: Text }
) {}

export class PullRequestEvidenceInvalid extends Schema.TaggedError<PullRequestEvidenceInvalid>()(
  "PullRequestEvidenceInvalid",
  { detail: Text }
) {}

export class PullRequestEvidenceStale extends Schema.TaggedError<PullRequestEvidenceStale>()(
  "PullRequestEvidenceStale",
  { expectedHead: CommitSha, headAtStart: CommitSha, headAtEnd: CommitSha }
) {}
