import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { Badge } from "./ui/badge.js"

interface PRRowProps {
  readonly pr: Domain.PullRequest
  readonly onClick: () => void
}

export function PRRow({ onClick, pr }: PRRowProps) {
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
        <span className="text-xs text-muted-foreground">
          {pr.author} · {DateUtils.formatDate(pr.creationDate)}
        </span>
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
