import type { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { codeCommitPullRequestHref } from "../codecommit-route.js"

export const prListHref = (pr: Pick<PullRequest, "account" | "id" | "repositoryName">): string =>
  codeCommitPullRequestHref(pr.account.profile, String(pr.id), String(pr.repositoryName), String(pr.account.region))

export const prListKey = (pr: Pick<PullRequest, "account" | "id" | "repositoryName">): string =>
  `${pr.account.awsAccountId ?? pr.account.profile}:${String(pr.id)}:${String(pr.repositoryName)}:${
    String(pr.account.region)
  }`
