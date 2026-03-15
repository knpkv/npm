/**
 * Periodic reminder for PRs awaiting current user's review.
 *
 * **Mental model**
 *
 * - Reads enabled + interval from localStorage
 * - Fires grouped toast + desktop notification at interval
 * - Only when pendingReviewCount > 0
 * - One reminder per interval regardless of PR count
 *
 * @module
 */
import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { StorageKeys } from "../storage-keys.js"

const DEFAULT_INTERVAL = 60 * 60 * 1000 // 1 hour

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === "true"
  } catch {
    return fallback
  }
}

function readNumber(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : Number(v) || fallback
  } catch {
    return fallback
  }
}

export function useReviewReminder(pendingReviewCount: number) {
  const countRef = useRef(pendingReviewCount)
  countRef.current = pendingReviewCount

  useEffect(() => {
    const check = () => {
      const enabled = readBool(StorageKeys.reminders, true)
      if (!enabled || countRef.current === 0) return

      toast(`You have ${countRef.current} PR${countRef.current > 1 ? "s" : ""} awaiting your review`, {
        duration: 10000
      })

      // Desktop notification if enabled
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        readBool(StorageKeys.desktopNotifications, false)
      ) {
        new Notification("Review Reminder", {
          body: `${countRef.current} PR${countRef.current > 1 ? "s" : ""} awaiting your review`,
          icon: "/favicon.ico",
          tag: "review-reminder"
        })
      }
    }

    const interval = readNumber(StorageKeys.reminderInterval, DEFAULT_INTERVAL)
    const timer = setInterval(check, interval)
    return () => clearInterval(timer)
  }, [])
}
