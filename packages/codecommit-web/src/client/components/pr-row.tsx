import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { calculateHealthScore, getScoreTier, type HealthScore } from "@knpkv/codecommit-core/HealthScore.js"
import { Option } from "effect"
import { MessageSquareIcon } from "lucide-react"
import { useMemo } from "react"
import { Badge } from "./ui/badge.js"

interface PRRowProps {
  readonly pr: Domain.PullRequest
  readonly onClick: () => void
}

export function PRRow({ onClick, pr }: PRRowProps) {
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

  const badge = !pr.isMergeable ? (
    <Badge variant="destructive">Conflict</Badge>
  ) : pr.isApproved ? (
    <Badge variant="outline" className="border-green-500/30 text-green-600 dark:text-green-400">
      Approved
    </Badge>
  ) : (
    <Badge variant="secondary">Pending</Badge>
  )

  return (
    <div
      className="group flex cursor-pointer flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-accent/50"
      onClick={onClick}
    >
      <div className="flex items-center gap-2">
        {badge}
        {score && <span className={`text-xs font-semibold tabular-nums ${scoreColor}`}>{score.total.toFixed(1)}</span>}
        <span className="text-xs text-muted-foreground">
          {pr.author} · {DateUtils.formatDate(pr.creationDate)}
        </span>
        {pr.commentCount !== undefined && pr.commentCount > 0 && (
          <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
            <MessageSquareIcon className="size-3" />
            {pr.commentCount}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-xs text-muted-foreground">{pr.repositoryName}</span>
        <span className="text-muted-foreground/50">›</span>
        <span className="text-sm font-medium">{pr.title}</span>
      </div>
      {pr.description && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{pr.description.split("\n").slice(0, 2).join(" ")}</p>
      )}
    </div>
  )
}
