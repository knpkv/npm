import type { NotificationItem } from "../atoms/app.js"
import { RecentActivityView } from "./recent-activity-view.js"

interface RecentActivityProps {
  readonly notifications: ReadonlyArray<NotificationItem>
}

export function RecentActivity({ notifications }: RecentActivityProps) {
  return <RecentActivityView notifications={notifications} now={new Date()} />
}
