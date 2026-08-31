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
        const path = n.awsAccountId !== undefined &&
            n.awsAccountId !== "" &&
            n.pullRequestId !== undefined &&
            n.pullRequestId !== "" &&
            n.repositoryName !== undefined &&
            n.repositoryName !== "" &&
            n.accountRegion !== undefined &&
            n.accountRegion !== ""
          ? codeCommitPullRequestHref(n.awsAccountId, n.pullRequestId, n.repositoryName, n.accountRegion)
          : "/notifications"
        navigateRef.current?.(path)
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
