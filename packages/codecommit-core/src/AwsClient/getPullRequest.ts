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
        isMerged: Schema.optional(Schema.Boolean),
        mergedBy: Schema.optional(Schema.String)
      }))
    }))),
    creationDate: Schema.optional(Schema.DateFromSelf),
    lastActivityDate: Schema.optional(Schema.DateFromSelf)
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
      const mergedByArn = target?.mergeMetadata?.mergedBy
      return {
        title: pr?.title ?? "",
        description: pr?.description,
        author: pr?.authorArn ? normalizeAuthor(pr.authorArn) : "unknown",
        status: isMerged ? "MERGED" : (pr?.pullRequestStatus ?? "UNKNOWN"),
        repositoryName: target?.repositoryName ?? "",
        sourceBranch: target?.sourceReference?.replace(/^refs\/heads\//, "") ?? "",
        destinationBranch: target?.destinationReference?.replace(/^refs\/heads\//, "") ?? "",
        creationDate: pr?.creationDate ?? EpochFallback,
        lastActivityDate: pr?.lastActivityDate ?? pr?.creationDate ?? EpochFallback,
        approvedBy: [],
        mergedBy: mergedByArn ? normalizeAuthor(mergedByArn) : undefined
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
        creationDate: detail.creationDate,
        lastActivityDate: detail.lastActivityDate
      }
    })
  }
)

// Effectful decode — ParseError in error channel instead of thrown defect
const decodePullRequestDetail = (raw: unknown) => Schema.decodeUnknown(RawToPullRequestDetail)(raw)

const fetchApprovers = (pullRequestId: string, revisionId: string) =>
  codecommit.getPullRequestApprovalStates({ pullRequestId, revisionId }).pipe(
    Effect.map((r) =>
      (r.approvals ?? [])
        .filter((a) => a.approvalState === "APPROVE" && a.userArn)
        .map((a) => normalizeAuthor(a.userArn!))
    ),
    Effect.catchAll(() => Effect.succeed([] as Array<string>))
  )

const callGetPullRequest = (params: GetPullRequestParams) =>
  Effect.gen(function*() {
    const resp = yield* codecommit.getPullRequest({ pullRequestId: params.pullRequestId })
    const revisionId = resp.pullRequest?.revisionId ?? ""
    const [detail, approvers] = yield* Effect.all([
      decodePullRequestDetail(resp),
      fetchApprovers(params.pullRequestId, revisionId)
    ], { concurrency: 2 })
    return new PullRequestDetail({
      ...detail,
      approvedBy: approvers
    })
  }).pipe(
    Effect.mapError((cause) => makeApiError("getPullRequest", params.account.profile, params.account.region, cause))
  )

export const getPullRequest = (params: GetPullRequestParams) =>
  withAwsContext("getPullRequest", params.account, callGetPullRequest(params))
