import { Casing, Column, Query } from "effect-qb"
import * as Sqlite from "effect-qb/sqlite"

import type { RenderedSql } from "./types.js"

export { type GovernedActionRecoveryQueryInput, renderGovernedActionRecoveryQuery } from "./governedActionRecovery.js"
export {
  type RenderedTimelineQuery,
  renderTimelineDetailQueries,
  renderTimelineQueries,
  type TimelineQueryCursor,
  type TimelineQueryInput,
  type TimelineSourceKind
} from "./timeline.js"
export type { RenderedSql } from "./types.js"

/** Bounded current release-readiness query input. */
export interface CurrentReleaseReadinessQueryInput {
  readonly workspaceId: string
  readonly releaseIds: readonly [string, ...ReadonlyArray<string>]
}

const table = Casing.make({ tables: "snake_case", columns: "snake_case" }).table
const renderer = Sqlite.Renderer.make().pipe(Casing.withCasing("snake_case"))

const releaseHeads = table("readinessReleaseHeads", {
  workspaceId: Column.text(),
  releaseId: Column.text(),
  headRevision: Column.int(),
  assessmentId: Column.text(),
  candidateDigest: Column.text(),
  ruleId: Column.text(),
  ruleVersion: Column.int(),
  ruleDigest: Column.text(),
  derivationVersion: Column.int(),
  updatedAt: Column.text()
})

const headHistory = table("readinessHeadHistory", {
  workspaceId: Column.text(),
  scopeKind: Column.text(),
  releaseId: Column.text(),
  environmentKey: Column.text(),
  headRevision: Column.int(),
  assessmentId: Column.text(),
  committedAt: Column.text()
})

const assessments = table("readinessAssessments", {
  workspaceId: Column.text(),
  assessmentId: Column.text(),
  scopeKind: Column.text(),
  releaseId: Column.text(),
  environmentId: Column.text().pipe(Column.nullable),
  releaseRevision: Column.int(),
  artifactRevision: Column.text(),
  candidateDigest: Column.text(),
  ruleId: Column.text(),
  ruleVersion: Column.int(),
  ruleDigest: Column.text(),
  derivationVersion: Column.int(),
  previousAssessmentId: Column.text().pipe(Column.nullable),
  verdict: Column.text(),
  evaluatedAt: Column.text(),
  nextEvaluationAt: Column.text().pipe(Column.nullable),
  assessmentJson: Column.text(),
  assessmentDigest: Column.text()
})

const releaseQueue = table("readinessReleaseQueue", {
  workspaceId: Column.text(),
  releaseId: Column.text()
})

const environmentQueue = table("readinessEnvironmentQueue", {
  workspaceId: Column.text(),
  releaseId: Column.text()
})

/** Render the workspace-scoped plan for existing current release heads. */
export const renderCurrentReleaseReadinessQuery = (input: CurrentReleaseReadinessQueryInput): RenderedSql => {
  const [firstReleaseId, ...remainingReleaseIds] = input.releaseIds
  const pendingRelease = Query.select({ releaseId: releaseQueue.releaseId }).pipe(
    Query.from(releaseQueue),
    Query.where(
      Query.and(
        Query.eq(releaseQueue.workspaceId, releaseHeads.workspaceId),
        Query.eq(releaseQueue.releaseId, releaseHeads.releaseId)
      )
    )
  )
  const pendingEnvironment = Query.select({ releaseId: environmentQueue.releaseId }).pipe(
    Query.from(environmentQueue),
    Query.where(
      Query.and(
        Query.eq(environmentQueue.workspaceId, releaseHeads.workspaceId),
        Query.eq(environmentQueue.releaseId, releaseHeads.releaseId)
      )
    )
  )
  const plan = Query.select({
    headWorkspaceId: releaseHeads.workspaceId,
    headReleaseId: releaseHeads.releaseId,
    headAssessmentId: releaseHeads.assessmentId,
    headUpdatedAt: releaseHeads.updatedAt,
    headRevision: headHistory.headRevision,
    currentHeadRevision: releaseHeads.headRevision,
    committedAt: headHistory.committedAt,
    historyAssessmentId: headHistory.assessmentId,
    pending: Query.or(Query.exists(pendingRelease), Query.exists(pendingEnvironment)),
    workspaceId: assessments.workspaceId,
    assessmentId: assessments.assessmentId,
    scopeKind: assessments.scopeKind,
    releaseId: assessments.releaseId,
    environmentId: assessments.environmentId,
    releaseRevision: assessments.releaseRevision,
    artifactRevision: assessments.artifactRevision,
    candidateDigest: assessments.candidateDigest,
    ruleId: assessments.ruleId,
    ruleVersion: assessments.ruleVersion,
    ruleDigest: assessments.ruleDigest,
    derivationVersion: assessments.derivationVersion,
    previousAssessmentId: assessments.previousAssessmentId,
    verdict: assessments.verdict,
    evaluatedAt: assessments.evaluatedAt,
    nextEvaluationAt: assessments.nextEvaluationAt,
    assessmentJson: assessments.assessmentJson,
    assessmentDigest: assessments.assessmentDigest,
    headCandidateDigest: releaseHeads.candidateDigest,
    headRuleId: releaseHeads.ruleId,
    headRuleVersion: releaseHeads.ruleVersion,
    headRuleDigest: releaseHeads.ruleDigest,
    headDerivationVersion: releaseHeads.derivationVersion
  }).pipe(
    Query.from(releaseHeads),
    Query.leftJoin(
      headHistory,
      Query.and(
        Query.eq(headHistory.workspaceId, releaseHeads.workspaceId),
        Query.eq(headHistory.assessmentId, releaseHeads.assessmentId),
        Query.eq(headHistory.scopeKind, "release"),
        Query.eq(headHistory.releaseId, releaseHeads.releaseId),
        Query.eq(headHistory.environmentKey, ""),
        Query.eq(headHistory.headRevision, releaseHeads.headRevision)
      )
    ),
    Query.leftJoin(
      assessments,
      Query.and(
        Query.eq(assessments.workspaceId, releaseHeads.workspaceId),
        Query.eq(assessments.assessmentId, releaseHeads.assessmentId)
      )
    ),
    Query.where(
      Query.and(
        Query.eq(releaseHeads.workspaceId, input.workspaceId),
        Query.in(releaseHeads.releaseId, firstReleaseId, ...remainingReleaseIds)
      )
    ),
    Query.orderBy(releaseHeads.releaseId)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}
