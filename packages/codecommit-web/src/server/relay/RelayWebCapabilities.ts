/**
 * CodeCommit web's own Relay capabilities: the ones that need the exact-revision review machinery that
 * lives in this server, not in codecommit-core.
 *
 * **Mental model**
 *
 * - **The diff is the exact revision's.** `get_pull_request_diff` lists the changed files of the revision
 *   CodeCommit reports now, with the revision it read, so a later line comment can pin to it.
 * - **A line comment lands where the person saw it, or not at all.** `post_line_comment` carries the
 *   revision the comment was written against. If the pull request has moved since, it fails
 *   `ReviewHeadMoved`; if the line is outside the patch, `CommentLineOutsidePatch`. It never lands on a
 *   different line. The confirmation shows the file, side, line, revision and exact text.
 * - **One gate for comments.** It posts through {@link RelayFindingPublisher}, like review findings, so the
 *   permission rules, prompt and audit log apply after Relay's own confirmation.
 *
 * @module
 */
import { defineContract, implement } from "@knpkv/capability"
import { CacheService, Errors, PRService, ReadClient, RelayCapabilities } from "@knpkv/codecommit-core"
import { Effect, Option, Schema } from "effect"
import { loadPullRequestDiff, postPullRequestLineComment } from "../review/PullRequestReview.js"
import type { PullRequestReviewError } from "../review/PullRequestReview.js"
import { RelayFindingPublisher } from "../review/RelayFindingPublisher.js"

const {
  CodeCommitUnavailable,
  CommentNotPermitted,
  PullRequestCoordinates,
  PullRequestNotCached,
  commentNotPermitted,
  pullRequestRef
} = RelayCapabilities

/** The pull request moved to a newer head since the comment was written against it. */
export class ReviewHeadMoved extends Schema.TaggedError<ReviewHeadMoved>()("ReviewHeadMoved", {
  message: Schema.String,
  fix: Schema.String
}) {}

/** The commented line is not part of the pull request's changes on that side. */
export class CommentLineOutsidePatch extends Schema.TaggedError<CommentLineOutsidePatch>()(
  "CommentLineOutsidePatch",
  { message: Schema.String, fix: Schema.String }
) {}

/** The exact revision a diff was read at, and a line comment is pinned to. */
export const ReviewRevision = Schema.Struct({
  revisionId: Schema.String.check(Schema.isNonEmpty()),
  baseCommit: Schema.String.check(Schema.isNonEmpty()),
  headCommit: Schema.String.check(Schema.isNonEmpty())
})

const MaxFiles = 200

/** List the changed files of a pull request's current revision. */
export const getPullRequestDiff = defineContract({
  name: "get_pull_request_diff",
  description: "The files a CodeCommit pull request changes at its current revision (added, modified, deleted, " +
    `renamed), with that revision's ids. At most ${MaxFiles} files; \`total\` counts all of them.`,
  access: "read",
  input: Schema.Struct({ pullRequest: PullRequestCoordinates }),
  output: Schema.Struct({
    pullRequest: PullRequestCoordinates,
    revision: ReviewRevision,
    files: Schema.Array(Schema.Struct({
      status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
      path: Schema.String,
      previousPath: Schema.NullOr(Schema.String)
    })),
    total: Schema.Number
  }),
  failure: Schema.Union([PullRequestNotCached, CodeCommitUnavailable]),
  cites: (output) => [pullRequestRef(output.pullRequest)]
})

const LineLocation = Schema.Struct({
  filePath: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  side: Schema.Literals(["before", "after"])
})

/** Post a comment on one line of a pull request, pinned to the revision it was written against. */
export const postLineComment = defineContract({
  name: "post_line_comment",
  description: "Post a comment on one line of a CodeCommit pull request's changes. `side` is `after` for the " +
    "changed code and `before` for removed code. `revision` is the revision the line was read at " +
    "(from get_pull_request_diff or the attached review findings); if the pull request has moved since, the post " +
    "is refused. The person confirms the exact text first.",
  access: "write",
  reversible: false,
  describe: (input: {
    readonly pullRequest: RelayCapabilities.PullRequestCoordinates
    readonly revision: typeof ReviewRevision.Type
    readonly location: typeof LineLocation.Type
    readonly content: string
  }) => ({
    verb: "post line comment",
    target: pullRequestRef(input.pullRequest),
    args: { content: input.content, location: { ...input.location }, revision: { ...input.revision } }
  }),
  input: Schema.Struct({
    pullRequest: PullRequestCoordinates,
    revision: ReviewRevision,
    location: LineLocation,
    content: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(10_000))
  }),
  output: Schema.Struct({ pullRequest: PullRequestCoordinates, operationId: Schema.String, summary: Schema.String }),
  failure: Schema.Union([
    PullRequestNotCached,
    ReviewHeadMoved,
    CommentLineOutsidePatch,
    CommentNotPermitted,
    CodeCommitUnavailable
  ]),
  cites: (output) => [pullRequestRef(output.pullRequest)]
})

const isAwsApiError = Schema.is(Errors.AwsApiError)

const decodePullRequest = Schema.decodeEffect(PRService.CachedPRToPullRequest)

const cacheUnavailable = () =>
  new CodeCommitUnavailable({
    message: "The local pull-request cache could not be read.",
    fix: "Restart codecommit web; if it persists, check ~/.codecommit is readable."
  })

/** The cached pull request at these coordinates, as the review machinery takes it. */
const cachedPullRequest = Effect.fn("RelayWebCapabilities.cachedPullRequest")(function*(
  coordinates: RelayCapabilities.PullRequestCoordinates
) {
  const repo = yield* CacheService.PullRequestRepo
  const row = yield* repo.findByCoordinates(
    coordinates.accountId,
    coordinates.pullRequestId,
    coordinates.repositoryName,
    coordinates.region
  ).pipe(Effect.mapError(cacheUnavailable))
  if (Option.isNone(row)) {
    return yield* new PullRequestNotCached({
      message: `Pull request ${coordinates.pullRequestId} in ${coordinates.repositoryName} is not in the local cache.`,
      fix: "Refresh the pull-request queue, or check the account is enabled in Settings."
    })
  }
  return yield* decodePullRequest(row.value).pipe(Effect.mapError(cacheUnavailable))
})

const unavailable = (error: PullRequestReviewError) =>
  new CodeCommitUnavailable({
    message: error.message,
    fix: "Try again; if it repeats, open the pull request in the AWS console."
  })

/**
 * A review-machinery failure as the model reads it: a moved head, an anchor outside the patch and a refused
 * post are typed, the rest unavailable.
 */
const reviewFailure = (error: PullRequestReviewError) => {
  switch (error.operation) {
    case "revision-changed":
      return new ReviewHeadMoved({
        message: "The pull request has a newer head than the revision this comment was written against.",
        fix: "Read the diff (or re-run the review) on the current head, then comment again."
      })
    case "line-comment-anchor":
      return new CommentLineOutsidePatch({
        message: error.message,
        fix: "Pick a line inside the changes, or post a top-level comment instead."
      })
    case "line-comment":
      // The publisher's failure rides as the cause; only its permission refusal is typed for the model.
      return (isAwsApiError(error.cause) ? commentNotPermitted(error.cause) : undefined) ?? unavailable(error)
    default:
      return unavailable(error)
  }
}

/** CodeCommit web's capabilities, bound to their handlers, by contract. */
export const webCapabilities = {
  getPullRequestDiff: implement(getPullRequestDiff, (input) =>
    Effect.gen(function*() {
      const pullRequest = yield* cachedPullRequest(input.pullRequest)
      const client = yield* ReadClient.CodeCommitReadClient
      // A read pins nothing, so neither a moved head nor an anchor can fail it: only CodeCommit can.
      const diff = yield* loadPullRequestDiff(client, pullRequest).pipe(Effect.mapError(unavailable))
      return {
        pullRequest: input.pullRequest,
        revision: { revisionId: diff.revisionId, baseCommit: diff.baseCommit, headCommit: diff.headCommit },
        files: diff.files.slice(0, MaxFiles).map((file) => ({
          status: file.status,
          path: file.path,
          previousPath: file.previousPath
        })),
        total: diff.files.length
      }
    })),
  postLineComment: implement(postLineComment, (input) =>
    Effect.gen(function*() {
      const pullRequest = yield* cachedPullRequest(input.pullRequest)
      const client = yield* ReadClient.CodeCommitReadClient
      const publisher = yield* RelayFindingPublisher
      const posted = yield* postPullRequestLineComment(
        client,
        publisher,
        pullRequest,
        input.revision,
        input.location,
        input.content
      ).pipe(Effect.mapError(reviewFailure))
      return { pullRequest: input.pullRequest, operationId: posted.operationId, summary: posted.summary }
    }))
}
