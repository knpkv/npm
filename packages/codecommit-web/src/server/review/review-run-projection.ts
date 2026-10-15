/** Convert existing owner results without inventing axes, patches, confidence or rule provenance. @module */
import type { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { type ReviewAnchor, ReviewRun, type ReviewThreadIdentity } from "@knpkv/review"
import { Effect, Schema } from "effect"
import type { PullRequestRelayReviewResponse } from "../Api.js"

const Coordinates = Schema.Struct({
  accountId: Schema.NonEmptyString,
  region: Schema.NonEmptyString,
  repository: Schema.NonEmptyString,
  id: Schema.NonEmptyString
})
/** Exact cached PR coordinates. A profile rename cannot change the private storage identity. */
export const reviewRunSubject = (pullRequest: PullRequest) =>
  Schema.decodeUnknownEffect(Coordinates)({
    accountId: pullRequest.account.awsAccountId,
    region: pullRequest.account.region,
    repository: pullRequest.repositoryName,
    id: pullRequest.id
  }).pipe(Effect.map((coordinates) =>
    JSON.stringify([
      coordinates.accountId,
      coordinates.region,
      coordinates.repository,
      coordinates.id
    ])
  ))

export const reviewRunIdentity = (
  subjectId: string,
  response: Pick<PullRequestRelayReviewResponse, "revisionId" | "baseCommit" | "headCommit">
): ReviewThreadIdentity => ({
  namespace: "codecommit",
  subjectId,
  revisionId: response.revisionId,
  baseRevision: response.baseCommit,
  headRevision: response.headCommit
})

/** Old findings contain recommendation prose, not executable patches or an axis classification. */
export const reviewRunOfResponse = (
  subjectId: string,
  response: PullRequestRelayReviewResponse,
  id: string,
  completedAt: number
) =>
  Schema.decodeUnknownEffect(ReviewRun, { onExcessProperty: "error" })({
    id,
    identity: reviewRunIdentity(subjectId, response),
    profile: {
      id: response.profile.id,
      name: response.profile.name,
      kind: response.profile.kind,
      provider: response.profile.provider,
      harness: response.profile.harness,
      model: response.profile.model,
      skillIds: response.profile.skillIds
    },
    kind: response.kind,
    completedAt,
    summary: response.result.verdict,
    explanation: response.result.explanation ?? null,
    risks: null,
    focus: null,
    rules: null,
    threads: response.result.findings.map((finding) => {
      const anchor: ReviewAnchor = finding.location.scope === "general"
        ? { _tag: "Unanchored" }
        : finding.location.scope === "file"
        ? { _tag: "File", path: finding.location.filePath, outdated: false }
        : {
          _tag: "Line",
          path: finding.location.filePath,
          line: finding.location.line,
          side: finding.location.side,
          outdated: false
        }
      return {
        id: finding.id,
        source: "agent",
        anchor,
        resolved: false,
        messages: [],
        finding: {
          severity: finding.priority,
          axis: null,
          confidence: null,
          claim: finding.title,
          summary: finding.summary,
          why: finding.details,
          recommendation: finding.recommendation,
          verification: finding.verification,
          requirement: null,
          patch: null,
          disposition: { _tag: "Open" }
        }
      }
    })
  })
