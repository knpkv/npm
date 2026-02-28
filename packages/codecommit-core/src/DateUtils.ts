import { Match } from "effect"

export const formatDate = (date: Date): string => {
  const d = date.getDate().toString().padStart(2, "0")
  const m = (date.getMonth() + 1).toString().padStart(2, "0")
  const y = date.getFullYear()
  return `${d}.${m}.${y}`
}

export const formatDateTime = (date: Date): string => {
  const dStr = formatDate(date)
  const tStr = date.toLocaleTimeString("en-GB", { hour12: false })
  return `${dStr} ${tStr}`
}

export const formatRelativeTime = (date: Date, now: Date, prefix = "Updated"): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))

  return Match.value(seconds).pipe(
    Match.when((s) => s < 60, (s) => `${prefix} ${s}s ago`),
    Match.when((s) => s < 3600, (s) => `${prefix} ${Math.floor(s / 60)}m ago`),
    Match.when((s) => s < 86400, (s) => `${prefix} ${Math.floor(s / 3600)}h ago`),
    Match.orElse(() => `${prefix} on ${formatDate(date)}`)
  )
}
