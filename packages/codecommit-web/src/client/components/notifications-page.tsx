import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { AlertCircleIcon, CheckCircleIcon, CheckIcon, InfoIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react"
import { AwsProfileName } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import { useNavigate } from "react-router"
import {
  appStateAtom,
  markAllNotificationsReadAtom,
  markNotificationReadAtom,
  notificationsSsoLoginAtom,
  notificationsSsoLogoutAtom
} from "../atoms/app.js"
import { useInfiniteNotifications } from "../hooks/use-infinite-notifications.js"
import { useIntersectionObserver } from "../hooks/useIntersectionObserver.js"
import { useOptimisticSet } from "../hooks/useOptimistic.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Separator } from "./ui/separator.js"

const isAuthError = (message: string) => /ExpiredToken|Unauthorized|AuthFailure|SSO|token|credentials/i.test(message)

const typeIcon = (type: string) => {
  switch (type) {
    case "error":
      return <AlertCircleIcon className="size-4 text-destructive shrink-0" />
    case "warning":
      return <TriangleAlertIcon className="size-4 text-yellow-500 shrink-0" />
    case "success":
      return <CheckCircleIcon className="size-4 text-green-500 shrink-0" />
    default:
      return <InfoIcon className="size-4 text-blue-500 shrink-0" />
  }
}

const formatTime = (ts: string) => {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return d.toLocaleDateString()
}

export function NotificationsPage() {
  const state = useAtomValue(appStateAtom)
  const navigate = useNavigate()
  const { items: rawItems, hasMore, isLoading, loadMore } = useInfiniteNotifications()
  const markRead = useAtomSet(markNotificationReadAtom)
  const markAllRead = useAtomSet(markAllNotificationsReadAtom)
  const ssoLogin = useAtomSet(notificationsSsoLoginAtom)
  const ssoLogout = useAtomSet(notificationsSsoLogoutAtom)
  const [readIds, addReadId, setAllReadIds] = useOptimisticSet<number>(rawItems[0]?.id)

  const sentinelRef = useIntersectionObserver<HTMLDivElement>(() => {
    if (hasMore && !isLoading) void loadMore()
  })

  const items = rawItems.map((n) => (readIds.has(n.id) ? { ...n, read: 1 } : n))
  const unreadCount = state.unreadNotificationCount ?? 0
  const isSystem = (item: (typeof items)[number]) => item.pullRequestId === ""

  const goToPR = (item: (typeof items)[number]) => {
    if (item.read === 0) {
      addReadId(item.id)
      markRead({ payload: { id: item.id } })
    }
    if (!isSystem(item)) {
      navigate(`/accounts/${encodeURIComponent(item.awsAccountId)}/prs/${item.pullRequestId}`)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Notifications</h1>
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          Back
        </Button>
      </div>
      <Separator />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {unreadCount > 0 && <Badge variant="destructive">{unreadCount} unread</Badge>}
          </div>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAllReadIds(items.map((n) => n.id))
                markAllRead({})
              }}
            >
              <CheckIcon className="size-3.5 mr-1" />
              Mark all read
            </Button>
          )}
        </div>

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No notifications</p>
        ) : (
          <div className="divide-y rounded-md border">
            {items.map((item) => (
              <div key={item.id} className="px-3 py-2.5">
                <button
                  className="flex w-full items-start gap-3 text-left hover:bg-accent/50 transition-colors rounded-sm -mx-1 px-1"
                  onClick={() => goToPR(item)}
                >
                  {typeIcon(item.type)}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {item.title ? (
                        <span className={`text-sm ${item.read === 0 ? "font-medium" : "text-muted-foreground"}`}>
                          {item.title}
                        </span>
                      ) : !isSystem(item) ? (
                        <span className={`text-sm ${item.read === 0 ? "font-medium" : "text-muted-foreground"}`}>
                          PR #{item.pullRequestId}
                        </span>
                      ) : null}
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {item.type}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{formatTime(item.createdAt)}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{item.message}</p>
                  </div>
                  {item.read === 0 && <span className="shrink-0 mt-0.5 size-2 rounded-full bg-blue-500" />}
                </button>
                {isSystem(item) && isAuthError(item.message) && (
                  <div className="flex gap-1 mt-2 ml-7">
                    <Button
                      variant="default"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        try {
                          const profile = Schema.decodeSync(AwsProfileName)(item.profile || item.title)
                          ssoLogin({ payload: { profile } })
                        } catch {
                          // invalid profile name — ignore
                        }
                      }}
                    >
                      Login
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        ssoLogout({})
                      }}
                    >
                      Logout
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <div ref={sentinelRef} className="h-1" />
        {isLoading && (
          <div className="flex justify-center py-2">
            <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  )
}
