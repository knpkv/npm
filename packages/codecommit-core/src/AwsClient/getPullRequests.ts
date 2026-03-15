/**
 * Bulk PR fetch — streams all open PRs across repos for one account.
 *
 * Lists all repositories, discovers PR IDs per repo, then fetches full
 * details (approval rules, evaluation state, merge conflicts, approvers,
 * repo account ID) per PR and decodes into {@link PullRequest} domain objects.
 *
 * **Mental model**
 *
 * ```
 * listRepos → listPRIds → fetchPRDetails → getRepoAccount → decodePullRequest
 *                               │                  │
 *                       evaluateApprovalRules   getRepository
 *                       getPullRequest          (cached per repo)
 *                       getApprovalStates
 * ```
 *
 * - Two API responses merged per PR: `getPullRequest.approvalRules` (rule defs)
 *   + `evaluateApprovalRules` (satisfied names). Cross-ref via {@link buildApprovalRules}.
 * - {@link parseRuleContent}: AWS JSON `{Version, Statements[{ApprovalPoolMembers}]}`
 *   → `poolMembers` (normalized) + `poolMemberArns` (raw ARNs).
 * - {@link fetchRepoAccountId}: `getRepository` once per repo (cached). Needed for
 *   cross-account SSO where `getCallerIdentity` ≠ CodeCommit account.
 *
 * **Gotchas**
 *
 * - `evaluateApprovalRules.approvalRulesSatisfied` is `string[]` of rule NAMES, not full objects
 * - `parseRuleContent` falls back silently on malformed JSON (warns if content truthy)
 * - `fetchApprovalEvaluation` uses `throttleRetry` — needs `AwsClientConfig` in context
 *
 * @internal
 */
import { HttpClient } from "@effect/platform"
import { Credentials, Region } from "distilled-aws"
import * as codecommit from "distilled-aws/codecommit"
import { Data, Effect, Schema, Stream } from "effect"
import { AwsClientConfig } from "../AwsClientConfig.js"
import { Account, ApprovalRule, AwsProfileName, AwsRegion, codecommitConsoleUrl, PullRequest } from "../Domain.js"
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
 * Parse AWS approval rule content JSON into pool members + required count.
 * Format: {"Version":"2018-11-08","Statements":[{"Type":"Approvers","NumberOfApprovalsNeeded":N,"ApprovalPoolMembers":["arn:..."]}]}
 */
export const parseRuleContent = (
  content?: string
): { requiredApprovals: number; poolMembers: Array<string>; poolMemberArns: Array<string> } => {
  try {
    const parsed = JSON.parse(content ?? "{}")
    const stmt = parsed.Statements?.[0]
    const rawArns: Array<string> = stmt?.ApprovalPoolMembers ?? []
    return {
      requiredApprovals: stmt?.NumberOfApprovalsNeeded ?? 1,
      poolMembers: rawArns.map(normalizeAuthor),
      poolMemberArns: rawArns
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    if (content) console.warn("Failed to parse approval rule content:", content, e)
    return { requiredApprovals: 1, poolMembers: [], poolMemberArns: [] }
  }
}

/**
 * Evaluate which approval rules are satisfied/not, returning just the boolean + satisfied rule names.
 */
export const fetchApprovalEvaluation = (pullRequestId: string, revisionId: string) =>
  throttleRetry(
    codecommit.evaluatePullRequestApprovalRules({ pullRequestId, revisionId })
  ).pipe(
    Effect.map((r) => ({
      isApproved: r.evaluation?.approved ?? false,
      satisfiedNames: new Set(r.evaluation?.approvalRulesSatisfied ?? [])
    })),
    Effect.tapError((e) => Effect.logWarning("fetchApprovalEvaluation failed", e)),
    Effect.catchAll(() => Effect.succeed({ isApproved: false, satisfiedNames: new Set<string>() }))
  )

/** Plain data shape matching ApprovalRule — avoids Schema.Class branding. */
export interface ApprovalRuleData {
  readonly ruleName: string
  readonly satisfied: boolean
  readonly requiredApprovals: number
  readonly poolMembers: Array<string>
  readonly poolMemberArns: Array<string>
  readonly fromTemplate?: string
}

/**
 * Build ApprovalRule data from getPullRequest's raw rules + evaluation satisfaction state.
 * Filters out rules with empty names (phantom rules from missing AWS data).
 */
export const buildApprovalRules = (
  rawRules: ReadonlyArray<
    {
      approvalRuleName?: string
      approvalRuleContent?: string
      originApprovalRuleTemplate?: { approvalRuleTemplateName?: string }
    }
  >,
  satisfiedNames: Set<string>
): Array<ApprovalRuleData> =>
  rawRules
    .filter((rule) => rule.approvalRuleName)
    .map((rule) => ({
      ruleName: rule.approvalRuleName ?? "",
      satisfied: satisfiedNames.has(rule.approvalRuleName ?? ""),
      ...parseRuleContent(rule.approvalRuleContent),
      ...(rule.originApprovalRuleTemplate?.approvalRuleTemplateName
        ? { fromTemplate: rule.originApprovalRuleTemplate.approvalRuleTemplateName }
        : {})
    }))

/**
 * Fetch approval + merge status for a single PR.
 */
const fetchPRDetails = (id: string, repoName: string) =>
  Effect.gen(function*() {
    const resp = yield* codecommit.getPullRequest({ pullRequestId: id })
    const pr = resp.pullRequest
    if (!pr) return yield* new MissingPullRequestResponse({ pullRequestId: id })

    const revisionId = pr.revisionId ?? ""
    const [evaluation, isMergeable, approvers] = yield* Effect.all([
      fetchApprovalEvaluation(id, revisionId),
      fetchMergeStatus(repoName, pr.pullRequestTargets?.[0]),
      fetchApprovers(id, revisionId)
    ])

    const approvalRules = buildApprovalRules(pr.approvalRules ?? [], evaluation.satisfiedNames)
    return {
      ...pr,
      repoName,
      isApproved: evaluation.isApproved,
      isMergeable,
      approvers: approvers.names,
      approverArns: approvers.arns,
      approvalRules
    }
  })

/**
 * Fetch who approved a PR (ARN list of approvers with APPROVE state).
 */
export const fetchApprovers = (pullRequestId: string, revisionId: string) =>
  throttleRetry(
    codecommit.getPullRequestApprovalStates({ pullRequestId, revisionId })
  ).pipe(
    Effect.map((r) => {
      const approved = (r.approvals ?? [])
        .filter((a): a is typeof a & { userArn: string } => a.approvalState === "APPROVE" && !!a.userArn)
      return {
        names: approved.map((a) => normalizeAuthor(a.userArn)),
        arns: approved.map((a) => a.userArn)
      }
    }),
    Effect.catchAll(() => Effect.succeed({ names: [] as Array<string>, arns: [] as Array<string> }))
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
  approverArns: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  approvalRules: Schema.optionalWith(Schema.Array(ApprovalRule), { default: () => [] }),
  accountProfile: AwsProfileName,
  accountRegion: AwsRegion,
  repoAccountId: Schema.optional(Schema.String)
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
        account: decodeAccount({
          profile: raw.accountProfile,
          region: raw.accountRegion,
          repoAccountId: raw.repoAccountId
        }),
        status: isMerged ? "MERGED" as const : raw.pullRequestStatus === "OPEN" ? "OPEN" as const : "CLOSED" as const,
        sourceBranch,
        destinationBranch,
        isMergeable: raw.isMergeable,
        isApproved: raw.isApproved,
        approvedBy: raw.approvers,
        approvedByArns: raw.approverArns,
        commentedBy: [],
        approvalRules: raw.approvalRules
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
      approverArns: pr.approvedByArns ?? [],
      approvalRules: pr.approvalRules ?? [],
      accountProfile: pr.account.profile,
      accountRegion: pr.account.region,
      repoAccountId: pr.account.repoAccountId
    })
  }
)

// Effectful decode — ParseError in error channel instead of thrown defect
const decodePullRequest = (raw: unknown) => Schema.decodeUnknown(RawToPullRequest)(raw)

// ---------------------------------------------------------------------------
// Stream builders
// ---------------------------------------------------------------------------

const listAllRepositories = () =>
  codecommit.listRepositories.pages({}).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.repositories ?? [])),
    Stream.map((repo) => repo.repositoryName ?? "")
  )

export const fetchRepoAccountId = (repoName: string) =>
  codecommit.getRepository({ repositoryName: repoName }).pipe(
    Effect.map((r) => r.repositoryMetadata?.accountId ?? ""),
    Effect.tapError((e) => Effect.logWarning("fetchRepoAccountId failed", e)),
    Effect.catchAll(() => Effect.succeed(""))
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

      // Cache repo account IDs (one getRepository call per repo, not per PR)
      const repoAccountCache = new Map<string, string>()
      const getRepoAccount = (repoName: string) =>
        repoAccountCache.has(repoName)
          ? Effect.succeed(repoAccountCache.get(repoName)!)
          : fetchRepoAccountId(repoName).pipe(
            Effect.tap((id) => Effect.sync(() => repoAccountCache.set(repoName, id)))
          )

      const stream = listAllRepositories().pipe(
        Stream.flatMap((repoName) => listPullRequestIds(repoName, status), { concurrency: 2 }),
        Stream.mapEffect(
          ({ id, repoName }) => throttleRetry(fetchPRDetails(id, repoName)),
          { concurrency: 3 }
        ),
        Stream.mapEffect((pr) =>
          getRepoAccount(pr.repoName).pipe(
            Effect.flatMap((repoAcct) =>
              decodePullRequest({
                ...pr,
                accountProfile: account.profile,
                accountRegion: account.region,
                repoAccountId: repoAcct
              })
            )
          )
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
