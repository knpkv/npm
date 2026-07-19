/**
 * @internal
 */
import type { Credentials, Region } from "@distilled.cloud/aws"
import type { GetCommentsForPullRequestError } from "@distilled.cloud/aws/codecommit"
import * as codecommit from "@distilled.cloud/aws/codecommit"
import { Effect, Option, Schema, SchemaGetter, Stream } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { type CommentThread, PRComment, type PRCommentLocation } from "../Domain.js"
import { type GetCommentsForPullRequestParams, makeApiError, normalizeAuthor, withAwsContext } from "./internal.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EpochFallback = new Date(0)
type CommentPageError = GetCommentsForPullRequestError | Schema.SchemaError
type CommentPageEnv = Credentials.Credentials | Region.Region | HttpClient.HttpClient

// Bidirectional Schema: raw AWS comment (enriched with location) ↔ PRComment
const RawComment = Schema.Struct({
  commentId: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  authorArn: Schema.optional(Schema.String),
  creationDate: Schema.optional(Schema.Date),
  inReplyTo: Schema.optional(Schema.String),
  deleted: Schema.optional(Schema.Boolean),
  filePath: Schema.optional(Schema.String),
  lineNumber: Schema.optional(Schema.Number)
})

const RawToPRComment = RawComment.pipe(
  Schema.decodeTo(PRComment, {
    decode: SchemaGetter.transform((raw) => ({
      id: raw.commentId ?? "",
      content: raw.content ?? "",
      author: raw.authorArn ? normalizeAuthor(raw.authorArn) : "unknown",
      creationDate: raw.creationDate ?? EpochFallback,
      inReplyTo: raw.inReplyTo,
      deleted: raw.deleted ?? false,
      filePath: raw.filePath,
      lineNumber: raw.lineNumber
    })),
    encode: SchemaGetter.transform((comment) => ({
      commentId: comment.id,
      content: comment.content,
      authorArn: comment.author,
      creationDate: comment.creationDate,
      inReplyTo: comment.inReplyTo,
      deleted: comment.deleted,
      filePath: comment.filePath,
      lineNumber: comment.lineNumber
    }))
  })
)

// Sync decode — used inside Schema.decodeTo (sync context)
const decodeComment = Schema.decodeSync(RawToPRComment)

const buildThreads = (comments: ReadonlyArray<PRComment>): Array<CommentThread> => {
  const rootComments = comments.filter((c) => !c.inReplyTo)
  const repliesTo = (id: string): Array<CommentThread> =>
    comments
      .filter((c) => c.inReplyTo === id)
      .sort((a, b) => a.creationDate.getTime() - b.creationDate.getTime())
      .map((c) => ({ root: c, replies: repliesTo(c.id) }))

  return rootComments
    .sort((a, b) => a.creationDate.getTime() - b.creationDate.getTime())
    .map((c) => ({ root: c, replies: repliesTo(c.id) }))
}

// Bidirectional Schema: raw AWS comment location ↔ PRCommentLocation
const RawCommentLocation = Schema.Struct({
  location: Schema.optional(Schema.Struct({
    filePath: Schema.optional(Schema.String),
    filePosition: Schema.optional(Schema.Number)
  })),
  beforeCommitId: Schema.optional(Schema.String),
  afterCommitId: Schema.optional(Schema.String),
  comments: Schema.optional(Schema.Array(RawComment))
})

const PRCommentLocationSchema = Schema.Struct({
  filePath: Schema.optional(Schema.String),
  beforeCommitId: Schema.optional(Schema.String),
  afterCommitId: Schema.optional(Schema.String),
  comments: Schema.Array(Schema.Any)
})

const RawToCommentLocation = RawCommentLocation.pipe(
  Schema.decodeTo(PRCommentLocationSchema, {
    decode: SchemaGetter.transform((raw) => ({
      filePath: raw.location?.filePath,
      beforeCommitId: raw.beforeCommitId,
      afterCommitId: raw.afterCommitId,
      comments: buildThreads((raw.comments ?? []).map((c) =>
        decodeComment({
          ...c,
          filePath: raw.location?.filePath,
          lineNumber: raw.location?.filePosition
        })
      ))
    })),
    encode: SchemaGetter.transform((loc) => ({
      location: loc.filePath ? { filePath: loc.filePath } : undefined,
      beforeCommitId: loc.beforeCommitId,
      afterCommitId: loc.afterCommitId,
      comments: []
    }))
  })
)

// Effectful decode — ParseError in error channel instead of thrown defect
const decodeCommentLocation = (raw: unknown) =>
  Schema.decodeUnknownEffect(RawToCommentLocation)(raw).pipe(Effect.map((result): PRCommentLocation => ({
    ...(result.filePath === undefined ? {} : { filePath: result.filePath }),
    ...(result.beforeCommitId === undefined ? {} : { beforeCommitId: result.beforeCommitId }),
    ...(result.afterCommitId === undefined ? {} : { afterCommitId: result.afterCommitId }),
    comments: result.comments
  })))

const firstPageToken: string | undefined = undefined

const nextPageToken = (token: string | undefined): Option.Option<string | undefined> =>
  token === undefined ? Option.none() : Option.some(token)

const commentPage = (
  locations: ReadonlyArray<PRCommentLocation>,
  nextToken: Option.Option<string | undefined>
): readonly [ReadonlyArray<PRCommentLocation>, Option.Option<string | undefined>] => [locations, nextToken]

const commentPageRequest = (pullRequestId: string, nextToken: string | undefined) =>
  nextToken === undefined ? { pullRequestId } : { pullRequestId, nextToken }

// NOTE: repositoryName is intentionally omitted — passing it without
// beforeCommitId/afterCommitId triggers CommitIdRequiredException.
const fetchCommentPages = (pullRequestId: string) =>
  Stream.paginate<string | undefined, PRCommentLocation, CommentPageError, CommentPageEnv>(
    firstPageToken,
    (nextToken) =>
      codecommit.getCommentsForPullRequest(commentPageRequest(pullRequestId, nextToken)).pipe(
        Effect.flatMap((resp) =>
          Effect.forEach(resp.commentsForPullRequestData ?? [], decodeCommentLocation).pipe(
            Effect.map((locations) =>
              commentPage(
                locations,
                nextPageToken(resp.nextToken)
              )
            )
          )
        )
      )
  )

const runCommentPages = (pullRequestId: string) =>
  fetchCommentPages(pullRequestId).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk))
  )

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const getCommentsForPullRequest = (
  params: GetCommentsForPullRequestParams
) =>
  withAwsContext(
    "getCommentsForPullRequest",
    params.account,
    runCommentPages(params.pullRequestId).pipe(
      Effect.mapError((cause) =>
        makeApiError("getCommentsForPullRequest", params.account.profile, params.account.region, cause)
      )
    ),
    { timeout: "stream" }
  )
