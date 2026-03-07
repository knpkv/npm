/**
 * @internal
 */
import type { SubscriptionRef } from "effect"
import { Schema } from "effect"
import { CachedPullRequest, UpsertInput } from "../CacheService/repos/PullRequestRepo/index.js"
import { type AppState, type CommentThread, type PRCommentLocation, PullRequest } from "../Domain.js"

export type PRState = SubscriptionRef.SubscriptionRef<AppState>

const sumFileChanges = (...counts: Array<number | null>): number | undefined => {
  const defined = counts.filter((n): n is number => n != null)
  return defined.length > 0 ? defined.reduce((a, b) => a + b, 0) : undefined
}

export const CachedPRToPullRequest = Schema.transform(
  Schema.typeSchema(CachedPullRequest),
  PullRequest,
  {
    strict: true,
    decode: (row) => ({
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      author: row.author,
      repositoryName: row.repositoryName,
      creationDate: row.creationDate,
      lastModifiedDate: row.lastModifiedDate,
      link: row.link,
      account: {
        profile: row.accountProfile,
        region: row.accountRegion,
        awsAccountId: row.awsAccountId
      },
      status: row.status,
      sourceBranch: row.sourceBranch,
      destinationBranch: row.destinationBranch,
      isMergeable: row.isMergeable,
      isApproved: row.isApproved,
      commentCount: row.commentCount ?? undefined,
      healthScore: row.healthScore ?? undefined,
      fetchedAt: row.fetchedAt ? new Date(row.fetchedAt) : undefined,
      approvedBy: row.approvedBy,
      commentedBy: row.commentedBy,
      filesChanged: sumFileChanges(row.filesAdded, row.filesModified, row.filesDeleted)
    }),
    encode: (_encoded, pr) => ({
      id: pr.id,
      awsAccountId: pr.account.awsAccountId ?? "",
      accountProfile: pr.account.profile,
      accountRegion: pr.account.region,
      title: pr.title,
      description: pr.description ?? null,
      author: pr.author,
      repositoryName: pr.repositoryName,
      creationDate: pr.creationDate,
      lastModifiedDate: pr.lastModifiedDate,
      status: pr.status,
      sourceBranch: pr.sourceBranch,
      destinationBranch: pr.destinationBranch,
      isMergeable: pr.isMergeable,
      isApproved: pr.isApproved,
      commentCount: pr.commentCount ?? null,
      healthScore: pr.healthScore ?? null,
      link: pr.link,
      fetchedAt: pr.fetchedAt?.toISOString() ?? "",
      filesAdded: null,
      filesModified: null,
      filesDeleted: null,
      closedAt: null,
      mergedBy: null,
      approvedBy: pr.approvedBy,
      commentedBy: pr.commentedBy
    })
  }
)

export const decodeCachedPR = Schema.decodeSync(CachedPRToPullRequest)

export const PullRequestToUpsertInput = Schema.transform(
  UpsertInput,
  PullRequest,
  {
    strict: false,
    decode: (row) => ({
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      author: row.author,
      repositoryName: row.repositoryName,
      creationDate: new Date(row.creationDate),
      lastModifiedDate: new Date(row.lastModifiedDate),
      link: row.link,
      account: {
        profile: row.accountProfile,
        region: row.accountRegion,
        awsAccountId: row.awsAccountId
      },
      status: row.status,
      sourceBranch: row.sourceBranch,
      destinationBranch: row.destinationBranch,
      isMergeable: row.isMergeable === 1,
      isApproved: row.isApproved === 1,
      commentCount: row.commentCount ?? undefined,
      healthScore: undefined,
      fetchedAt: undefined,
      approvedBy: row.approvedBy,
      commentedBy: [],
      filesChanged: undefined
    }),
    encode: (_encoded, pr) => ({
      id: pr.id,
      awsAccountId: pr.account.awsAccountId ?? "",
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
      link: pr.link,
      approvedBy: pr.approvedBy
    })
  }
)

const encodePRToUpsert = Schema.encodeSync(PullRequestToUpsertInput)

export const prToUpsertInput = (pr: PullRequest, awsAccountId: string): UpsertInput => ({
  ...encodePRToUpsert(pr),
  awsAccountId
})

const countThreadComments = (thread: CommentThread): number =>
  1 + thread.replies.reduce((sum, r) => sum + countThreadComments(r), 0)

export const countAllComments = (locations: ReadonlyArray<PRCommentLocation>): number =>
  locations.reduce(
    (sum, loc) => sum + loc.comments.reduce((s, t) => s + countThreadComments(t), 0),
    0
  )
