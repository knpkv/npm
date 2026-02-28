import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import {
  AlertCircleIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  InfoIcon,
  LoaderIcon,
  MailIcon,
  MailOpenIcon,
  TriangleAlertIcon
} from "lucide-react"
import { AwsProfileName } from "@knpkv/codecommit-core/Domain.js"
import { Option, Schema } from "effect"
import { useState } from "react"
import { useNavigate } from "react-router"
import {
  appStateAtom,
  markAllNotificationsReadAtom,
  markNotificationReadAtom,
  markNotificationUnreadAtom,
  notificationsSsoLoginAtom,
  notificationsSsoLogoutAtom
} from "../atoms/app.js"
import { useInfiniteNotifications } from "../hooks/use-infinite-notifications.js"
import { useIntersectionObserver } from "../hooks/useIntersectionObserver.js"
import { useOptimisticSet } from "../hooks/useOptimistic.js"
import { Badge } from "./ui/badge.js"
import { Button, ButtonGroup } from "./ui/button.js"
import { Separator } from "./ui/separator.js"
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.js"

const isAuthError = (message: string) =>
  /ExpiredToken|Unauthorized|AuthFailure|SSO|token|credentials|expired/i.test(message)

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

const MessageFields = Schema.Struct({
  operation: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String)
})

/** Structured JSON format (new notifications) */
const JsonMessage = Schema.parseJson(MessageFields)

/** Plain text format (old notifications) — wrap in cause field */
const PlainMessage = Schema.transform(Schema.String, MessageFields, {
  decode: (s) => ({ cause: s }),
  encode: (m) => m.cause ?? ""
})

const decodeMessage = Schema.decodeOption(Schema.Union(JsonMessage, PlainMessage))

/** Try to parse message as structured notification */
const parseStructured = (message: string) => decodeMessage(message)

/** Extract a human-readable summary */
const formatMessage = (message: string): string => {
  const opt = parseStructured(message)
  if (Option.isNone(opt)) return message
  const { cause, error, message: msg, operation } = opt.value
  const reason = cause ?? error ?? msg
  const parts: Array<string> = []
  if (operation) parts.push(operation)
  if (reason) parts.push(reason)
  return parts.length > 0 ? parts.join(" — ") : message
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
  const [filter, setFilter] = useState<"system" | "prs" | undefined>(undefined)
  const [unreadOnly, setUnreadOnly] = useState(true)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(new Set())
  const toggleExpand = (id: number) =>
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const state = useAtomValue(appStateAtom)
  const navigate = useNavigate()
  const { items: rawItems, hasMore, isLoading, loadMore } = useInfiniteNotifications({ filter, unreadOnly })
  const markRead = useAtomSet(markNotificationReadAtom)
  const markUnread = useAtomSet(markNotificationUnreadAtom)
  const markAllRead = useAtomSet(markAllNotificationsReadAtom)
  const ssoLogin = useAtomSet(notificationsSsoLoginAtom)
  const ssoLogout = useAtomSet(notificationsSsoLogoutAtom)
  const [readIds, addReadId, setAllReadIds] = useOptimisticSet<number>(rawItems[0]?.id)
  const [unreadIds, addUnreadId, , removeUnreadId] = useOptimisticSet<number>(rawItems[0]?.id)

  const sentinelRef = useIntersectionObserver<HTMLDivElement>(() => {
    if (hasMore && !isLoading) void loadMore()
  })

  const items = rawItems.map((n) =>
    unreadIds.has(n.id) ? { ...n, read: 0 } : readIds.has(n.id) ? { ...n, read: 1 } : n
  )
  const unreadCount = state.unreadNotificationCount ?? 0
  const isSystem = (item: (typeof items)[number]) => item.pullRequestId === ""

  const goToPR = (item: (typeof items)[number]) => {
    if (item.read === 0) {
      addReadId(item.id)
      removeUnreadId(item.id)
      markRead({ payload: { id: item.id } })
    }
    if (!isSystem(item)) {
      navigate(`/accounts/${encodeURIComponent(item.awsAccountId)}/prs/${item.pullRequestId}`)
    } else {
      toggleExpand(item.id)
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

      <div className="flex items-center gap-3">
        <ToggleGroup
          type="single"
          value={filter ?? "all"}
          onValueChange={(v: string) => setFilter(v === "all" || v === "" ? undefined : (v as "system" | "prs"))}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="system">System</ToggleGroupItem>
          <ToggleGroupItem value="prs">PRs</ToggleGroupItem>
        </ToggleGroup>
        <Button variant={unreadOnly ? "secondary" : "ghost"} size="sm" onClick={() => setUnreadOnly((v) => !v)}>
          Unread only
        </Button>
      </div>

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
            {items.map((item) => {
              const summary = formatMessage(item.message)
              const expanded = expandedIds.has(item.id)
              return (
                <div key={item.id} className={`flex ${item.read === 0 ? "border-l-2 border-l-blue-500" : ""}`}>
                  <div className="flex-1 min-w-0">
                    <div
                      className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-accent/50 transition-colors"
                      role="button"
                      tabIndex={0}
                      onClick={() => goToPR(item)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") goToPR(item)
                      }}
                    >
                      {typeIcon(item.type)}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span
                            className={`text-sm truncate ${item.read === 0 ? "font-medium" : "text-muted-foreground"}`}
                          >
                            {item.title || (!isSystem(item) ? `PR #${item.pullRequestId}` : item.type)}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">{formatTime(item.createdAt)}</span>
                        </div>
                        {!expanded && <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{summary}</p>}
                      </div>
                    </div>
                    {expanded && (
                      <div className="px-3 pb-2.5 ml-7 space-y-2 min-w-0 overflow-hidden">
                        {Option.match(parseStructured(item.message), {
                          onNone: () => <p className="text-xs text-muted-foreground break-words">{item.message}</p>,
                          onSome: (s) => (
                            <div className="text-xs text-muted-foreground space-y-0.5">
                              {s.operation && (
                                <div>
                                  <span className="font-medium">operation:</span> {s.operation}
                                </div>
                              )}
                              {s.profile && (
                                <div>
                                  <span className="font-medium">profile:</span> {s.profile}
                                </div>
                              )}
                              {s.region && (
                                <div>
                                  <span className="font-medium">region:</span> {s.region}
                                </div>
                              )}
                              {s.cause && (
                                <div>
                                  <span className="font-medium">cause:</span> {s.cause}
                                </div>
                              )}
                              {s.error && (
                                <div>
                                  <span className="font-medium">error:</span> {s.error}
                                </div>
                              )}
                              {s.message && (
                                <div>
                                  <span className="font-medium">message:</span> {s.message}
                                </div>
                              )}
                            </div>
                          )
                        })}
                        <ButtonGroup>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              if (item.read === 0) {
                                addReadId(item.id)
                                removeUnreadId(item.id)
                                markRead({ payload: { id: item.id } })
                              } else {
                                addUnreadId(item.id)
                                markUnread({ payload: { id: item.id } })
                              }
                            }}
                          >
                            {item.read === 0 ? (
                              <>
                                <MailOpenIcon className="size-3" /> Mark as read
                              </>
                            ) : (
                              <>
                                <MailIcon className="size-3" /> Mark as unread
                              </>
                            )}
                          </Button>
                          {isSystem(item) && isAuthError(item.message) && (
                            <>
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
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2.5 text-xs"
                                onClick={() => {
                                  ssoLogout({})
                                }}
                              >
                                Logout
                              </Button>
                            </>
                          )}
                        </ButtonGroup>
                      </div>
                    )}
                  </div>
                  <button
                    className="shrink-0 px-3 flex items-center hover:bg-accent/50 transition-colors border-l border-border"
                    onClick={() => toggleExpand(item.id)}
                    title={expanded ? "Collapse" : "Expand"}
                  >
                    <ChevronRightIcon
                      className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
                    />
                  </button>
                </div>
              )
            })}
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
