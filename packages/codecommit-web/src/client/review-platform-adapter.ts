/** Thin CodeCommit mapping into browser-safe provider-neutral review contracts. @module */
import type { ReviewProfileConfig } from "@knpkv/codecommit-core/ReviewProfile.js"
import { type ReviewExecutionProfile, type ReviewThreadIdentity, reviewThreadKey } from "@knpkv/review"

import type { PullRequestDiffResponse } from "../server/Api.js"

/** Keep AWS profiles, provider locators, and credentials outside the shared browser contract. */
export const codeCommitReviewProfile = (profile: ReviewProfileConfig): ReviewExecutionProfile => ({
  id: profile.id,
  name: profile.name,
  kind: profile.kind,
  provider: profile.provider,
  harness: profile.harness,
  model: profile.model,
  skillIds: profile.skillIds
})

export const codeCommitReviewThread = (
  accountId: string,
  pullRequestId: string,
  diff: Pick<PullRequestDiffResponse, "baseCommit" | "headCommit" | "revisionId">
): ReviewThreadIdentity => ({
  namespace: "codecommit",
  subjectId: `${accountId}/${pullRequestId}`,
  revisionId: diff.revisionId,
  baseRevision: diff.baseCommit,
  headRevision: diff.headCommit
})

export const codeCommitReviewIdentity = (
  accountId: string,
  pullRequestId: string,
  diff: Pick<PullRequestDiffResponse, "baseCommit" | "headCommit" | "revisionId">
): string => reviewThreadKey(codeCommitReviewThread(accountId, pullRequestId, diff))
