/**
 * Authenticated host-local Code read contracts. Provider credentials, account/profile/region,
 * ARNs, cache paths and owner-session credentials never cross this boundary.
 * References are random persisted identifiers, not encoded provider locators.
 * @module
 */
import { Effect, Schema } from "effect"

export const CodeReference = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
)
export type CodeReference = typeof CodeReference.Type
const Text = Schema.String.check(Schema.isMaxLength(4096))
const ShortText = Schema.String.check(Schema.isMaxLength(256))

export const CodePullRequest = Schema.Struct({
  ref: CodeReference,
  id: ShortText,
  repository: ShortText,
  title: Text,
  author: ShortText,
  status: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  approval: Schema.Literals(["approved", "not_required", "waiting", "unknown"]),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  observedAt: Schema.NullOr(Schema.Number)
})
export type CodePullRequest = typeof CodePullRequest.Type

/** Expected failures expose a closed reason and safe host display only, never provider cause text. */
export const CodeUnavailable = Schema.TaggedStruct("Unavailable", {
  reason: Schema.Literals([
    "not_configured",
    "other_host",
    "cache_unavailable",
    "config_unavailable",
    "permission_required",
    "denied",
    "sign_in_required",
    "unavailable"
  ]),
  host: Schema.NullOr(ShortText)
})
export type CodeUnavailable = typeof CodeUnavailable.Type

export const CodeQueue = Schema.Union([
  CodeUnavailable,
  Schema.TaggedStruct("Ready", {
    items: Schema.Array(CodePullRequest).check(Schema.isMaxLength(50)),
    more: Schema.Boolean,
    observedAt: Schema.Number
  })
])
export type CodeQueue = typeof CodeQueue.Type

export const CodeDetail = Schema.Union([
  CodeUnavailable,
  Schema.TaggedStruct("Ready", {
    item: CodePullRequest,
    description: Schema.String.check(Schema.isMaxLength(16_384)),
    sourceBranch: ShortText,
    destinationBranch: ShortText
  })
])
export type CodeDetail = typeof CodeDetail.Type

/** Queue selectors are strictly decoded by the mount; provider coordinates are never selectors. */
export const CodeQueueSelection = Schema.Struct({
  filter: Schema.Literals(["open", "reviews", "all"]).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed("open"))),
  search: Schema.String.check(Schema.isMaxLength(256)).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(""))),
  offset: Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 10_000 })).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(0))
  )
})
export const CodeQueueQuery = Schema.fromURLSearchParams(CodeQueueSelection)
export type CodeQueueQuery = typeof CodeQueueQuery.Type

export const CodeTargetQuery = Schema.fromURLSearchParams(Schema.Struct({ ref: CodeReference }))
export type CodeTargetQuery = typeof CodeTargetQuery.Type

/** Host-local immutable diff inventory; provider account/profile/region and blob IDs are omitted. */
export const CodeDiff = Schema.Struct({
  pullRequestId: ShortText,
  revisionId: ShortText,
  baseCommit: ShortText,
  headCommit: ShortText,
  readAt: Schema.Number,
  cacheUpdatedAt: Schema.Number,
  files: Schema.Array(Schema.Struct({
    index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
    path: Text,
    previousPath: Schema.NullOr(Text),
    beforeMode: Schema.NullOr(ShortText),
    afterMode: Schema.NullOr(ShortText)
  })).check(Schema.isMaxLength(1000))
})
export type CodeDiff = typeof CodeDiff.Type

export const CodeDiffContent = Schema.Struct({
  fileIndex: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 999 })),
  revisionId: ShortText,
  state: Schema.Literals(["text", "binary", "oversized"]),
  before: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_048_576))),
  after: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_048_576)))
})
export type CodeDiffContent = typeof CodeDiffContent.Type

export const CodeDiffResult = Schema.Union([CodeUnavailable, Schema.TaggedStruct("Ready", { diff: CodeDiff })])
export type CodeDiffResult = typeof CodeDiffResult.Type
export const CodeDiffContentResult = Schema.Union([
  CodeUnavailable,
  Schema.TaggedStruct("Ready", { content: CodeDiffContent })
])
export type CodeDiffContentResult = typeof CodeDiffContentResult.Type

export const CodeDiffContentQuery = Schema.fromURLSearchParams(Schema.Struct({
  ref: CodeReference,
  revisionId: ShortText,
  baseCommit: ShortText,
  headCommit: ShortText,
  fileIndex: Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 999 }))
}))
export type CodeDiffContentQuery = typeof CodeDiffContentQuery.Type
