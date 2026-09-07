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
import { codeCommitPullRequestHref } from "../codecommit-route.js"
import { readNotificationApi } from "../host-globals.js"
import { StorageKeys } from "../storage-keys.js"

export interface DesktopNotificationNavigation {
  readonly awsAccountId?: string
  readonly pullRequestId?: string
  readonly repositoryName?: string
  readonly accountRegion?: string
}

/** Keep complete notifications exact while retaining legacy links for old payloads. */
export const desktopNotificationPath = (n: DesktopNotificationNavigation): string => {
  const accountId = n.awsAccountId
  const pullRequestId = n.pullRequestId
  if (accountId !== undefined && accountId !== "" && pullRequestId !== undefined && pullRequestId !== "") {
    if (
      n.repositoryName !== undefined &&
      n.repositoryName !== "" &&
      n.accountRegion !== undefined &&
      n.accountRegion !== ""
    ) {
      return codeCommitPullRequestHref(accountId, pullRequestId, n.repositoryName, n.accountRegion)
    }
    return `/accounts/${encodeURIComponent(accountId)}/prs/${encodeURIComponent(pullRequestId)}`
  }
  return "/notifications"
}

export function useDesktopNotification(onNavigate?: (path: string) => void) {
  const navigateRef = useRef(onNavigate)
  navigateRef.current = onNavigate
  const activeRef = useRef<Array<Notification>>([])
  const firedIdsRef = useRef(new Set<number>())

  const notify = useCallback(
    (n: {
      readonly id?: number
      readonly type: string
      readonly title: string
      readonly message: string
      readonly awsAccountId?: string
      readonly pullRequestId?: string
      readonly repositoryName?: string
      readonly accountRegion?: string
    }) => {
      // Dedup: don't fire the same notification twice
      if (n.id != null) {
        if (firedIdsRef.current.has(n.id)) return
        firedIdsRef.current.add(n.id)
        // Cap at 500 entries to prevent unbounded growth in long sessions
        if (firedIdsRef.current.size > 500) {
          const arr = [...firedIdsRef.current]
          firedIdsRef.current = new Set(arr.slice(arr.length - 250))
        }
      }
      const NotificationApi = readNotificationApi()
      if (NotificationApi === undefined || NotificationApi.permission !== "granted") return
      try {
        if (localStorage.getItem(StorageKeys.desktopNotifications) !== "true") return
      } catch {
        return
      }

      const notification = new NotificationApi(n.title || "CodeCommit", {
        body: n.message,
        icon: "/favicon.ico"
      })

      notification.addEventListener("click", () => {
        window.focus()
        notification.close()
        navigateRef.current?.(desktopNotificationPath(n))
      })

      // Prevent GC from collecting the notification before user clicks
      activeRef.current.push(notification)
      setTimeout(() => {
        activeRef.current = activeRef.current.filter((x) => x !== notification)
      }, 30000)
    },
    []
  )

  return { notify }
}
