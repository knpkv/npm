/**
 * Fetches a single PR's full detail — metadata, approvers, approval rules,
 * and repo account ID in parallel. Returns a {@link PullRequestDetail}
 * transport object.
 *
 * **Mental model**
 *
 * ```
 * codecommit.getPullRequest ─┬─► decodePullRequestDetail
 *                            ├─► fetchApprovers          → { names, arns }
 *                            ├─► fetchApprovalEvaluation → satisfiedNames
 *                            └─► fetchRepoAccountId      → repo account ID
 * ```
 *
 * - Shared: {@link buildApprovalRules}, {@link fetchApprovalEvaluation},
 *   {@link fetchRepoAccountId} from getPullRequests.ts
 * - Runs inside {@link withAwsContext} (Credentials + Region + AwsClientConfig)
 *
 * **Gotchas**
 *
 * - `PullRequestDetail.approvalRules` uses inline struct, not Schema.Class —
 *   class constructors reject plain objects from `buildApprovalRules`
 *
 * @internal
 */
import * as codecommit from "distilled-aws/codecommit"
import { Effect, Schema } from "effect"
import { buildApprovalRules, fetchApprovalEvaluation, fetchApprovers, fetchRepoAccountId } from "./getPullRequests.js"
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

const callGetPullRequest = (params: GetPullRequestParams) =>
  Effect.gen(function*() {
    const resp = yield* codecommit.getPullRequest({ pullRequestId: params.pullRequestId })
    const revisionId = resp.pullRequest?.revisionId ?? ""
    const repoName = resp.pullRequest?.pullRequestTargets?.[0]?.repositoryName ?? ""
    const [detail, approvers, evaluation, repoAccountId] = yield* Effect.all([
      decodePullRequestDetail(resp),
      fetchApprovers(params.pullRequestId, revisionId),
      fetchApprovalEvaluation(params.pullRequestId, revisionId),
      fetchRepoAccountId(repoName)
    ], { concurrency: 4 })
    const approvalRules = buildApprovalRules(resp.pullRequest?.approvalRules ?? [], evaluation.satisfiedNames)
    return new PullRequestDetail({
      ...detail,
      approvedBy: approvers.names,
      approvedByArns: approvers.arns,
      approvalRules,
      repoAccountId: repoAccountId || undefined
    })
  }).pipe(
    Effect.mapError((cause) => makeApiError("getPullRequest", params.account.profile, params.account.region, cause))
  )

export const getPullRequest = (params: GetPullRequestParams) =>
  withAwsContext("getPullRequest", params.account, callGetPullRequest(params))
