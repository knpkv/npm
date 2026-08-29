/**
 * Choosing which open pull request a checked-out branch belongs to.
 *
 * @category Domain
 * @module
 */
import type { Domain } from "@knpkv/codecommit-core"
import { Schema } from "effect"

export class NoOpenPullRequest extends Schema.TaggedError<NoOpenPullRequest>()(
  "NoOpenPullRequest",
  {
    branch: Schema.String,
    repositoryName: Schema.String,
    message: Schema.String
  }
) {}

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
): Domain.PullRequest | null =>
  pullRequests
    .filter((pr) => pr.repositoryName === target.repositoryName && pr.sourceBranch === target.branch)
    .reduce<Domain.PullRequest | null>(
      (newest, pr) => (newest === null || pr.lastModifiedDate > newest.lastModifiedDate ? pr : newest),
      null
    )
