/**
 * PRService internal transforms and helpers.
 *
 * Provides bidirectional Schema transforms between cache rows, domain objects,
 * and SQL upsert inputs: {@link CachedPRToPullRequest} (cache row → PullRequest,
 * including repoAccountId on Account), {@link PullRequestToUpsertInput}
 * (PullRequest → UpsertInput), and {@link prToUpsertInput} (convenience
 * wrapper that ensures approvalRules is always present). Also provides
 * {@link countAllComments} for flattening comment thread trees.
 *
 * @internal
 */
import type { SubscriptionRef } from "effect"
import { Schema, SchemaGetter } from "effect"
import { CachedPullRequest, UpsertInput } from "../CacheService/repos/PullRequestRepo/index.js"
import {
  ApprovalRule,
  type AppState,
  AwsProfileName,
  AwsRegion,
  type CommentThread,
  type PRCommentLocation,
  PullRequest,
  PullRequestId,
  RepositoryName
} from "../Domain.js"

export type PRState = SubscriptionRef.SubscriptionRef<AppState>

const sumFileChanges = (...counts: Array<number | null>): number | undefined => {
  const defined = counts.filter((n): n is number => n != null)
  return defined.length > 0 ? defined.reduce((a, b) => a + b, 0) : undefined
}

const decodeApprovalRule = Schema.decodeSync(ApprovalRule)
const decodeAwsProfileName = Schema.decodeSync(AwsProfileName)
const decodeAwsRegion = Schema.decodeSync(AwsRegion)
const decodePullRequestId = Schema.decodeSync(PullRequestId)
const decodeRepositoryName = Schema.decodeSync(RepositoryName)

export const CachedPRToPullRequest = Schema.toType(CachedPullRequest).pipe(
  Schema.decodeTo(PullRequest, {
    decode: SchemaGetter.transform((row) => ({
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
        awsAccountId: row.awsAccountId,
        repoAccountId: row.repoAccountId ?? undefined
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
      approvedByArns: row.approvedByArns,
      commentedBy: row.commentedBy,
      approvalRules: row.approvalRules,
      filesChanged: sumFileChanges(row.filesAdded, row.filesModified, row.filesDeleted)
    })),
    encode: SchemaGetter.transform((pr) => ({
      id: decodePullRequestId(pr.id),
      awsAccountId: pr.account.awsAccountId ?? "",
      repoAccountId: pr.account.repoAccountId ?? null,
      accountProfile: decodeAwsProfileName(pr.account.profile),
      accountRegion: decodeAwsRegion(pr.account.region),
      title: pr.title,
      description: pr.description ?? null,
      author: pr.author,
      repositoryName: decodeRepositoryName(pr.repositoryName),
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
      approvedByArns: pr.approvedByArns ?? [],
      commentedBy: pr.commentedBy,
      approvalRules: (pr.approvalRules ?? []).map((rule) => decodeApprovalRule(rule))
    }))
  })
)

export const decodeCachedPR = Schema.decodeSync(CachedPRToPullRequest)

export const PullRequestToUpsertInput = UpsertInput.pipe(
  Schema.decodeTo(PullRequest, {
    decode: SchemaGetter.transform((row) => ({
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
        awsAccountId: row.awsAccountId,
        repoAccountId: row.repoAccountId ?? undefined
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
      approvedByArns: row.approvedByArns,
      approvalRules: row.approvalRules ?? [],
      commentedBy: [],
      filesChanged: undefined
    })),
    encode: SchemaGetter.transform((pr) => ({
      id: pr.id,
      awsAccountId: pr.account.awsAccountId ?? "",
      repoAccountId: pr.account.repoAccountId ?? null,
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
      approvedBy: pr.approvedBy,
      approvedByArns: pr.approvedByArns ?? [],
      approvalRules: (pr.approvalRules ?? []).map((rule) => decodeApprovalRule(rule))
    }))
  })
)

const encodePRToUpsert = Schema.encodeSync(PullRequestToUpsertInput)

export const prToUpsertInput = (pr: PullRequest, awsAccountId: string): UpsertInput => ({
  ...encodePRToUpsert(pr),
  awsAccountId,
  // Explicit: encodePRToUpsert's Encoded type can omit approvalRules when decoding defaults are used,
  // but UpsertInput.Type requires it. Guarantee it's always present.
  approvalRules: pr.approvalRules
})

const countThreadComments = (thread: CommentThread): number =>
  1 + thread.replies.reduce((sum, r) => sum + countThreadComments(r), 0)

export const countAllComments = (locations: ReadonlyArray<PRCommentLocation>): number =>
  locations.reduce(
    (sum, loc) => sum + loc.comments.reduce((s, t) => s + countThreadComments(t), 0),
    0
  )
