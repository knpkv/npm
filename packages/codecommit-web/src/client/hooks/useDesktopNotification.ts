/**
 * Browser Notification API wrapper with permission management.
 *
 * **Mental model**
 *
 * - Reads enabled state from localStorage (`codecommit:desktopNotifications`)
 * - Only fires when Notification.permission === "granted" AND setting enabled
 * - {@link notify}: creates a browser Notification with optional click-to-navigate
 * - Desktop-worthy types: approval_requested, approval_changed, new_comment, pr_merged, pr_closed
 *
 * @module
 */
import { useCallback, useRef } from "react"
import { StorageKeys } from "../storage-keys.js"

const DESKTOP_WORTHY_TYPES = new Set([
  "approval_requested",
  "approval_changed",
  "new_comment",
  "pr_merged",
  "pr_closed"
])

export function useDesktopNotification(onNavigate?: (path: string) => void) {
  const permissionRef = useRef(
    typeof Notification !== "undefined" ? Notification.permission : ("unsupported" as string)
  )

  const isEnabled = useCallback(() => {
    try {
      return localStorage.getItem(StorageKeys.desktopNotifications) === "true"
    } catch {
      return false
    }
  }, [])

  const notify = useCallback(
    (
      n: {
        readonly type: string
        readonly title: string
        readonly message: string
        readonly awsAccountId?: string
        readonly pullRequestId?: string
      }
    ) => {
      if (!isEnabled()) return
      if (permissionRef.current !== "granted") return
      if (!DESKTOP_WORTHY_TYPES.has(n.type)) return

      const notification = new Notification(n.title || "CodeCommit", {
        body: n.message,
        icon: "/favicon.ico",
        tag: `${n.type}:${n.pullRequestId ?? ""}`,
        requireInteraction: false
      })

      if (n.awsAccountId && n.pullRequestId && onNavigate) {
        notification.onclick = () => {
          window.focus()
          onNavigate(`/accounts/${n.awsAccountId}/prs/${n.pullRequestId}`)
        }
      }
    },
    [isEnabled, onNavigate]
  )

  return { notify, isDesktopWorthy: (type: string) => DESKTOP_WORTHY_TYPES.has(type) }
}
