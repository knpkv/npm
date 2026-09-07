/**
 * How the page says times and amounts.
 *
 * Every duration and clock reading comes from the engine's own formatters, so a row here reads the
 * way the same row reads in a terminal. A second set of rules would be a second set of rounding.
 *
 * @module
 */
import { formatClock, formatDuration } from "@knpkv/jira-clockify/utils/time.js"

export { formatClock, formatDuration }

/** `1h 23m`, or an em dash for nothing at all — a grid of zeroes is unreadable. */
export const duration = (seconds: number): string => (seconds <= 0 ? "—" : formatDuration(seconds))

/** `HH:MM–HH:MM`, the shape a timesheet asks for. */
export const spanRange = (span: { readonly startMs: number; readonly endMs: number }): string =>
  `${formatClock(new Date(span.startMs))}–${formatClock(new Date(span.endMs))}`

const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** `Mon 16` for a column heading. Parsed as a local day, which is what every bucket is keyed by. */
export const dayHeading = (day: string): { readonly weekday: string; readonly date: string } => {
  const at = new Date(`${day}T00:00:00`)
  return { date: String(at.getDate()), weekday: weekdayNames[(at.getDay() + 6) % 7] ?? "" }
}

/** `16–22 June 2025`, or `30 June – 6 July 2025` when the week straddles a month. */
export const weekLabel = (days: ReadonlyArray<string>): string => {
  const first = days[0]
  const last = days[days.length - 1]
  if (first === undefined || last === undefined) return ""
  const from = new Date(`${first}T00:00:00`)
  const to = new Date(`${last}T00:00:00`)
  const month = (at: Date) => at.toLocaleDateString(undefined, { month: "long" })
  const sameMonth = from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear()
  return sameMonth
    ? `${from.getDate()}–${to.getDate()} ${month(to)} ${to.getFullYear()}`
    : `${from.getDate()} ${month(from)} – ${to.getDate()} ${month(to)} ${to.getFullYear()}`
}

/** The Monday one week either side, for the pager. */
export const shiftWeek = (monday: string, weeks: number): string => {
  const at = new Date(`${monday}T00:00:00`)
  const moved = new Date(at.getFullYear(), at.getMonth(), at.getDate() + weeks * 7, 0, 0, 0, 0)
  const month = String(moved.getMonth() + 1).padStart(2, "0")
  return `${moved.getFullYear()}-${month}-${String(moved.getDate()).padStart(2, "0")}`
}

/**
 * `1h 30m` when both sides are short by the same amount, `+1h 30m Clockify, +1h Jira` when they are
 * not. The engine's own wording, so a button and a terminal line describe one write identically.
 */
export { proposalTargets } from "@knpkv/jira-clockify/cli/agentWrite.js"

/** `45m` typed as `45m`, `1h30m`, or `90m`. Null when it is not a duration at all. */
export { parseDuration } from "@knpkv/jira-clockify/utils/time.js"

/** What the attribution signal means, in one phrase, for a reader deciding whether to trust a row. */
export const signalMeaning: Readonly<Record<string, string>> = {
  agent: "a Coding Agent read the transcript",
  branch: "the git branch names this ticket",
  none: "nothing placed this work",
  path: "the working directory names this ticket",
  standing: "a Standing Attribution maps this directory"
}
