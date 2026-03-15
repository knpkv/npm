/**
 * Settings: notifications tab — desktop notifications + review reminders.
 *
 * Provides toggles for desktop browser notifications (with
 * `Notification.permission` flow) and periodic review reminders
 * (30m/1h/2h/4h interval selector). All settings persist in
 * localStorage via {@link StorageKeys}. Uses `role="switch"` +
 * `aria-checked` and `aria-pressed` for accessibility.
 *
 * @module
 */
import { BellIcon, ClockIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { StorageKeys } from "../storage-keys.js"
import { Badge } from "./ui/badge.js"
import { Separator } from "./ui/separator.js"

const readBool = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === "true"
  } catch {
    return fallback
  }
}

const readNumber = (key: string, fallback: number) => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : Number(v) || fallback
  } catch {
    return fallback
  }
}

const INTERVALS = [
  { label: "30 min", ms: 30 * 60 * 1000 },
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "2 hours", ms: 2 * 60 * 60 * 1000 },
  { label: "4 hours", ms: 4 * 60 * 60 * 1000 }
]

export function SettingsNotifications() {
  const [desktopEnabled, setDesktopEnabled] = useState(() => readBool(StorageKeys.desktopNotifications, false))
  const [remindersEnabled, setRemindersEnabled] = useState(() => readBool(StorageKeys.reminders, true))
  const [reminderInterval, setReminderInterval] = useState(() =>
    readNumber(StorageKeys.reminderInterval, 60 * 60 * 1000)
  )
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  )

  const toggleDesktop = useCallback(async () => {
    if (!desktopEnabled && permission === "default") {
      const result = await Notification.requestPermission()
      setPermission(result)
      if (result !== "granted") return
    }
    const next = !desktopEnabled
    setDesktopEnabled(next)
    localStorage.setItem(StorageKeys.desktopNotifications, String(next))
  }, [desktopEnabled, permission])

  const toggleReminders = useCallback(() => {
    const next = !remindersEnabled
    setRemindersEnabled(next)
    localStorage.setItem(StorageKeys.reminders, String(next))
  }, [remindersEnabled])

  const selectInterval = useCallback((ms: number) => {
    setReminderInterval(ms)
    localStorage.setItem(StorageKeys.reminderInterval, String(ms))
  }, [])

  // Sync permission state on focus (user might change in OS settings)
  useEffect(() => {
    const onFocus = () => {
      if (typeof Notification !== "undefined") setPermission(Notification.permission)
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [])

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="text-sm text-muted-foreground">Desktop notifications and review reminders</p>
      </div>
      <Separator />

      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <BellIcon className="size-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Desktop Notifications</p>
              <p className="text-xs text-muted-foreground">
                {permission === "unsupported"
                  ? "Not available in this browser"
                  : permission === "denied"
                    ? "Blocked by browser — enable in site settings"
                    : "Show browser notifications for approval requests and PR updates"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {permission === "granted" && (
              <Badge variant="outline" className="text-xs">
                Granted
              </Badge>
            )}
            <button
              role="switch"
              aria-checked={desktopEnabled}
              onClick={toggleDesktop}
              disabled={permission === "unsupported" || permission === "denied"}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                desktopEnabled ? "bg-primary" : "bg-muted"
              } ${
                permission === "unsupported" || permission === "denied"
                  ? "opacity-50 cursor-not-allowed"
                  : "cursor-pointer"
              }`}
            >
              <span
                className={`inline-block size-4 rounded-full bg-white transition-transform ${
                  desktopEnabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <ClockIcon className="size-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Review Reminders</p>
              <p className="text-xs text-muted-foreground">Periodic reminders for PRs awaiting your review</p>
            </div>
          </div>
          <button
            role="switch"
            aria-checked={remindersEnabled}
            onClick={toggleReminders}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
              remindersEnabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block size-4 rounded-full bg-white transition-transform ${
                remindersEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {remindersEnabled && (
          <div className="rounded-lg border p-4">
            <p className="text-sm font-medium mb-2">Reminder Interval</p>
            <div className="flex gap-2">
              {INTERVALS.map((opt) => (
                <button
                  key={opt.ms}
                  aria-pressed={reminderInterval === opt.ms}
                  onClick={() => selectInterval(opt.ms)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    reminderInterval === opt.ms
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
