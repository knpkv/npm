/**
 * @internal
 */
import { HttpClient } from "@effect/platform"
import { Credentials, Region } from "distilled-aws"
import * as codecommit from "distilled-aws/codecommit"
import { Data, Effect, Schema, Stream } from "effect"
import { AwsClientConfig } from "../AwsClientConfig.js"
import { Account, AwsProfileName, AwsRegion, codecommitConsoleUrl, PullRequest } from "../Domain.js"
import type { AwsClientError } from "../Errors.js"
import { type AccountParams, acquireCredentials, makeApiError, normalizeAuthor, throttleRetry } from "./internal.js"

// ---------------------------------------------------------------------------
// Sub-helpers
// ---------------------------------------------------------------------------

class MissingPullRequestResponse extends Data.TaggedError("MissingPullRequestResponse")<{
  readonly pullRequestId: string
}> {}

const decodeAccount = Schema.decodeSync(Account)

const EpochFallback = new Date(0)

/**
 * Fetch approval + merge status for a single PR.
 */
const fetchPRDetails = (id: string, repoName: string) =>
  Effect.gen(function*() {
    const resp = yield* codecommit.getPullRequest({ pullRequestId: id })
    const pr = resp.pullRequest
    if (!pr) return yield* new MissingPullRequestResponse({ pullRequestId: id })

    const revisionId = pr.revisionId ?? ""
    const [isApproved, isMergeable, approvers] = yield* Effect.all([
      fetchApprovalStatus(id, revisionId),
      fetchMergeStatus(repoName, pr.pullRequestTargets?.[0]),
      fetchApprovers(id, revisionId)
    ])

    return { ...pr, repoName, isApproved, isMergeable, approvers }
  })

/**
 * Check PR approval status.
 */
const fetchApprovalStatus = (pullRequestId: string, revisionId: string) =>
  throttleRetry(
    codecommit.evaluatePullRequestApprovalRules({ pullRequestId, revisionId })
  ).pipe(
    Effect.map((r) => r.evaluation?.approved ?? false),
    Effect.catchAll(() => Effect.succeed(false))
  )

/**
 * Fetch who approved a PR (ARN list of approvers with APPROVE state).
 */
const fetchApprovers = (pullRequestId: string, revisionId: string) =>
  throttleRetry(
    codecommit.getPullRequestApprovalStates({ pullRequestId, revisionId })
  ).pipe(
    Effect.map((r) =>
      (r.approvals ?? [])
        .filter((a) => a.approvalState === "APPROVE" && a.userArn)
        .map((a) => normalizeAuthor(a.userArn!))
    ),
    Effect.catchAll(() => Effect.succeed([] as Array<string>))
  )

/**
 * Check PR merge status.
 */
const fetchMergeStatus = (
  repoName: string,
  target?: { destinationCommit?: string; sourceCommit?: string }
) => {
  if (!target) return Effect.succeed(true)
  return throttleRetry(
    codecommit.getMergeConflicts({
      repositoryName: repoName,
      destinationCommitSpecifier: target.destinationCommit ?? "",
      sourceCommitSpecifier: target.sourceCommit ?? "",
      mergeOption: "THREE_WAY_MERGE"
    })
  ).pipe(
    Effect.map((r) => r.mergeable ?? false),
    Effect.catchAll(() => Effect.succeed(false))
  )
}

// Bidirectional Schema: raw AWS PR data (enriched) ↔ PullRequest
const RawPullRequest = Schema.Struct({
  pullRequestId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  authorArn: Schema.optional(Schema.String),
  lastActivityDate: Schema.optional(Schema.DateFromSelf),
  creationDate: Schema.optional(Schema.DateFromSelf),
  pullRequestStatus: Schema.optional(Schema.String),
  pullRequestTargets: Schema.optional(Schema.Array(Schema.Struct({
    sourceReference: Schema.optional(Schema.String),
    destinationReference: Schema.optional(Schema.String),
    mergeMetadata: Schema.optional(Schema.Struct({
      isMerged: Schema.optional(Schema.Boolean)
    }))
  }))),
  repoName: Schema.String,
  isApproved: Schema.Boolean,
  isMergeable: Schema.Boolean,
  approvers: Schema.Array(Schema.String),
  accountProfile: AwsProfileName,
  accountRegion: AwsRegion
})

const RawToPullRequest = Schema.transform(
  RawPullRequest,
  PullRequest,
  {
    strict: false,
    decode: (raw) => {
      const target = raw.pullRequestTargets?.[0]
      const sourceBranch = target?.sourceReference?.replace(/^refs\/heads\//, "") ?? "unknown"
      const destinationBranch = target?.destinationReference?.replace(/^refs\/heads\//, "") ?? "unknown"
      const isMerged = target?.mergeMetadata?.isMerged === true
      return {
        id: raw.pullRequestId ?? "",
        title: raw.title ?? "",
        description: raw.description,
        author: raw.authorArn ? normalizeAuthor(raw.authorArn) : "unknown",
        repositoryName: raw.repoName,
        creationDate: raw.creationDate ?? EpochFallback,
        lastModifiedDate: raw.lastActivityDate ?? EpochFallback,
        link: codecommitConsoleUrl(raw.accountRegion, raw.repoName, raw.pullRequestId ?? ""),
        account: decodeAccount({ profile: raw.accountProfile, region: raw.accountRegion }),
        status: isMerged ? "MERGED" as const : raw.pullRequestStatus === "OPEN" ? "OPEN" as const : "CLOSED" as const,
        sourceBranch,
        destinationBranch,
        isMergeable: raw.isMergeable,
        isApproved: raw.isApproved,
        approvedBy: raw.approvers,
        commentedBy: []
      }
    },
    encode: (pr) => ({
      pullRequestId: pr.id,
      title: pr.title,
      description: pr.description,
      authorArn: pr.author,
      lastActivityDate: pr.lastModifiedDate,
      creationDate: pr.creationDate,
      pullRequestStatus: pr.status,
      pullRequestTargets: [{
        sourceReference: pr.sourceBranch,
        destinationReference: pr.destinationBranch
      }],
      repoName: pr.repositoryName,
      isApproved: pr.isApproved,
      isMergeable: pr.isMergeable,
      approvers: pr.approvedBy ?? [],
      accountProfile: pr.account.profile,
      accountRegion: pr.account.region
    })
  }
)

// Effectful decode — ParseError in error channel instead of thrown defect
const decodePullRequest = (raw: unknown) =>
  Schema.decodeUnknown(RawToPullRequest)(raw).pipe(
    Effect.map((result) => result as unknown as PullRequest)
  )

// ---------------------------------------------------------------------------
// Stream builders
// ---------------------------------------------------------------------------

const listAllRepositories = () =>
  codecommit.listRepositories.pages({}).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.repositories ?? [])),
    Stream.map((repo) => repo.repositoryName ?? "")
  )

const listPullRequestIds = (repoName: string, status: "OPEN" | "CLOSED") =>
  codecommit.listPullRequests.pages({ repositoryName: repoName, pullRequestStatus: status }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.pullRequestIds ?? [])),
    Stream.map((id) => ({ id, repoName }))
  )

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const getPullRequests = (
  account: AccountParams,
  options?: { status?: "OPEN" | "CLOSED" }
): Stream.Stream<PullRequest, AwsClientError, AwsClientConfig | HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function*() {
      const config = yield* AwsClientConfig
      const httpClient = yield* HttpClient.HttpClient
      const credentials = yield* acquireCredentials(account.profile, account.region)
      const status = options?.status ?? "OPEN"

      const stream = listAllRepositories().pipe(
        Stream.flatMap((repoName) => listPullRequestIds(repoName, status), { concurrency: 2 }),
        Stream.mapEffect(
          ({ id, repoName }) => throttleRetry(fetchPRDetails(id, repoName)),
          { concurrency: 3 }
        ),
        Stream.mapEffect((pr) =>
          decodePullRequest({ ...pr, accountProfile: account.profile, accountRegion: account.region })
        ),
        Stream.mapError((cause) => makeApiError("getPullRequests", account.profile, account.region, cause))
      )

      return stream.pipe(
        Stream.provideService(HttpClient.HttpClient, httpClient),
        Stream.provideService(Region.Region, account.region),
        Stream.provideService(Credentials.Credentials, credentials),
        Stream.timeout(config.streamTimeout)
      )
    })
  )
