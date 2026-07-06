/**
 * localStorage keys used across the application.
 *
 * Centralizes all localStorage key constants: dialog dismissals
 * (dockerDismissed, grantedDismissed), theme, desktop notification
 * toggle, review reminder toggle, and reminder interval (ms).
 */
type StorageKeyMap = {
  readonly desktopNotifications: "codecommit:desktopNotifications"
  readonly dockerDismissed: "codecommit-docker-dismissed"
  readonly grantedDismissed: "codecommit-granted-dismissed"
  readonly reminderInterval: "codecommit:reminderInterval"
  readonly reminders: "codecommit:reminders"
  readonly theme: "codecommit-theme"
}

export const StorageKeys: StorageKeyMap = {
  dockerDismissed: "codecommit-docker-dismissed",
  grantedDismissed: "codecommit-granted-dismissed",
  theme: "codecommit-theme",
  desktopNotifications: "codecommit:desktopNotifications",
  reminders: "codecommit:reminders",
  reminderInterval: "codecommit:reminderInterval"
}
