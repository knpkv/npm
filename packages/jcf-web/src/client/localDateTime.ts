type ResolvedLocalDateTime =
  | { readonly _tag: "Valid"; readonly instantMs: number }
  | { readonly _tag: "Invalid"; readonly reason: "invalid" | "nonexistent" | "ambiguous" }

const wallText = (formatter: Intl.DateTimeFormat, instantMs: number): string => {
  const fields = Object.fromEntries(formatter.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]))
  return `${fields["year"]}-${fields["month"]}-${fields["day"]}T${fields["hour"]}:${fields["minute"]}:${
    fields["second"]
  }`
}

/** Resolve a changed datetime-local value only when its wall clock names exactly one instant. */
export const resolveLocalDateTime = (value: string, timeZone: string): ResolvedLocalDateTime => {
  const wall = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)
    ? value.length === 16 ? `${value}:00` : value
    : null
  if (wall === null) return { _tag: "Invalid", reason: "invalid" }
  const naiveMs = Date.parse(`${wall}Z`)
  if (!Number.isFinite(naiveMs)) return { _tag: "Invalid", reason: "invalid" }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })
  const candidates = new Set<number>()
  for (const days of [-2, -1, 0, 1, 2]) {
    const sampleMs = naiveMs + days * 86_400_000
    const sampleWallMs = Date.parse(`${wallText(formatter, sampleMs)}Z`)
    const candidateMs = naiveMs - (sampleWallMs - sampleMs)
    if (wallText(formatter, candidateMs) === wall) candidates.add(candidateMs)
  }
  if (candidates.size === 0) return { _tag: "Invalid", reason: "nonexistent" }
  if (candidates.size !== 1) return { _tag: "Invalid", reason: "ambiguous" }
  const instantMs = candidates.values().next().value
  return instantMs === undefined
    ? { _tag: "Invalid", reason: "invalid" }
    : { _tag: "Valid", instantMs }
}
