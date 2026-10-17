/**
 * Authenticated host-local Code read contracts. Provider credentials, account/profile/region,
 * ARNs, cache paths and owner-session credentials never cross this boundary.
 * References are random persisted identifiers, not encoded provider locators.
 * @module
 */
import { ReviewThread, ReviewWorkspace } from "@knpkv/review"
import { CanvasReading } from "@knpkv/review/canvas"
import { Effect, Result, Schema } from "effect"

export const CodeReference = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
)
export type CodeReference = typeof CodeReference.Type
const Text = Schema.String.check(Schema.isMaxLength(4096))
const ShortText = Schema.String.check(Schema.isMaxLength(256))

/** Authenticated client-visible loopback origin only; no credential, path, query or fragment. */
export const CodeOwnerUi = Schema.String.check(Schema.makeFilter((origin) => {
  const decoded = Schema.decodeUnknownResult(Schema.URLFromString)(origin)
  if (Result.isFailure(decoded)) return false
  const url = decoded.success
  return url.protocol === "http:" &&
    Schema.is(Schema.Literals(["127.0.0.1", "localhost", "[::1]"]))(url.hostname) &&
    url.origin === origin
}))

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
  Schema.Struct({ ...CodeUnavailable.fields, ownerUi: Schema.optionalKey(CodeOwnerUi) }),
  Schema.TaggedStruct("Ready", {
    items: Schema.Array(CodePullRequest).check(Schema.isMaxLength(50)),
    more: Schema.Boolean,
    observedAt: Schema.Number,
    ownerUi: Schema.optionalKey(CodeOwnerUi)
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

/** Independent cached review/comments and current immutable diff; subject identities are opaque refs. */
export const CodeReviewReading = Schema.Struct({ diff: CodeDiff, workspace: ReviewWorkspace }).check(Schema.makeFilter(
  ({ diff, workspace }) =>
    Schema.is(CodeReference)(workspace.identity.subjectId) &&
    workspace.identity.namespace === "codecommit" && workspace.identity.revisionId === diff.revisionId &&
    workspace.identity.baseRevision === diff.baseCommit && workspace.identity.headRevision === diff.headCommit,
  { expected: "the current workspace identity matches this immutable diff and uses an opaque Code reference" }
))
export type CodeReviewReading = typeof CodeReviewReading.Type
export const CodeReviewResult = Schema.Union([
  CodeUnavailable,
  Schema.TaggedStruct("Ready", { reading: CodeReviewReading })
])
export type CodeReviewResult = typeof CodeReviewResult.Type

/**
 * The canvas reading of the same immutable revision: changed files, import edges between them and their changed
 * parts. Paths are repository-relative change paths, as in the diff; no provider locator crosses this boundary.
 */
export const CodeCanvasResult = Schema.Union([
  CodeUnavailable,
  Schema.TaggedStruct("Ready", { reading: CanvasReading })
])
export type CodeCanvasResult = typeof CodeCanvasResult.Type

/** Browser-owned read selectors. Thread source/id is normalized, authenticated client-visible data. */
export const CodeReviewPresentation = Schema.Literals(["review", "conversation", "guide", "canvas"])
export type CodeReviewPresentation = typeof CodeReviewPresentation.Type
export const CodeReviewThreadTarget = Schema.Struct({ source: ReviewThread.fields.source, id: ReviewThread.fields.id })
export type CodeReviewThreadTarget = typeof CodeReviewThreadTarget.Type
