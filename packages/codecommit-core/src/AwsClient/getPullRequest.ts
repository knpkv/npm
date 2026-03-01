/**
 * @internal
 */
import * as codecommit from "distilled-aws/codecommit"
import { Effect, Schema } from "effect"
import {
  type GetPullRequestParams,
  makeApiError,
  normalizeAuthor,
  PullRequestDetail,
  withAwsContext
} from "./internal.js"

const EpochFallback = new Date(0)

// Bidirectional Schema: raw AWS GetPullRequest response ↔ PullRequestDetail
const RawGetPullRequestResponse = Schema.Struct({
  pullRequest: Schema.optional(Schema.Struct({
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    authorArn: Schema.optional(Schema.String),
    pullRequestStatus: Schema.optional(Schema.String),
    pullRequestTargets: Schema.optional(Schema.Array(Schema.Struct({
      repositoryName: Schema.optional(Schema.String),
      sourceReference: Schema.optional(Schema.String),
      destinationReference: Schema.optional(Schema.String),
      mergeMetadata: Schema.optional(Schema.Struct({
        isMerged: Schema.optional(Schema.Boolean)
      }))
    }))),
    creationDate: Schema.optional(Schema.DateFromSelf)
  }))
})

const RawToPullRequestDetail = Schema.transform(
  RawGetPullRequestResponse,
  PullRequestDetail,
  {
    decode: (raw) => {
      const pr = raw.pullRequest
      const target = pr?.pullRequestTargets?.[0]
      const isMerged = target?.mergeMetadata?.isMerged === true
      return {
        title: pr?.title ?? "",
        description: pr?.description,
        author: pr?.authorArn ? normalizeAuthor(pr.authorArn) : "unknown",
        status: isMerged ? "MERGED" : (pr?.pullRequestStatus ?? "UNKNOWN"),
        repositoryName: target?.repositoryName ?? "",
        sourceBranch: target?.sourceReference?.replace(/^refs\/heads\//, "") ?? "",
        destinationBranch: target?.destinationReference?.replace(/^refs\/heads\//, "") ?? "",
        creationDate: pr?.creationDate ?? EpochFallback
      }
    },
    encode: (detail) => ({
      pullRequest: {
        title: detail.title,
        description: detail.description,
        authorArn: detail.author,
        pullRequestStatus: detail.status,
        pullRequestTargets: [{
          repositoryName: detail.repositoryName,
          sourceReference: detail.sourceBranch,
          destinationReference: detail.destinationBranch
        }],
        creationDate: detail.creationDate
      }
    })
  }
)

// Effectful decode — ParseError in error channel instead of thrown defect
const decodePullRequestDetail = (raw: unknown) => Schema.decodeUnknown(RawToPullRequestDetail)(raw)

const callGetPullRequest = (params: GetPullRequestParams) =>
  codecommit.getPullRequest({ pullRequestId: params.pullRequestId }).pipe(
    Effect.flatMap(decodePullRequestDetail),
    Effect.mapError((cause) => makeApiError("getPullRequest", params.account.profile, params.account.region, cause))
  )

export const getPullRequest = (params: GetPullRequestParams) =>
  withAwsContext("getPullRequest", params.account, callGetPullRequest(params))
