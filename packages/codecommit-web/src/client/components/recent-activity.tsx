import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import { ServiceMark } from "@knpkv/rly/patterns"
import { Surface, Text } from "@knpkv/rly/primitives"
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
import styles from "./review-queue.module.css"

type ActivityTone = "neutral" | "positive" | "caution" | "critical" | "progress"

const iconMap: Readonly<Record<string, { readonly icon: LucideIcon; readonly tone: ActivityTone }>> = {
  new_comment: { icon: MessageSquareIcon, tone: "progress" },
  comment_edited: { icon: MessageSquareIcon, tone: "neutral" },
  comment_deleted: { icon: MessageSquareIcon, tone: "neutral" },
  approval_changed: { icon: CheckCircle2Icon, tone: "positive" },
  approval_requested: { icon: EyeIcon, tone: "caution" },
  pr_merged: { icon: GitMergeIcon, tone: "positive" },
  pr_closed: { icon: XCircleIcon, tone: "critical" },
  pr_reopened: { icon: RefreshCwIcon, tone: "progress" },
  merge_changed: { icon: GitBranchIcon, tone: "progress" }
}

const defaultIcon: { readonly icon: LucideIcon; readonly tone: ActivityTone } = {
  icon: BellIcon,
  tone: "neutral"
}

const toneClassName = (tone: ActivityTone): string => {
  switch (tone) {
    case "positive":
      return styles.activityPositive ?? ""
    case "caution":
      return styles.activityCaution ?? ""
    case "critical":
      return styles.activityCritical ?? ""
    case "progress":
      return styles.activityProgress ?? ""
    default:
      return styles.activityNeutral ?? ""
  }
}

interface RecentActivityProps {
  readonly notifications: ReadonlyArray<NotificationItem>
}

export function RecentActivity({ notifications }: RecentActivityProps) {
  const prItems = notifications.filter((notification) => notification.pullRequestId).slice(0, 5)
  if (prItems.length === 0) return null

  const now = new Date()

  return (
    <section aria-labelledby="recent-activity-heading" className={styles.activitySection}>
      <div className={styles.activityHeading}>
        <div className={styles.activityTitle}>
          <ServiceMark service="codecommit" size="compact" />
          <Text as="h2" id="recent-activity-heading" variant="section-title">
            Recent activity
          </Text>
        </div>
        <Link className={styles.activityMore} to="/notifications">
          View all activity
          <span aria-hidden="true">→</span>
        </Link>
      </div>

      <Surface className={styles.activityList} padding="none" shape="grouped">
        {prItems.map((notification) => {
          const presentation = iconMap[notification.type] ?? defaultIcon
          const Icon = presentation.icon
          const href =
            notification.awsAccountId && notification.pullRequestId
              ? `/accounts/${encodeURIComponent(notification.awsAccountId)}/prs/${notification.pullRequestId}`
              : undefined
          const content = (
            <>
              <span className={`${styles.activityIcon ?? ""} ${toneClassName(presentation.tone)}`}>
                <Icon aria-hidden="true" />
              </span>
              <span className={styles.activityCopy}>
                <Text className={styles.activityItemTitle} variant="label">
                  {notification.title || notification.message}
                </Text>
                <Text tone="tertiary" variant="meta">
                  {DateUtils.formatRelativeTime(new Date(notification.createdAt), now)}
                  {notification.profile ? ` · ${notification.profile}` : ""}
                </Text>
              </span>
            </>
          )

          return href ? (
            <Link className={styles.activityItem} key={notification.id} to={href}>
              {content}
            </Link>
          ) : (
            <div className={styles.activityItem} key={notification.id}>
              {content}
            </div>
          )
        })}
      </Surface>
    </section>
  )
}
