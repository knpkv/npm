import type * as Domain from "@knpkv/codecommit-core/Domain.js"

export interface PullRequestRefreshCoordinates {
  readonly repositoryName: string
  readonly region: Domain.AwsRegion
}

export interface PullRequestSandboxIdentity {
  readonly pullRequestId: string
  readonly awsAccountId: string
  readonly repositoryName: string
  readonly region: string
  readonly status: string
}

/** Keep a recovery request distinct when navigation changes only provider coordinates. */
export const pullRequestRefreshKey = (
  accountId: string,
  pullRequestId: string,
  coordinates: PullRequestRefreshCoordinates | undefined
): string => `${accountId}:${pullRequestId}:${coordinates?.repositoryName ?? ""}:${coordinates?.region ?? ""}`

/** Use the same account identity for sandbox creation, reuse, and the post-create watcher. */
export const pullRequestSandboxAccountId = (
  account: Pick<Domain.Account, "awsAccountId" | "profile">
): string => account.awsAccountId ?? account.profile

/** Reuse only a live sandbox whose complete provider identity matches this PR. */
export const matchesPullRequestSandbox = (
  sandbox: PullRequestSandboxIdentity,
  pullRequest: Pick<Domain.PullRequest, "account" | "id" | "repositoryName">
): boolean =>
  sandbox.pullRequestId === String(pullRequest.id) &&
  sandbox.awsAccountId === pullRequestSandboxAccountId(pullRequest.account) &&
  sandbox.repositoryName === String(pullRequest.repositoryName) &&
  sandbox.region === String(pullRequest.account.region) &&
  sandbox.status !== "stopped" &&
  sandbox.status !== "error"
