/**
 * Formats date as DD.MM.YYYY
 */
export function formatDate(date: Date): string {
  const d = date.getDate().toString().padStart(2, "0")
  const m = (date.getMonth() + 1).toString().padStart(2, "0")
  const y = date.getFullYear()
  return `${d}.${m}.${y}`
}

/**
 * Formats date and time as DD.MM.YYYY HH:MM:SS
 */
export function formatDateTime(date: Date): string {
  const dStr = formatDate(date)
  const tStr = date.toLocaleTimeString("en-GB", { hour12: false })
  return `${dStr} ${tStr}`
}

export function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diff = Math.max(0, now.getTime() - date.getTime())
  const seconds = Math.floor(diff / 1000)

  if (seconds < 60) return `Updated ${seconds} seconds ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Updated ${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Updated ${hours} hours ago`
  return `Updated on ${formatDate(date)}`
}
