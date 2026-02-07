/**
 * @internal
 */
import { HttpClient } from "@effect/platform"
import { Credentials, Region } from "distilled-aws"
import * as codecommit from "distilled-aws/codecommit"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { AwsClientConfig } from "../AwsClientConfig.js"
import { type CommentThread, PRComment, type PRCommentLocation } from "../Domain.js"
import {
  acquireCredentials,
  type GetCommentsForPullRequestParams,
  makeApiError,
  normalizeAuthor,
  throttleRetry
} from "./internal.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EpochFallback = new Date(0)

// Bidirectional Schema: raw AWS comment (enriched with location) ↔ PRComment
const RawComment = Schema.Struct({
  commentId: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  authorArn: Schema.optional(Schema.String),
  creationDate: Schema.optional(Schema.DateFromSelf),
  inReplyTo: Schema.optional(Schema.String),
  deleted: Schema.optional(Schema.Boolean),
  filePath: Schema.optional(Schema.String),
  lineNumber: Schema.optional(Schema.Number)
})

const RawToPRComment = Schema.transform(
  RawComment,
  PRComment,
  {
    decode: (raw) => ({
      id: raw.commentId ?? "",
      content: raw.content ?? "",
      author: raw.authorArn ? normalizeAuthor(raw.authorArn) : "unknown",
      creationDate: raw.creationDate ?? EpochFallback,
      inReplyTo: raw.inReplyTo,
      deleted: raw.deleted ?? false,
      filePath: raw.filePath,
      lineNumber: raw.lineNumber
    }),
    encode: (comment) => ({
      commentId: comment.id,
      content: comment.content,
      authorArn: comment.author,
      creationDate: comment.creationDate,
      inReplyTo: comment.inReplyTo,
      deleted: comment.deleted,
      filePath: comment.filePath,
      lineNumber: comment.lineNumber
    })
  }
)

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

const RawToCommentLocation = Schema.transform(
  RawCommentLocation,
  PRCommentLocationSchema,
  {
    decode: (raw) => ({
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
    }),
    encode: (loc) => ({
      location: loc.filePath ? { filePath: loc.filePath } : undefined,
      beforeCommitId: loc.beforeCommitId,
      afterCommitId: loc.afterCommitId,
      comments: []
    })
  }
)

const decodeCommentLocation = Schema.decodeSync(RawToCommentLocation) as (
  raw: Schema.Schema.Encoded<typeof RawCommentLocation>
) => PRCommentLocation

const fetchCommentPages = (pullRequestId: string, repositoryName: string) =>
  Stream.paginateEffect(
    undefined as string | undefined,
    (nextToken) =>
      codecommit.getCommentsForPullRequest({
        pullRequestId,
        repositoryName,
        ...(nextToken && { nextToken })
      }).pipe(
        Effect.map((resp) =>
          [
            (resp.commentsForPullRequestData ?? []).map(decodeCommentLocation),
            resp.nextToken ? Option.some(resp.nextToken) : Option.none()
          ] as const
        )
      )
  ).pipe(
    Stream.flatMap(Stream.fromIterable)
  )

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const getCommentsForPullRequest = (
  params: GetCommentsForPullRequestParams
) =>
  Effect.gen(function*() {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const credentials = yield* acquireCredentials(params.account.profile, params.account.region)

    return yield* Effect.provide(
      fetchCommentPages(params.pullRequestId, params.repositoryName).pipe(
        Stream.mapError((cause) =>
          makeApiError("getCommentsForPullRequest", params.account.profile, params.account.region, cause)
        ),
        Stream.runCollect
      ),
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(Region.Region, params.account.region),
        Layer.succeed(Credentials.Credentials, credentials)
      )
    ).pipe(
      throttleRetry,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.timeout(config.streamTimeout),
      Effect.catchTag("TimeoutException", (cause) =>
        Effect.fail(
          makeApiError("getCommentsForPullRequest", params.account.profile, params.account.region, cause)
        ))
    )
  })
