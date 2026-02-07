/**
 * @internal
 */
import { HttpClient } from "@effect/platform"
import { Credentials, Region } from "distilled-aws"
import * as codecommit from "distilled-aws/codecommit"
import { Effect, Layer, Schema } from "effect"
import { AwsClientConfig } from "../AwsClientConfig.js"
import {
  acquireCredentials,
  type GetPullRequestParams,
  makeApiError,
  normalizeAuthor,
  type PullRequestDetail,
  throttleRetry
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
      destinationReference: Schema.optional(Schema.String)
    }))),
    creationDate: Schema.optional(Schema.DateFromSelf)
  }))
})

const PullRequestDetailSchema = Schema.Struct({
  title: Schema.String,
  description: Schema.optional(Schema.String),
  author: Schema.String,
  status: Schema.String,
  repositoryName: Schema.String,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  creationDate: Schema.DateFromSelf
})

const RawToPullRequestDetail = Schema.transform(
  RawGetPullRequestResponse,
  PullRequestDetailSchema,
  {
    decode: (raw) => {
      const pr = raw.pullRequest
      const target = pr?.pullRequestTargets?.[0]
      return {
        title: pr?.title ?? "",
        description: pr?.description,
        author: pr?.authorArn ? normalizeAuthor(pr.authorArn) : "unknown",
        status: pr?.pullRequestStatus ?? "UNKNOWN",
        repositoryName: target?.repositoryName ?? "",
        sourceBranch: target?.sourceReference ?? "",
        destinationBranch: target?.destinationReference ?? "",
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

const decodePullRequestDetail = Schema.decodeSync(RawToPullRequestDetail) as (raw: unknown) => PullRequestDetail

const callGetPullRequest = (params: GetPullRequestParams) =>
  codecommit.getPullRequest({ pullRequestId: params.pullRequestId }).pipe(
    Effect.map(decodePullRequestDetail),
    Effect.mapError((cause) => makeApiError("getPullRequest", params.account.profile, params.account.region, cause))
  )

export const getPullRequest = (params: GetPullRequestParams) =>
  Effect.gen(function*() {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const credentials = yield* acquireCredentials(params.account.profile, params.account.region)

    return yield* Effect.provide(
      callGetPullRequest(params),
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(Region.Region, params.account.region),
        Layer.succeed(Credentials.Credentials, credentials)
      )
    ).pipe(
      throttleRetry,
      Effect.timeout(config.operationTimeout),
      Effect.catchTag(
        "TimeoutException",
        (cause) => Effect.fail(makeApiError("getPullRequest", params.account.profile, params.account.region, cause))
      )
    )
  })
