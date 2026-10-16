import * as DateTime from "effect/DateTime"

/**
 * A recorded instant with its year, in UTC, as status lines show it: "11 Oct 2026, 13:59 UTC".
 * Pair it with `DateTime.formatIso` in a `<time dateTime>` so the exact instant stays machine-readable.
 */
export const formatCheckTime = (timestamp: DateTime.Utc): string =>
  DateTime.formatUtc(timestamp, {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    locale: "en-GB",
    minute: "2-digit",
    month: "short",
    timeZoneName: "short",
    year: "numeric"
  })
