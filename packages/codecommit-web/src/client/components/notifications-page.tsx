import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  InfoIcon,
  Trash2Icon,
  TriangleAlertIcon
} from "lucide-react"
import { useCallback, useState } from "react"
import { AwsProfileName } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import {
  appStateAtom,
  notificationsClearAtom,
  notificationsSsoLoginAtom,
  notificationsSsoLogoutAtom
} from "../atoms/app.js"
import { viewAtom } from "../atoms/ui.js"
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
  const items = state.notifications ?? []
  const clearNotifications = useAtomSet(notificationsClearAtom)
  const ssoLogin = useAtomSet(notificationsSsoLoginAtom)
  const ssoLogout = useAtomSet(notificationsSsoLogoutAtom)
  const setView = useAtomSet(viewAtom)
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})

  const toggle = useCallback((i: number) => {
    setExpanded((prev) => ({ ...prev, [i]: !prev[i] }))
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Notifications</h1>
          <p className="text-sm text-muted-foreground">System events and alerts</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => clearNotifications({})}>
            <Trash2Icon className="size-3.5 mr-1" />
            Clear all
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setView("prs")}>
            Back
          </Button>
        </div>
      </div>
      <Separator />
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No notifications</p>
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
                        const profile = Schema.decodeSync(AwsProfileName)(item.profile ?? item.title)
                        ssoLogin({ payload: { profile } })
                      }}
                    >
                      Login
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        ssoLogout({ payload: { profile: item.profile ?? item.title } })
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
