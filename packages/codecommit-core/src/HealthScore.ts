import { Match, Option } from "effect"
import {
  approvalNotRequiredLabel,
  approvalOf,
  approvalUnknownLabel,
  approvalUnknownReasonText,
  type PullRequest
} from "./Domain.js"

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
const greenTier: HealthScoreTier = "green"
const yellowTier: HealthScoreTier = "yellow"
const redTier: HealthScoreTier = "red"

const round1 = (n: number): number => Math.round(n * 10) / 10

const clamp = (min: number, max: number, value: number): number => Math.min(max, Math.max(min, value))

const daysBetween = (from: Date, to: Date): number => Math.max(0, (to.getTime() - from.getTime()) / MS_PER_DAY)

const hasScope = (title: string): boolean => /^\w+(\([^)]+\))?:/.test(title) || /^[A-Z]+-\d+:/.test(title)

type ApprovalCategory = Pick<HealthScoreCategory, "description" | "status" | "statusLabel">

/** The provider gave no date: the decode falls back to the epoch rather than inventing one. */
const isMissingDate = (date: Date): boolean => date.getTime() === 0

/** The most a quiet pull request can lose for idleness, and how fast it approaches that (days). */
const IDLE_PENALTY_MAX = 6
const IDLE_DAYS_SCALE = 14
/** The most it can lose for age, and how fast (days). */
const AGE_PENALTY_MAX = 2
const AGE_DAYS_SCALE = 60
/** Comments count up to this many, so a busy thread cannot outweigh months of silence. */
const COMMENTS_COUNTED = 3

/** A penalty that grows quickly at first and levels off at `max`, so long-idle PRs stay comparable. */
const saturating = (max: number, scale: number, days: number): number => max * (1 - Math.exp(-days / scale))

/**
 * Score an open pull request from 0 to 10: a base of 8, minus saturating penalties for idleness (up to
 * 6) and age (up to 2), plus bounded bonuses. Unknown (`Option.none()`) when CodeCommit gave no
 * activity or creation date, since those dominate the score. A comment count that hasn't loaded yet
 * counts as none, so the score is a lower bound, and the breakdown says so.
 */
export const calculateHealthScore = (pr: PullRequest, now: Date): Option.Option<HealthScore> => {
  if (isMissingDate(pr.lastModifiedDate) || isMissingDate(pr.creationDate)) return Option.none()
  const daysSinceLastActivity = daysBetween(pr.lastModifiedDate, now)
  const daysSinceCreation = daysBetween(pr.creationDate, now)
  const commentsLoaded = pr.commentCount !== undefined
  const commentCount = pr.commentCount ?? 0
  const scopeDetected = hasScope(pr.title)
  const hasDescription = !!pr.description && pr.description.trim().length > 0

  const timeDecay = -saturating(IDLE_PENALTY_MAX, IDLE_DAYS_SCALE, daysSinceLastActivity)
  const agePenalty = -saturating(AGE_PENALTY_MAX, AGE_DAYS_SCALE, daysSinceCreation)
  const commentBonus = Math.min(COMMENTS_COUNTED, commentCount) * 0.5
  const approval = approvalOf(pr)
  // Nobody signed off on a PR with no rules, so it earns less than an approval.
  const approvalBonus = approval._tag === "Approved" ? 2 : approval._tag === "NotRequired" ? 1 : 0
  const conflictPenalty = pr.isMergeable ? 0 : -3
  const scopeBonus = scopeDetected ? 0.5 : 0
  const descriptionBonus = hasDescription ? 0.5 : 0

  const raw = 8 + timeDecay + agePenalty + commentBonus + approvalBonus + conflictPenalty + scopeBonus +
    descriptionBonus
  const total = round1(clamp(0, 10, raw))

  const breakdown: Array<HealthScoreBreakdown> = [
    { label: "Base", value: 8 },
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
      description: `Up to -${IDLE_PENALTY_MAX} for time since the last update (${
        Math.round(daysSinceLastActivity)
      }d ago)`,
      value: round1(timeDecay),
      ...daysSinceLastActivity < 2
        ? { status: "positive", statusLabel: "ACTIVE" }
        : daysSinceLastActivity <= 7
        ? { status: "neutral", statusLabel: "SLOWING" }
        : { status: "negative", statusLabel: "STALE" }
    },
    {
      label: "Age",
      description: `Up to -${AGE_PENALTY_MAX} for age (${Math.round(daysSinceCreation)}d old)`,
      value: round1(agePenalty),
      ...daysSinceCreation < 3
        ? { status: "positive", statusLabel: "FRESH" }
        : daysSinceCreation <= 14
        ? { status: "neutral", statusLabel: "AGING" }
        : { status: "negative", statusLabel: "OLD" }
    },
    {
      label: "Engagement",
      description: commentsLoaded
        ? `+0.5 per comment, up to ${COMMENTS_COUNTED} (${commentCount} comments)`
        : "Comments not loaded yet",
      value: round1(commentBonus),
      ...commentCount >= 3
        ? { status: "positive", statusLabel: "ACTIVE" }
        : commentCount >= 1
        ? { status: "neutral", statusLabel: "QUIET" }
        : { status: "negative", statusLabel: "SILENT" }
    },
    {
      label: "Approval",
      value: approvalBonus,
      ...Match.valueTags(approval, {
        Approved: (): ApprovalCategory => ({
          description: "+2 bonus for approval",
          status: "positive",
          statusLabel: "APPROVED"
        }),
        NotRequired: (): ApprovalCategory => ({
          description: `+1: ${approvalNotRequiredLabel.toLowerCase()}, and nobody signed off`,
          status: "neutral",
          statusLabel: "NOT REQUIRED"
        }),
        Pending: (): ApprovalCategory => ({
          description: "No approval yet (+2 when approved)",
          status: "neutral",
          statusLabel: "PENDING"
        }),
        Unknown: ({ reason }): ApprovalCategory => ({
          description: `${approvalUnknownLabel}: ${approvalUnknownReasonText(reason)}`,
          status: "neutral",
          statusLabel: "UNKNOWN"
        })
      })
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
    Match.when((s) => s >= 7, () => greenTier),
    Match.when((s) => s >= 4, () => yellowTier),
    Match.orElse(() => redTier)
  )
