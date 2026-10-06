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
import type { Credentials, Region } from "@distilled.cloud/aws"
import type {
  ListPullRequestsError,
  ListPullRequestsInput,
  ListPullRequestsOutput
} from "@distilled.cloud/aws/codecommit"
import * as codecommit from "@distilled.cloud/aws/codecommit"
import * as DistilledCredentials from "@distilled.cloud/aws/Credentials"
import * as DistilledRegion from "@distilled.cloud/aws/Region"
import { Data, Effect, Predicate, Schema, SchemaGetter, Stream } from "effect"
import { HttpClient } from "effect/http"
import { AwsClientConfig } from "../AwsClientConfig.js"
import {
  Account,
  ApprovalRule,
  ApprovalUnknownReason,
  codecommitConsoleUrl,
  normalizeAccountId,
  PullRequest,
  type PullRequestStatus
} from "../Domain.js"
import type { AwsClientError } from "../Errors.js"
import { parseRuleContent } from "./approvalRuleContent.js"
import {
  type AccountParams,
  acquireCredentials,
  isThrottlingError,
  makeApiError,
  normalizeAuthor,
  throttleRetry
} from "./internal.js"

type AwsMethodEnv = AwsClientConfig | Credentials.Credentials | Region.Region | HttpClient.HttpClient
type AwsStreamEnv = Credentials.Credentials | Region.Region | HttpClient.HttpClient

const listPullRequestsPages = (
  input: ListPullRequestsInput
): Stream.Stream<ListPullRequestsOutput, ListPullRequestsError, AwsStreamEnv> =>
  codecommit.listPullRequests.pages(input)

// ---------------------------------------------------------------------------
// Sub-helpers
// ---------------------------------------------------------------------------

class MissingPullRequestResponse extends Data.TaggedError("MissingPullRequestResponse")<{
  readonly pullRequestId: string
}> {}

const decodeAccount = Schema.decodeSync(Account)
const decodeApprovalRule = Schema.decodeSync(ApprovalRule)

const EpochFallback = new Date(0)

const emptyApprovers = () => ({
  names: [],
  arns: []
})

const decodeRawStatus = (rawStatus: string | undefined, isMerged: boolean): PullRequestStatus => {
  if (isMerged) return "MERGED"
  return rawStatus === "OPEN" ? "OPEN" : "CLOSED"
}

/**
 * CodeCommit could not say whether a revision's approval rules are satisfied — for example
 * `codecommit:EvaluatePullRequestApprovalRules` is denied. Approval is unknown, not "pending".
 */
export class ApprovalEvaluationError extends Schema.TaggedError<ApprovalEvaluationError>()(
  "ApprovalEvaluationError",
  {
    pullRequestId: Schema.String,
    revisionId: Schema.String,
    cause: Schema.Defect()
  }
) {
  /** Shown to the user as-is (e.g. the web detail view), so it names the operation and the provider's reason. */
  override get message(): string {
    const reason = Predicate.hasProperty(this.cause, "message") && Predicate.isString(this.cause.message)
      ? this.cause.message
      : "no provider message"
    return `EvaluatePullRequestApprovalRules failed for pull request ${this.pullRequestId}: ${reason}`
  }
}

/**
 * Evaluate which approval rules are satisfied/not, returning just the boolean + satisfied rule names.
 * A failed evaluation fails: callers surface it rather than list the pull request as unapproved.
 */
export const fetchApprovalEvaluation = (
  pullRequestId: string,
  revisionId: string
): Effect.Effect<
  { readonly isApproved: boolean; readonly satisfiedNames: Set<string> },
  ApprovalEvaluationError,
  AwsMethodEnv
> =>
  throttleRetry(
    codecommit.evaluatePullRequestApprovalRules({ pullRequestId, revisionId })
  ).pipe(
    Effect.map((r) => ({
      isApproved: r.evaluation?.approved ?? false,
      satisfiedNames: new Set(r.evaluation?.approvalRulesSatisfied ?? [])
    })),
    Effect.mapError((cause) => new ApprovalEvaluationError({ pullRequestId, revisionId, cause }))
  )

/** Provider tags that mean the caller may not evaluate approval rules. */
const notPermittedTags = new Set(["AccessDeniedException", "AccessDenied", "NotAuthorized"])

const tagOf = <Cause>(cause: Cause, key: "_tag" | "errorTag"): string =>
  Predicate.hasProperty(cause, key) && Predicate.isString(cause[key]) ? cause[key] : ""

/** Why an evaluation failed, decided from the provider error's type, never its message text. */
export const approvalUnknownReasonOf = (error: ApprovalEvaluationError): ApprovalUnknownReason =>
  isThrottlingError(error.cause)
    ? ApprovalUnknownReason.cases.Throttled.make({})
    : notPermittedTags.has(tagOf(error.cause, "_tag")) ||
        (tagOf(error.cause, "_tag") === "UnknownAwsError" && notPermittedTags.has(tagOf(error.cause, "errorTag")))
    ? ApprovalUnknownReason.cases.NotPermitted.make({})
    : ApprovalUnknownReason.cases.ProviderFailed.make({})

/**
 * Evaluate a revision's approval rules without failing: a failed evaluation leaves approval unknown,
 * with no satisfied rules, and logs the provider's message.
 */
export const evaluateApproval = (
  pullRequestId: string,
  revisionId: string
): Effect.Effect<
  {
    readonly isApproved: boolean
    readonly satisfiedNames: Set<string>
    readonly approvalUnknown: ApprovalUnknownReason | undefined
  },
  never,
  AwsMethodEnv
> =>
  fetchApprovalEvaluation(pullRequestId, revisionId).pipe(
    Effect.map((evaluation) => ({ ...evaluation, approvalUnknown: undefined })),
    Effect.catchTag("ApprovalEvaluationError", (error) =>
      Effect.logWarning(error.message).pipe(
        Effect.as({
          isApproved: false,
          satisfiedNames: new Set<string>(),
          approvalUnknown: approvalUnknownReasonOf(error)
        })
      ))
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
): Effect.Effect<Array<ApprovalRuleData>> =>
  Effect.forEach(
    rawRules.filter((rule) => rule.approvalRuleName),
    (rule) =>
      parseRuleContent(rule.approvalRuleContent).pipe(
        Effect.map((parsed) => ({
          ruleName: rule.approvalRuleName ?? "",
          satisfied: satisfiedNames.has(rule.approvalRuleName ?? ""),
          ...parsed,
          ...(rule.originApprovalRuleTemplate?.approvalRuleTemplateName !== undefined &&
            { fromTemplate: rule.originApprovalRuleTemplate.approvalRuleTemplateName })
        }))
      )
  )

/**
 * Fetch approval + merge status for a single PR.
 */
const fetchPRDetails = (id: string, repoName: string) =>
  Effect.gen(function*() {
    const resp = yield* codecommit.getPullRequest({ pullRequestId: id })
    const pr = resp.pullRequest
    if (pr === undefined) return yield* new MissingPullRequestResponse({ pullRequestId: id })

    const revisionId = pr.revisionId ?? ""
    const [evaluation, isMergeable, approvers] = yield* Effect.all([
      evaluateApproval(id, revisionId),
      fetchMergeStatus(repoName, pr.pullRequestTargets?.[0]),
      fetchApprovers(id, revisionId)
    ])

    const approvalRules = yield* buildApprovalRules(pr.approvalRules ?? [], evaluation.satisfiedNames)
    return {
      ...pr,
      repoName,
      isApproved: evaluation.isApproved,
      approvalUnknown: evaluation.approvalUnknown,
      isMergeable,
      approvers: approvers.names,
      approverArns: approvers.arns,
      approvalRules
    }
  })

/**
 * Fetch who approved a PR (ARN list of approvers with APPROVE state).
 */
export const fetchApprovers = (
  pullRequestId: string,
  revisionId: string
): Effect.Effect<{ readonly names: Array<string>; readonly arns: Array<string> }, never, AwsMethodEnv> =>
  throttleRetry(
    codecommit.getPullRequestApprovalStates({ pullRequestId, revisionId })
  ).pipe(
    Effect.map((r) => {
      const approved = (r.approvals ?? [])
        .filter((a): a is typeof a & { userArn: string } =>
          a.approvalState === "APPROVE" && a.userArn !== undefined && a.userArn !== ""
        )
      return {
        names: approved.map((a) => normalizeAuthor(a.userArn)),
        arns: approved.map((a) => a.userArn)
      }
    }),
    Effect.catch(() => Effect.succeed(emptyApprovers()))
  )

/**
 * Check PR merge status.
 */
const fetchMergeStatus = (
  repoName: string,
  target?: { destinationCommit?: string; sourceCommit?: string }
) => {
  if (target === undefined) return Effect.succeed(true)
  return throttleRetry(
    codecommit.getMergeConflicts({
      repositoryName: repoName,
      destinationCommitSpecifier: target.destinationCommit ?? "",
      sourceCommitSpecifier: target.sourceCommit ?? "",
      mergeOption: "THREE_WAY_MERGE"
    })
  ).pipe(
    Effect.map((r) => r.mergeable ?? false),
    Effect.catchIf(() => true, () => Effect.succeed(false))
  )
}

// Bidirectional Schema: raw AWS PR data (enriched) ↔ PullRequest
const RawPullRequest = Schema.Struct({
  pullRequestId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  authorArn: Schema.optional(Schema.String),
  lastActivityDate: Schema.optional(Schema.Date),
  creationDate: Schema.optional(Schema.Date),
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
  approvalUnknown: Schema.optional(ApprovalUnknownReason),
  isMergeable: Schema.Boolean,
  approvers: Schema.Array(Schema.String),
  approverArns: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  approvalRules: Schema.Array(ApprovalRule).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  accountProfile: Schema.String,
  accountRegion: Schema.String,
  repoAccountId: Schema.optional(Schema.String)
})

const RawToPullRequest = RawPullRequest.pipe(
  Schema.decodeTo(PullRequest, {
    decode: SchemaGetter.transform((raw) => {
      const target = raw.pullRequestTargets?.[0]
      const sourceBranch = target?.sourceReference?.replace(/^refs\/heads\//, "") ?? "unknown"
      const destinationBranch = target?.destinationReference?.replace(/^refs\/heads\//, "") ?? "unknown"
      const isMerged = target?.mergeMetadata?.isMerged === true
      return {
        id: raw.pullRequestId ?? "",
        title: raw.title ?? "",
        description: raw.description,
        author: raw.authorArn === undefined || raw.authorArn === "" ? "unknown" : normalizeAuthor(raw.authorArn),
        repositoryName: raw.repoName,
        creationDate: raw.creationDate ?? EpochFallback,
        lastModifiedDate: raw.lastActivityDate ?? EpochFallback,
        link: codecommitConsoleUrl(raw.accountRegion, raw.repoName, raw.pullRequestId ?? ""),
        account: decodeAccount({
          profile: raw.accountProfile,
          region: raw.accountRegion,
          repoAccountId: raw.repoAccountId
        }),
        status: decodeRawStatus(raw.pullRequestStatus, isMerged),
        sourceBranch,
        destinationBranch,
        isMergeable: raw.isMergeable,
        isApproved: raw.isApproved,
        ...(raw.approvalUnknown !== undefined && { approvalUnknown: raw.approvalUnknown }),
        approvedBy: raw.approvers,
        approvedByArns: raw.approverArns,
        commentedBy: [],
        approvalRules: raw.approvalRules
      }
    }),
    encode: SchemaGetter.transform((pr) => ({
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
      approvalUnknown: pr.approvalUnknown,
      isMergeable: pr.isMergeable,
      approvers: pr.approvedBy ?? [],
      approverArns: pr.approvedByArns ?? [],
      approvalRules: (pr.approvalRules ?? []).map((rule) => decodeApprovalRule(rule)),
      accountProfile: pr.account.profile,
      accountRegion: pr.account.region,
      repoAccountId: pr.account.repoAccountId
    }))
  })
)

// Effectful decode — ParseError in error channel instead of thrown defect
const decodePullRequest = <UnparsedInput>(raw: UnparsedInput) => Schema.decodeUnknownEffect(RawToPullRequest)(raw)

// ---------------------------------------------------------------------------
// Stream builders
// ---------------------------------------------------------------------------

const listAllRepositories = () =>
  codecommit.listRepositories.pages({}).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.repositories ?? [])),
    Stream.map((repo) => repo.repositoryName ?? "")
  )

export const fetchRepoAccountId = (
  repoName: string
): Effect.Effect<string | undefined, never, AwsStreamEnv> =>
  codecommit.getRepository({ repositoryName: repoName }).pipe(
    Effect.map((r) => normalizeAccountId(r.repositoryMetadata?.accountId)),
    Effect.tapError((e) => Effect.logWarning("fetchRepoAccountId failed", e)),
    Effect.catch(() => Effect.void.pipe(Effect.as(undefined)))
  )

const listPullRequestIds = (
  repoName: string,
  status: "OPEN" | "CLOSED"
): Stream.Stream<{ readonly id: string; readonly repoName: string }, unknown, AwsStreamEnv> =>
  listPullRequestsPages({ repositoryName: repoName, pullRequestStatus: status }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.pullRequestIds ?? [])),
    Stream.map((id) => ({ id, repoName }))
  )

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Stream every pull request of one account. A pull request whose approval rules cannot be evaluated is
 * still listed, with `approvalUnknown` set. Any other failure (listing, reading, decoding) fails the
 * stream with an `AwsApiError`.
 */
export const getPullRequests = (
  account: AccountParams,
  options?: { status?: "OPEN" | "CLOSED"; repositoryName?: string }
): Stream.Stream<PullRequest, AwsClientError, AwsClientConfig | HttpClient.HttpClient> => {
  const pullRequestsEffect: Effect.Effect<
    Stream.Stream<PullRequest, AwsClientError, AwsClientConfig>,
    AwsClientError,
    AwsClientConfig | HttpClient.HttpClient
  > = Effect.gen(function*() {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const credentials = yield* acquireCredentials(account.profile, account.region)
    const status = options?.status ?? "OPEN"

    // Cache repo account IDs (one getRepository call per repo, not per PR)
    const repoAccountCache = new Map<string, string | undefined>()
    const getRepoAccount = (repoName: string) => {
      const cached = repoAccountCache.get(repoName)
      if (repoAccountCache.has(repoName)) return Effect.succeed(cached)
      return fetchRepoAccountId(repoName).pipe(
        Effect.tap((id) => Effect.sync(() => repoAccountCache.set(repoName, id)))
      )
    }

    const repositories = options?.repositoryName === undefined
      ? listAllRepositories()
      : Stream.make(options.repositoryName)

    const stream = repositories.pipe(
      Stream.flatMap((repoName) => listPullRequestIds(repoName, status), { concurrency: 2 }),
      Stream.mapEffect(({ id, repoName }) => throttleRetry(fetchPRDetails(id, repoName)), { concurrency: 3 }),
      // Serial, as before: one GetRepository per repository, cached before the next pull request asks.
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
      Stream.provide(DistilledCredentials.fromCredentials(credentials, account.region)),
      Stream.provideService(HttpClient.HttpClient, httpClient),
      Stream.provideService(DistilledRegion.Region, Effect.succeed(account.region)),
      Stream.timeout(config.streamTimeout)
    )
  })

  return Stream.unwrap(pullRequestsEffect)
}
