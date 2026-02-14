import { Match, Option } from "effect"
import type { PullRequest } from "./Domain.js"

export interface HealthScoreBreakdown {
  readonly label: string
  readonly value: number
}

export type CategoryStatus = "positive" | "neutral" | "negative"

export interface HealthScoreCategory {
  readonly label: string
  readonly description: string
  readonly status: CategoryStatus
  readonly statusLabel: string
  readonly value: number
}

export interface HealthScore {
  readonly total: number
  readonly breakdown: ReadonlyArray<HealthScoreBreakdown>
  readonly categories: ReadonlyArray<HealthScoreCategory>
}

export type HealthScoreTier = "green" | "yellow" | "red"

const MS_PER_DAY = 86_400_000

const round1 = (n: number): number => Math.round(n * 10) / 10

const clamp = (min: number, max: number, value: number): number => Math.min(max, Math.max(min, value))

const daysBetween = (from: Date, to: Date): number => Math.max(0, (to.getTime() - from.getTime()) / MS_PER_DAY)

const hasScope = (title: string): boolean => /^\w+(\([^)]+\))?:/.test(title) || /^[A-Z]+-\d+:/.test(title)

export const calculateHealthScore = (pr: PullRequest, now: Date): Option.Option<HealthScore> => {
  const daysSinceLastActivity = daysBetween(pr.lastModifiedDate, now)
  const daysSinceCreation = daysBetween(pr.creationDate, now)
  const commentCount = pr.commentCount ?? 0
  const scopeDetected = hasScope(pr.title)
  const hasDescription = !!pr.description && pr.description.trim().length > 0

  const timeDecay = -(daysSinceLastActivity * 1.0)
  const agePenalty = -(daysSinceCreation * 0.5)
  const commentBonus = commentCount * 1.0
  const approvalBonus = pr.isApproved ? 2 : 0
  const conflictPenalty = pr.isMergeable ? 0 : -3
  const scopeBonus = scopeDetected ? 0.5 : 0
  const descriptionBonus = hasDescription ? 0.5 : 0

  const raw = 10 + timeDecay + agePenalty + commentBonus + approvalBonus + conflictPenalty + scopeBonus +
    descriptionBonus
  const total = round1(clamp(0, 10, raw))

  const breakdown: Array<HealthScoreBreakdown> = [
    { label: "Base", value: 10 },
    { label: "Time decay", value: round1(timeDecay) },
    { label: "Age", value: round1(agePenalty) },
    { label: "Comments", value: round1(commentBonus) },
    { label: "Approval", value: approvalBonus },
    { label: "Conflicts", value: conflictPenalty },
    { label: "Scope", value: scopeBonus },
    { label: "Description", value: descriptionBonus }
  ]

  const categories: Array<HealthScoreCategory> = [
    {
      label: "Activity",
      description: `-1 per day since last update (${Math.round(daysSinceLastActivity)}d ago)`,
      value: round1(timeDecay),
      ...daysSinceLastActivity < 2
        ? { status: "positive", statusLabel: "ACTIVE" }
        : daysSinceLastActivity <= 7
        ? { status: "neutral", statusLabel: "SLOWING" }
        : { status: "negative", statusLabel: "STALE" }
    },
    {
      label: "Age",
      description: `-0.5 per day since creation (${Math.round(daysSinceCreation)}d old)`,
      value: round1(agePenalty),
      ...daysSinceCreation < 3
        ? { status: "positive", statusLabel: "FRESH" }
        : daysSinceCreation <= 14
        ? { status: "neutral", statusLabel: "AGING" }
        : { status: "negative", statusLabel: "OLD" }
    },
    {
      label: "Engagement",
      description: `+1 per comment (${commentCount} comments)`,
      value: round1(commentBonus),
      ...commentCount >= 3
        ? { status: "positive", statusLabel: "ACTIVE" }
        : commentCount >= 1
        ? { status: "neutral", statusLabel: "QUIET" }
        : { status: "negative", statusLabel: "SILENT" }
    },
    {
      label: "Approval",
      description: pr.isApproved ? "+2 bonus for approval" : "No approval yet (+2 when approved)",
      value: approvalBonus,
      ...pr.isApproved
        ? { status: "positive", statusLabel: "APPROVED" }
        : { status: "neutral", statusLabel: "PENDING" }
    },
    {
      label: "Mergeable",
      description: pr.isMergeable ? "No merge conflicts" : "-3 penalty for merge conflicts",
      value: conflictPenalty,
      ...pr.isMergeable
        ? { status: "positive", statusLabel: "CLEAN" }
        : { status: "negative", statusLabel: "CONFLICT" }
    },
    {
      label: "Scope",
      description: scopeDetected
        ? "+0.5 bonus — conventional commit or ticket prefix detected"
        : "No scope prefix found (e.g. feat(auth): or JIRA-123:)",
      value: scopeBonus,
      ...scopeDetected
        ? { status: "positive", statusLabel: "DETECTED" }
        : { status: "negative", statusLabel: "MISSING" }
    },
    {
      label: "Description",
      description: hasDescription ? "+0.5 bonus — PR description provided" : "No PR description provided",
      value: descriptionBonus,
      ...hasDescription
        ? { status: "positive", statusLabel: "PROVIDED" }
        : { status: "negative", statusLabel: "MISSING" }
    }
  ]

  return Option.some({ total, breakdown, categories })
}

export const scoreTotalOr = (pr: PullRequest, now: Date, fallback: number): number =>
  Option.match(calculateHealthScore(pr, now), { onNone: () => fallback, onSome: (s) => s.total })

export const getScoreTier = (score: number): HealthScoreTier =>
  Match.value(score).pipe(
    Match.when((s) => s >= 7, () => "green" as const),
    Match.when((s) => s >= 4, () => "yellow" as const),
    Match.orElse(() => "red" as const)
  )
