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

const matchesRouteAccount = (pullRequest: Pick<Domain.PullRequest, "account">, accountId: string): boolean =>
  pullRequest.account.awsAccountId === accountId || pullRequest.account.profile === accountId

const matchesLocatorAccount = (pullRequest: Pick<Domain.PullRequest, "account">, accountId: string): boolean =>
  matchesRouteAccount(pullRequest, accountId) || pullRequest.account.repoAccountId === accountId

/** Match a browser route using its credential-account or profile alias. */
export const matchesCodeCommitPullRequestRoute = (
  pullRequest: Pick<Domain.PullRequest, "account" | "id" | "repositoryName">,
  route: CodeCommitPullRequestRouteCoordinates
): boolean =>
  String(pullRequest.id) === route.pullRequestId &&
  (route.accountId === undefined || matchesRouteAccount(pullRequest, route.accountId)) &&
  (route.repositoryName === undefined || String(pullRequest.repositoryName) === route.repositoryName) &&
  (route.region === undefined || String(pullRequest.account.region) === route.region)

/** Match a host locator, which may name the repository's owning account. */
export const matchesCodeCommitPullRequestLocator = (
  pullRequest: Pick<Domain.PullRequest, "account" | "id" | "repositoryName">,
  route: CodeCommitPullRequestRouteCoordinates
): boolean =>
  String(pullRequest.id) === route.pullRequestId &&
  (route.accountId === undefined || matchesLocatorAccount(pullRequest, route.accountId)) &&
  (route.repositoryName === undefined || String(pullRequest.repositoryName) === route.repositoryName) &&
  (route.region === undefined || String(pullRequest.account.region) === route.region)
