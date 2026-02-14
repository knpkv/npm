import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import {
  AlertCircleIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  InfoIcon,
  LoaderIcon,
  Trash2Icon,
  TriangleAlertIcon
} from "lucide-react"
import { useCallback, useState } from "react"
import { AwsProfileName } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import { useNavigate } from "react-router"
import {
  appStateAtom,
  markAllNotificationsReadAtom,
  markNotificationReadAtom,
  notificationsClearAtom,
  notificationsSsoLoginAtom,
  notificationsSsoLogoutAtom
} from "../atoms/app.js"
import { useInfiniteNotifications } from "../hooks/use-infinite-notifications.js"
import { useIntersectionObserver } from "../hooks/useIntersectionObserver.js"
import { useOptimisticSet } from "../hooks/useOptimistic.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Separator } from "./ui/separator.js"
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.js"

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

function PersistentNotificationsSection() {
  const { items: rawItems, hasMore, isLoading, loadMore } = useInfiniteNotifications()
  const markRead = useAtomSet(markNotificationReadAtom)
  const markAllRead = useAtomSet(markAllNotificationsReadAtom)
  const navigate = useNavigate()
  const [readIds, addReadId, setAllReadIds] = useOptimisticSet<number>(rawItems[0]?.id)

  const sentinelRef = useIntersectionObserver<HTMLDivElement>(() => {
    if (hasMore && !isLoading) void loadMore()
  })

  const items = rawItems.map((n) => readIds.has(n.id) ? { ...n, read: 1 } : n)
  if (items.length === 0) return null

  const unread = items.filter((n) => n.read === 0)

  const goToPR = (item: (typeof items)[number]) => {
    if (item.read === 0) {
      addReadId(item.id)
      markRead({ payload: { id: item.id } })
    }
    navigate(`/accounts/${encodeURIComponent(item.awsAccountId)}/prs/${item.pullRequestId}`)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">PR Updates</h2>
          {unread.length > 0 && <Badge variant="destructive">{unread.length} unread</Badge>}
        </div>
        {unread.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => {
            setAllReadIds(items.map((n) => n.id))
            markAllRead({})
          }}>
            <CheckIcon className="size-3.5 mr-1" />
            Mark all read
          </Button>
        )}
      </div>
      <div className="divide-y rounded-md border">
        {items.map((item) => (
          <button
            key={item.id}
            className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
            onClick={() => goToPR(item)}
          >
            {typeIcon(item.type)}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`text-sm ${item.read === 0 ? "font-medium" : "text-muted-foreground"}`}>
                  PR #{item.pullRequestId}
                </span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">{item.type}</Badge>
                <span className="text-xs text-muted-foreground">{formatTime(item.createdAt)}</span>
              </div>
              <p className="text-sm text-muted-foreground">{item.message}</p>
            </div>
            {item.read === 0 && (
              <span className="shrink-0 mt-0.5 size-2 rounded-full bg-blue-500" />
            )}
          </button>
        ))}
      </div>
      <div ref={sentinelRef} className="h-1" />
      {isLoading && (
        <div className="flex justify-center py-2">
          <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  )
}

function SystemNotificationsSection() {
  const state = useAtomValue(appStateAtom)
  const items = state.notifications ?? []
  const clearNotifications = useAtomSet(notificationsClearAtom)
  const ssoLogin = useAtomSet(notificationsSsoLoginAtom)
  const ssoLogout = useAtomSet(notificationsSsoLogoutAtom)
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})

  const toggle = useCallback((i: number) => {
    setExpanded((prev) => ({ ...prev, [i]: !prev[i] }))
  }, [])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        {items.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => clearNotifications({})}>
            <Trash2Icon className="size-3.5 mr-1" />
            Clear
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">No system notifications</p>
      ) : (
        <div className="divide-y rounded-md border">
          {items.map((item, i) => {
            const isOpen = expanded[i] ?? false
            return (
              <div key={i} className="px-3 py-2.5">
                <button className="flex w-full items-start gap-3 text-left" onClick={() => toggle(i)}>
                  {typeIcon(item.type)}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{item.title}</span>
                      <span className="text-xs text-muted-foreground">{formatTime(item.timestamp)}</span>
                    </div>
                    <p
                      className={`text-sm text-muted-foreground ${
                        isOpen ? "whitespace-pre-wrap break-words" : "truncate"
                      }`}
                    >
                      {item.message}
                    </p>
                  </div>
                  <ChevronDownIcon
                    className={`size-4 text-muted-foreground shrink-0 mt-0.5 transition-transform ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {isOpen && isAuthError(item.message) && (
                  <div className="flex gap-1 mt-2 ml-7">
                    <Button
                      variant="default"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        try {
                          const profile = Schema.decodeSync(AwsProfileName)(item.profile ?? item.title)
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
            )
          })}
        </div>
      )}
    </div>
  )
}

export function NotificationsPage() {
  const state = useAtomValue(appStateAtom)
  const navigate = useNavigate()
  const [tab, setTab] = useState<"updates" | "system">("updates")

  const unreadCount = state.unreadNotificationCount ?? 0
  const systemCount = (state.notifications ?? []).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Notifications</h1>
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          Back
        </Button>
      </div>
      <Separator />

      <ToggleGroup
        type="single"
        variant="outline"
        value={tab}
        onValueChange={(v) => { if (v) setTab(v as "updates" | "system") }}
      >
        <ToggleGroupItem value="updates" className="gap-1.5">
          PR Updates
          {unreadCount > 0 && <Badge variant="destructive" className="ml-1 text-[10px] px-1.5 py-0">{unreadCount}</Badge>}
        </ToggleGroupItem>
        <ToggleGroupItem value="system" className="gap-1.5">
          System
          {systemCount > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{systemCount}</Badge>}
        </ToggleGroupItem>
      </ToggleGroup>

      {tab === "updates" ? <PersistentNotificationsSection /> : <SystemNotificationsSection />}
    </div>
  )
}
