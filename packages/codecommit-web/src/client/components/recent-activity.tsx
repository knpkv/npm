import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import {
  BellIcon,
  CheckCircle2Icon,
  EyeIcon,
  GitBranchIcon,
  GitMergeIcon,
  type LucideIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  XCircleIcon
} from "lucide-react"
import { Link } from "react-router"
import type { NotificationItem } from "../atoms/app.js"

const ICON_MAP: Record<string, { icon: LucideIcon; className: string }> = {
  new_comment: { icon: MessageSquareIcon, className: "text-blue-500" },
  comment_edited: { icon: MessageSquareIcon, className: "text-muted-foreground" },
  comment_deleted: { icon: MessageSquareIcon, className: "text-muted-foreground" },
  approval_changed: { icon: CheckCircle2Icon, className: "text-green-500" },
  approval_requested: { icon: EyeIcon, className: "text-yellow-500" },
  pr_merged: { icon: GitMergeIcon, className: "text-purple-500" },
  pr_closed: { icon: XCircleIcon, className: "text-red-500" },
  pr_reopened: { icon: RefreshCwIcon, className: "text-blue-500" },
  merge_changed: { icon: GitBranchIcon, className: "text-orange-500" }
}

const DEFAULT_ICON = { icon: BellIcon, className: "text-muted-foreground" }

function getIcon(type: string) {
  return ICON_MAP[type] ?? DEFAULT_ICON
}

interface RecentActivityProps {
  readonly notifications: ReadonlyArray<NotificationItem>
}

export function RecentActivity({ notifications }: RecentActivityProps) {
  // Only show PR notifications (skip system notifications with empty pullRequestId)
  const prItems = notifications.filter((n) => n.pullRequestId && n.type in ICON_MAP).slice(0, 5)
  if (prItems.length === 0) return null

  const now = new Date()

  return (
    <div className="rounded-lg border bg-card px-4 py-4">
      <h3 className="mb-3 text-xs font-semibold text-muted-foreground">Recent Activity</h3>
      <div className="flex flex-col gap-2.5">
        {prItems.map((n) => {
          const { className, icon: Icon } = getIcon(n.type)
          const href =
            n.awsAccountId && n.pullRequestId
              ? `/accounts/${encodeURIComponent(n.awsAccountId)}/prs/${n.pullRequestId}`
              : null
          return href ? (
            <Link
              key={n.id}
              to={href}
              className="flex items-start gap-2.5 rounded-md -mx-1.5 px-1.5 py-1 transition-colors hover:bg-accent no-underline text-inherit"
            >
              <div
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted ${className}`}
              >
                <Icon className="size-3" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-snug">{n.title || n.message}</p>
                <p className="text-[11px] text-muted-foreground">
                  {DateUtils.formatRelativeTime(new Date(n.createdAt), now)}
                  {n.profile && <>· {n.profile}</>}
                </p>
              </div>
            </Link>
          ) : (
            <div key={n.id} className="flex items-start gap-2.5 px-1.5 py-1">
              <div
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted ${className}`}
              >
                <Icon className="size-3" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-snug">{n.title || n.message}</p>
                <p className="text-[11px] text-muted-foreground">
                  {DateUtils.formatRelativeTime(new Date(n.createdAt), now)}
                  {n.profile && <>· {n.profile}</>}
                </p>
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 text-center">
        <Link to="/notifications" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
          View all activity →
        </Link>
      </div>
    </div>
  )
}
