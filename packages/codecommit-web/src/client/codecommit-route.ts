import type * as Domain from "@knpkv/codecommit-core/Domain.js"

export interface CodeCommitPullRequestRouteCoordinates {
  readonly accountId?: string
  readonly pullRequestId: string
  readonly region?: string
  readonly repositoryName?: string
}

/** Build a browser route that retains the provider coordinates selected by Relay. */
export const codeCommitPullRequestHref = (
  accountId: string,
  pullRequestId: string,
  repositoryName: string,
  region: string
): string =>
  `/accounts/${encodeURIComponent(accountId)}/prs/${encodeURIComponent(pullRequestId)}?repository=${
    encodeURIComponent(repositoryName)
  }&region=${encodeURIComponent(region)}`

/** Match a cached CodeCommit PR without collapsing repository or region identity. */
export const matchesCodeCommitPullRequestRoute = (
  pullRequest: Pick<Domain.PullRequest, "account" | "id" | "repositoryName">,
  route: CodeCommitPullRequestRouteCoordinates
): boolean =>
  String(pullRequest.id) === route.pullRequestId &&
  (route.accountId === undefined ||
    pullRequest.account.awsAccountId === route.accountId ||
    pullRequest.account.profile === route.accountId) &&
  (route.repositoryName === undefined || String(pullRequest.repositoryName) === route.repositoryName) &&
  (route.region === undefined || String(pullRequest.account.region) === route.region)
