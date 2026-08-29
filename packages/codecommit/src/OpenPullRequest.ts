/**
 * Choosing which open pull request a checked-out branch belongs to.
 *
 * @category Domain
 * @module
 */
import type { Domain } from "@knpkv/codecommit-core"
import { Data, Effect, Schema } from "effect"

export class NoOpenPullRequest extends Schema.TaggedError<NoOpenPullRequest>()(
  "NoOpenPullRequest",
  {
    branch: Schema.String,
    repositoryName: Schema.String,
    message: Schema.String
  }
) {}

export class AmbiguousOpenPullRequest extends Schema.TaggedError<AmbiguousOpenPullRequest>()(
  "AmbiguousOpenPullRequest",
  {
    branch: Schema.String,
    repositoryName: Schema.String,
    targets: Schema.Array(Schema.String),
    message: Schema.String
  }
) {}

export class IncompleteOpenPullRequestScan extends Schema.TaggedError<IncompleteOpenPullRequestScan>()(
  "IncompleteOpenPullRequestScan",
  {
    branch: Schema.String,
    repositoryName: Schema.String,
    failureCount: Schema.Number,
    targetCount: Schema.Number,
    message: Schema.String
  }
) {}

export type OpenPullRequestMatch = Data.TaggedEnum<{
  readonly None: {}
  readonly Ambiguous: { readonly targets: ReadonlyArray<string> }
  readonly Matched: { readonly pullRequest: Domain.PullRequest }
}>
export const OpenPullRequestMatch = Data.taggedEnum<OpenPullRequestMatch>()

const noMatch = OpenPullRequestMatch.None()
const accountIdentity = (pr: Domain.PullRequest): string =>
  `${pr.account.repoAccountId ?? pr.account.awsAccountId ?? `profile:${pr.account.profile}`}/${pr.account.region}`
const accountTarget = (pr: Domain.PullRequest): string => `${pr.account.profile}/${pr.account.region}`

/**
 * Picks the pull request a branch belongs to, newest first.
 *
 * Author-agnostic on purpose: the space may hold someone else's branch checked
 * out for review, and that PR is exactly the one worth opening. More than one
 * open PR can share a source branch (different destinations), so the most
 * recently touched one wins rather than an arbitrary one.
 */
export const matchOpenPullRequest = (
  pullRequests: ReadonlyArray<Domain.PullRequest>,
  target: { readonly branch: string; readonly repositoryName: string }
): OpenPullRequestMatch => {
  const candidates = pullRequests.filter(
    (pr) => pr.repositoryName === target.repositoryName && pr.sourceBranch === target.branch
  )
  if (candidates.length === 0) return noMatch

  const identities = new Set(candidates.map(accountIdentity))
  if (identities.size > 1) {
    return OpenPullRequestMatch.Ambiguous({
      targets: [...new Set(candidates.map(accountTarget))].sort()
    })
  }

  const pullRequest = candidates.reduce((newest, pr) => pr.lastModifiedDate > newest.lastModifiedDate ? pr : newest)
  return OpenPullRequestMatch.Matched({ pullRequest })
}

/** Resolves a complete scan, refusing both missing coverage and ambiguity. */
export const resolveOpenPullRequest = Effect.fn("OpenPullRequest.resolve")(function*(input: {
  readonly failures: ReadonlyArray<string>
  readonly pullRequests: ReadonlyArray<Domain.PullRequest>
  readonly target: { readonly branch: string; readonly repositoryName: string }
  readonly targetCount: number
}) {
  if (input.failures.length > 0) {
    return yield* new IncompleteOpenPullRequestScan({
      branch: input.target.branch,
      repositoryName: input.target.repositoryName,
      failureCount: input.failures.length,
      targetCount: input.targetCount,
      message:
        `Could not determine whether ${input.target.repositoryName} branch '${input.target.branch}' has an open PR: ` +
        `${input.failures.length} of ${input.targetCount} account(s) could not be searched.`
    })
  }

  const match = matchOpenPullRequest(input.pullRequests, input.target)
  return yield* OpenPullRequestMatch.$match(match, {
    None: () =>
      new NoOpenPullRequest({
        branch: input.target.branch,
        repositoryName: input.target.repositoryName,
        message: `No open PR for ${input.target.repositoryName} branch '${input.target.branch}'`
      }),
    Ambiguous: ({ targets }) =>
      new AmbiguousOpenPullRequest({
        branch: input.target.branch,
        repositoryName: input.target.repositoryName,
        targets: [...targets],
        message:
          `More than one account has an open PR for ${input.target.repositoryName} branch '${input.target.branch}': ` +
          `${targets.join(", ")}. Use a codecommit:// remote that names the intended profile.`
      }),
    Matched: ({ pullRequest }) => Effect.succeed(pullRequest)
  })
})
