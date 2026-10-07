/**
 * CodeCommit's capabilities for Relay: what the assistant may read about a pull request, and the one
 * thing it may change (post a comment, after the person confirms it).
 *
 * **Mental model**
 *
 * - **Reads answer from the cache.** The queue and the detail page read the same rows, so Relay agrees
 *   with what the person sees. A pull request the cache doesn't hold is `PullRequestNotCached`, with the
 *   refresh as the fix; Relay never widens its reach beyond the configured accounts.
 * - **Listing is a queue.** It hides accounts the person switched off, like every queue surface.
 *   Addressing one pull request by its coordinates does not, like the detail route.
 * - **Approval reads like the queue shows it.** Through `approvalOf`: `Unknown` whenever the last
 *   evaluation failed, with the same explanation the queue gives, never the stale last-known flag.
 * - **Posting re-reads the provider.** The comment is pinned to the revision CodeCommit reports at the
 *   moment of posting, through the review client's preflight, never to a cached revision.
 * - **Posting goes through the host's gate.** `post_comment` needs a {@link PullRequestCommentPoster}, not
 *   the review client: a host with its own permission prompt and audit log provides the poster from those,
 *   so Relay's confirmation never replaces them.
 *
 * @module
 */
import { defineContract, implement, type ObjectRef } from "@knpkv/capability"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Crypto from "effect/Crypto"
import { PullRequestRepo } from "../CacheService/index.js"
import type { CachedPullRequest } from "../CacheService/index.js"
import {
  type Approval,
  approvalOf,
  approvalUnknownReasonText,
  ApprovalUnknownTag,
  PullRequestStatus
} from "../Domain.js"
import { CachedPRToPullRequest } from "../PRService/internal.js"
import { enabledProfiles } from "../PRService/visibility.js"
import { CodeCommitReadAccount, CodeCommitReadClient } from "../ReadClient/index.js"
import type { CodeCommitReadError } from "../ReadClient/index.js"
import { CodeCommitReviewClient } from "../ReviewClient/index.js"
import type { CodeCommitReviewAction, CodeCommitReviewError, CodeCommitReviewReceipt } from "../ReviewClient/index.js"

/** The coordinates that name one CodeCommit pull request across every configured account. */
export const PullRequestCoordinates = Schema.Struct({
  accountId: Schema.String.check(Schema.isPattern(/^[0-9]{12}$/u)),
  region: Schema.String.check(Schema.isPattern(/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$/u)),
  repositoryName: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,100}$/u)),
  pullRequestId: Schema.String.check(Schema.isPattern(/^[0-9]{1,200}$/u))
})
export type PullRequestCoordinates = typeof PullRequestCoordinates.Type

/** The Relay object a pull request is, for sessions and citations. Ids hold no `/` but the separators. */
export const pullRequestRef = (coordinates: PullRequestCoordinates): ObjectRef => ({
  product: "codecommit",
  kind: "pull-request",
  id: `${coordinates.accountId}/${coordinates.region}/${coordinates.repositoryName}/${coordinates.pullRequestId}`
})

/** A top-level comment on an exact pull-request revision. */
export type PullRequestCommentAction = Extract<CodeCommitReviewAction, { readonly _tag: "comment" }>

/** Posts one comment. Hosts provide it from their own permission gate and audit log. */
export class PullRequestCommentPoster extends Context.Service<PullRequestCommentPoster, {
  readonly post: (action: PullRequestCommentAction) => Effect.Effect<CodeCommitReviewReceipt, CodeCommitReviewError>
}>()("@knpkv/codecommit-core/RelayCapabilities/PullRequestCommentPoster") {
  /** Post straight through the review client, for hosts without a gate of their own. */
  static readonly fromReviewClient = Layer.effect(
    PullRequestCommentPoster,
    Effect.gen(function*() {
      const client = yield* CodeCommitReviewClient
      return { post: client.execute }
    })
  )
}

/** The cache holds no such pull request in a configured account. */
export class PullRequestNotCached extends Schema.TaggedError<PullRequestNotCached>()("PullRequestNotCached", {
  message: Schema.String,
  fix: Schema.String
}) {}

/** CodeCommit or the local cache could not answer. `message` names which, `fix` the next step. */
export class CodeCommitUnavailable extends Schema.TaggedError<CodeCommitUnavailable>()("CodeCommitUnavailable", {
  message: Schema.String,
  fix: Schema.String
}) {}

const refreshFix = "Refresh the pull-request queue, or check the account is enabled in Settings."

const cacheUnavailable = (): CodeCommitUnavailable =>
  new CodeCommitUnavailable({
    message: "The local pull-request cache could not be read.",
    fix: "Restart codecommit web; if it persists, check ~/.codecommit is readable."
  })

const providerUnavailable = (operation: string) => (error: CodeCommitReadError | CodeCommitReviewError) => {
  switch (error._tag) {
    case "AwsCredentialError":
      return new CodeCommitUnavailable({
        message: `CodeCommit refused the credentials for ${operation}.`,
        fix: `Sign in again: aws sso login --profile ${error.profile}`
      })
    case "AwsThrottleError":
      return new CodeCommitUnavailable({
        message: `CodeCommit throttled ${operation}.`,
        fix: "Try again in a minute."
      })
    case "CodeCommitReadNotFoundError":
      return new CodeCommitUnavailable({
        message: `CodeCommit no longer has this pull request (${operation}).`,
        fix: refreshFix
      })
    default:
      return new CodeCommitUnavailable({
        message: `CodeCommit could not complete ${operation}.`,
        fix: "Try again; if it repeats, open the pull request in the AWS console."
      })
  }
}

const coordinatesOf = (row: CachedPullRequest): PullRequestCoordinates => ({
  accountId: row.awsAccountId,
  region: row.accountRegion,
  repositoryName: row.repositoryName,
  pullRequestId: row.id
})

/** A pull request's approval as the queue shows it; `explanation` is the queue's own sentence. */
export const PullRequestApproval = Schema.TaggedUnion({
  Approved: {},
  /** No approval rules apply: nothing to satisfy. */
  NotRequired: {},
  Pending: {},
  Unknown: { reason: ApprovalUnknownTag, explanation: Schema.String }
})
export type PullRequestApproval = typeof PullRequestApproval.Type

const approvalView = (approval: Approval): PullRequestApproval =>
  approval._tag === "Unknown"
    ? { _tag: "Unknown", reason: approval.reason._tag, explanation: approvalUnknownReasonText(approval.reason) }
    : approval

/** What Relay says about one pull request. */
export const PullRequestSummary = Schema.Struct({
  pullRequest: PullRequestCoordinates,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  author: Schema.String,
  status: PullRequestStatus,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  mergeable: Schema.Boolean,
  approval: PullRequestApproval,
  comments: Schema.NullOr(Schema.Number),
  filesChanged: Schema.NullOr(Schema.Struct({ added: Schema.Number, modified: Schema.Number, deleted: Schema.Number })),
  created: Schema.String,
  lastModified: Schema.String,
  link: Schema.String
})
export type PullRequestSummary = typeof PullRequestSummary.Type

const decodePullRequest = Schema.decodeEffect(CachedPRToPullRequest)

const summaryOf = (row: CachedPullRequest, approval: PullRequestApproval): PullRequestSummary => ({
  pullRequest: coordinatesOf(row),
  title: row.title,
  description: row.description,
  author: row.author,
  status: row.status,
  sourceBranch: row.sourceBranch,
  destinationBranch: row.destinationBranch,
  mergeable: row.isMergeable,
  approval,
  comments: row.commentCount,
  filesChanged: row.filesAdded === null || row.filesModified === null || row.filesDeleted === null
    ? null
    : { added: row.filesAdded, modified: row.filesModified, deleted: row.filesDeleted },
  created: row.creationDate.toISOString(),
  lastModified: row.lastModifiedDate.toISOString(),
  link: row.link
})

// Approval goes through the domain mapper and `approvalOf`, the one read path every surface shares.
const summarize = (row: CachedPullRequest) =>
  decodePullRequest(row).pipe(
    Effect.mapError(cacheUnavailable),
    Effect.map((pullRequest) => summaryOf(row, approvalView(approvalOf(pullRequest))))
  )

const findCached = Effect.fn("RelayCapabilities.findCached")(function*(coordinates: PullRequestCoordinates) {
  const repo = yield* PullRequestRepo
  const row = yield* repo.findByCoordinates(
    coordinates.accountId,
    coordinates.pullRequestId,
    coordinates.repositoryName,
    coordinates.region
  ).pipe(Effect.mapError(cacheUnavailable))
  return yield* Option.match(row, {
    onNone: () =>
      Effect.fail(
        new PullRequestNotCached({
          message:
            `Pull request ${coordinates.pullRequestId} in ${coordinates.repositoryName} is not in the local cache.`,
          fix: refreshFix
        })
      ),
    onSome: Effect.succeed
  })
})

/** Read one pull request. */
export const getPullRequest = defineContract({
  name: "get_pull_request",
  description: "Title, description, author, status, branches, mergeability, approval, comment count and " +
    "changed-file counts of one CodeCommit pull request, from the local cache. Approval is Approved, NotRequired " +
    "(no approval rules apply), Pending, or Unknown with the reason it could not be evaluated.",
  access: "read",
  input: Schema.Struct({ pullRequest: PullRequestCoordinates }),
  output: PullRequestSummary,
  failure: Schema.Union([PullRequestNotCached, CodeCommitUnavailable]),
  cites: (output) => [pullRequestRef(output.pullRequest)]
})

const ListLimit = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 50 }))

/** List pull requests in the queue the person sees. */
export const listPullRequests = defineContract({
  name: "list_pull_requests",
  description: "Pull requests from enabled accounts, newest first, optionally filtered by status, author " +
    "(case-insensitive substring) or repository. At most `limit` (1–50); `total` counts every match.",
  access: "read",
  input: Schema.Struct({
    status: Schema.optionalKey(PullRequestStatus),
    author: Schema.optionalKey(Schema.String),
    repositoryName: Schema.optionalKey(Schema.String),
    limit: ListLimit
  }),
  output: Schema.Struct({ pullRequests: Schema.Array(PullRequestSummary), total: Schema.Number }),
  failure: CodeCommitUnavailable,
  cites: (output) => output.pullRequests.map((summary) => pullRequestRef(summary.pullRequest))
})

/** Post a top-level comment on a pull request, after the person confirms the exact text. */
export const postComment = defineContract({
  name: "post_comment",
  description: "Post a top-level comment on a CodeCommit pull request. The person confirms the exact text first; " +
    "the comment is pinned to the revision CodeCommit reports when it is posted.",
  access: "write",
  reversible: false,
  describe: (input: { readonly pullRequest: PullRequestCoordinates; readonly content: string }) => ({
    verb: "post comment",
    target: pullRequestRef(input.pullRequest),
    args: { content: input.content }
  }),
  input: Schema.Struct({
    pullRequest: PullRequestCoordinates,
    content: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(10_000))
  }),
  output: Schema.Struct({ pullRequest: PullRequestCoordinates, operationId: Schema.String, summary: Schema.String }),
  failure: Schema.Union([PullRequestNotCached, CodeCommitUnavailable]),
  cites: (output) => [pullRequestRef(output.pullRequest)]
})

const textEncoder = new TextEncoder()

const decodeAccount = Schema.decodeUnknownEffect(CodeCommitReadAccount)

// The same text on the same revision is one comment: a retried post reconciles instead of posting twice.
const commentToken = (revisionId: string, content: string) =>
  Effect.gen(function*() {
    const cryptoService = yield* Crypto.Crypto
    const digest = yield* cryptoService.digest(
      "SHA-256",
      textEncoder.encode(`relay-comment\n${revisionId}\n${content}`)
    )
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }).pipe(
    Effect.mapError(() =>
      new CodeCommitUnavailable({ message: "The comment's request token could not be derived.", fix: "Try again." })
    )
  )

/** Every CodeCommit capability, bound to its handler, by contract. */
export const capabilities = {
  getPullRequest: implement(getPullRequest, (input) => Effect.flatMap(findCached(input.pullRequest), summarize)),
  listPullRequests: implement(listPullRequests, (input) =>
    Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const rows = yield* repo.findAll().pipe(Effect.mapError(cacheUnavailable))
      // A queue surface: an unreadable config fails rather than listing accounts the person switched off.
      const enabled = yield* enabledProfiles.pipe(
        Effect.mapError(() =>
          new CodeCommitUnavailable({
            message: "Which accounts are enabled could not be read.",
            fix: "Check ~/.codecommit/config.json is readable, then ask again."
          })
        )
      )
      const author = input.author?.toLowerCase()
      const matches = rows.filter((row) =>
        enabled.has(row.accountProfile) &&
        (input.status === undefined || row.status === input.status) &&
        (author === undefined || row.author.toLowerCase().includes(author)) &&
        (input.repositoryName === undefined || row.repositoryName === input.repositoryName)
      )
      const pullRequests = yield* Effect.forEach(matches.slice(0, input.limit), summarize)
      return { pullRequests, total: matches.length }
    })),
  postComment: implement(postComment, (input) =>
    Effect.gen(function*() {
      const cached = yield* findCached(input.pullRequest)
      const readClient = yield* CodeCommitReadClient
      const poster = yield* PullRequestCommentPoster
      const account = yield* decodeAccount({ profile: cached.accountProfile, region: cached.accountRegion }).pipe(
        Effect.mapError(() =>
          new CodeCommitUnavailable({
            message: `The cached account for this pull request is not a usable AWS profile and region.`,
            fix: refreshFix
          })
        )
      )
      const revision = yield* readClient.getPullRequest({ account, pullRequestId: input.pullRequest.pullRequestId })
        .pipe(Effect.mapError(providerUnavailable("reading the pull request")))
      const receipt = yield* poster.post({
        _tag: "comment",
        target: {
          account,
          repositoryName: revision.repositoryName,
          pullRequestId: revision.pullRequestId,
          revisionId: revision.revisionId,
          sourceCommit: revision.sourceCommit,
          destinationCommit: revision.destinationCommit,
          destinationReference: revision.destinationReference
        },
        content: input.content,
        clientRequestToken: yield* commentToken(revision.revisionId, input.content)
      }).pipe(Effect.mapError(providerUnavailable("posting the comment")))
      return { pullRequest: input.pullRequest, operationId: receipt.operationId, summary: receipt.summary }
    }))
}
