/**
 * @internal
 */
import type { SubscriptionRef } from "effect"
import type { UpsertInput } from "../CacheService/repos/PullRequestRepo.js"
import type { AppState, CommentThread, PRCommentLocation, PullRequest } from "../Domain.js"

export type PRState = SubscriptionRef.SubscriptionRef<AppState>

export const prToUpsertInput = (pr: PullRequest, awsAccountId: string): UpsertInput => ({
  id: pr.id,
  awsAccountId,
  accountProfile: pr.account.profile,
  accountRegion: pr.account.region,
  title: pr.title,
  description: pr.description ?? null,
  author: pr.author,
  repositoryName: pr.repositoryName,
  creationDate: pr.creationDate.toISOString(),
  lastModifiedDate: pr.lastModifiedDate.toISOString(),
  status: pr.status,
  sourceBranch: pr.sourceBranch,
  destinationBranch: pr.destinationBranch,
  isMergeable: pr.isMergeable ? 1 : 0,
  isApproved: pr.isApproved ? 1 : 0,
  commentCount: pr.commentCount ?? null,
  link: pr.link
})

const countThreadComments = (thread: CommentThread): number =>
  1 + thread.replies.reduce((sum, r) => sum + countThreadComments(r), 0)

export const countAllComments = (locations: ReadonlyArray<PRCommentLocation>): number =>
  locations.reduce(
    (sum, loc) => sum + loc.comments.reduce((s, t) => s + countThreadComments(t), 0),
    0
  )
