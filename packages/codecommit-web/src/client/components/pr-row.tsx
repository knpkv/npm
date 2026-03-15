/**
 * Single PR row — status badge, health score, review indicator.
 *
 * Renders a clickable row with status badge (Merged/Closed/Conflict/
 * Approved/Pending), review badge (EyeIcon when {@link needsMyReview}
 * returns true), health score with color tiers (green/yellow/red),
 * author, date, comment count, repository name, and PR title.
 *
 * @module
 */
import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import type { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { needsMyReview } from "@knpkv/codecommit-core/Domain.js"
import { calculateHealthScore, getScoreTier, type HealthScore } from "@knpkv/codecommit-core/HealthScore.js"
import { Option } from "effect"
import { EyeIcon, MessageSquareIcon } from "lucide-react"
import { useMemo } from "react"
import { Link } from "react-router"
import { Badge } from "./ui/badge.js"

interface PRRowProps {
  readonly pr: PullRequest
  readonly to: string
  readonly showUpdated?: boolean
  readonly currentUser?: string | undefined
}

const STATUS_CONFIG: Record<string, { label: string; dot: string; badge: string }> = {
  conflict: { label: "conflict", dot: "bg-red-500", badge: "border-red-500/30 text-red-500" },
  approved: { label: "approved", dot: "bg-green-500", badge: "border-green-500/30 text-green-500" },
  pending: { label: "pending", dot: "bg-yellow-500", badge: "border-yellow-500/30 text-yellow-500" },
  merged: { label: "merged", dot: "bg-purple-500", badge: "border-purple-500/30 text-purple-500" },
  closed: { label: "closed", dot: "bg-red-500", badge: "border-red-500/30 text-red-500" }
}

function getStatusKey(pr: PullRequest): string {
  if (pr.status === "MERGED") return "merged"
  if (pr.status === "CLOSED") return "closed"
  if (!pr.isMergeable) return "conflict"
  if (pr.isApproved) return "approved"
  return "pending"
}

export function PRRow({ currentUser, pr, showUpdated, to }: PRRowProps) {
  const reviewRequested = needsMyReview(pr, currentUser)
  const score: HealthScore | undefined = useMemo(
    () => Option.getOrUndefined(calculateHealthScore(pr, new Date())),
    [pr]
  )
  const tier = score ? getScoreTier(score.total) : undefined
  const scoreColor =
    tier === "green"
      ? "text-green-600 dark:text-green-400"
      : tier === "yellow"
        ? "text-yellow-600 dark:text-yellow-400"
        : "text-red-600 dark:text-red-400"

  const statusKey = getStatusKey(pr)
  const cfg = STATUS_CONFIG[statusKey]!

  return (
    <Link
      to={to}
      className="group flex cursor-pointer flex-col gap-2.5 px-5 py-5 transition-colors hover:bg-accent/50 no-underline text-inherit"
    >
      {/* Row 1: status + score ... author · date · comments */}
      <div className="flex items-center gap-2.5">
        <Badge variant="outline" className={`gap-1.5 ${cfg.badge}`}>
          <span className={`size-1.5 rounded-full ${cfg.dot}`} />
          {cfg.label}
        </Badge>
        {reviewRequested && (
          <Badge variant="outline" className="border-yellow-500/30 text-yellow-500 gap-1">
            <EyeIcon className="size-3" />
            Review
          </Badge>
        )}
        {score && (
          <span className={`font-mono text-base font-semibold tabular-nums ${scoreColor}`}>
            {score.total.toFixed(1)}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          {pr.author}
          <span className="opacity-40">·</span>
          {showUpdated
            ? DateUtils.formatRelativeTime(pr.lastModifiedDate, new Date())
            : DateUtils.formatDate(pr.creationDate)}
          {pr.commentCount !== undefined && pr.commentCount > 0 && (
            <>
              <span className="opacity-40">·</span>
              <MessageSquareIcon className="size-3" />
              {pr.commentCount}
            </>
          )}
        </span>
      </div>

      {/* Row 2: repo pill */}
      <div>
        <Badge variant="outline" className="font-mono text-[11px] font-normal text-muted-foreground">
          {pr.repositoryName}
        </Badge>
      </div>

      {/* Row 3: title */}
      <span className="text-[15px] font-medium leading-snug">{pr.title}</span>

      {/* Row 4: description */}
      {pr.description && (
        <p className="line-clamp-1 text-sm text-muted-foreground">{pr.description.split("\n").slice(0, 2).join(" ")}</p>
      )}
    </Link>
  )
}
