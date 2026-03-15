/**
 * localStorage keys used across the application.
 *
 * Centralizes all localStorage key constants: dialog dismissals
 * (dockerDismissed, grantedDismissed), theme, desktop notification
 * toggle, review reminder toggle, and reminder interval (ms).
 */
export const StorageKeys = {
  dockerDismissed: "codecommit-docker-dismissed",
  grantedDismissed: "codecommit-granted-dismissed",
  theme: "codecommit-theme",
  desktopNotifications: "codecommit:desktopNotifications",
  reminders: "codecommit:reminders",
  reminderInterval: "codecommit:reminderInterval"
} as const
