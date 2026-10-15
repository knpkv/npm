/** Absolute time metadata for decoded review timestamps; no relative-age clock or fallback. @module */
import type { DateTime } from "effect"

/** Input has passed the workspace Timestamp bound; a named viewer zone is validated by the host. */
export const reviewReadingTime = (timestamp: number, timeZone: DateTime.TimeZone.Named | undefined) => {
  const date = new Date(timestamp)
  return {
    clock: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timeZone?.id }).format(
      date
    ),
    full: new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: timeZone?.id }).format(
      date
    ),
    iso: date.toISOString()
  }
}
