/**
 * `jcf reconcile` — compare Clockify time against Jira worklogs over a period and
 * fill gaps one row at a time.
 *
 * @module
 */
import { Console, Effect, Option } from "effect"
import { Argument as Args, Command, Flag as Options, Prompt } from "effect/unstable/cli"
import {
  type ReconcileDirection,
  type ReconcilePeriod,
  type ReconcileRow,
  ReconcileService
} from "../services/ReconcileService.js"
import { formatDuration } from "../utils/time.js"
import { NOT_LOGGED_IN_HINT } from "./fetchTicket.js"

// Differences under a minute are noise (Jira floors worklogs to 60s), so don't flag them.
const TOLERANCE_SECONDS = 60

/** Start of a local calendar day `YYYY-MM-DD` (00:00 local). */
const startOfDay = (day: string): Date => new Date(`${day}T00:00:00`)

const localDay = (date: Date): string => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

const isYmd = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)

/**
 * Resolve the reconcile window from flags (local-day aligned, half-open `[from, to)`):
 * `--since/--until` (custom) wins, else `--week` (last 7 days incl. today), else today.
 */
export const resolvePeriod = (opts: {
  readonly week: boolean
  readonly since: string | undefined
  readonly until: string | undefined
}): ReconcilePeriod | { readonly error: string } => {
  const today = new Date()
  const endExclusive = (day: string) => new Date(startOfDay(day).getTime() + 24 * 60 * 60 * 1000)

  if (opts.since !== undefined || opts.until !== undefined) {
    const fromDay = opts.since ?? localDay(today)
    const toDay = opts.until ?? localDay(today)
    if (!isYmd(fromDay) || !isYmd(toDay)) return { error: "Use --since/--until as YYYY-MM-DD." }
    if (fromDay > toDay) return { error: "--since must be on or before --until." }
    return { from: startOfDay(fromDay), to: endExclusive(toDay) }
  }
  if (opts.week) {
    const from = new Date(startOfDay(localDay(today)).getTime() - 6 * 24 * 60 * 60 * 1000)
    return { from, to: endExclusive(localDay(today)) }
  }
  return { from: startOfDay(localDay(today)), to: endExclusive(localDay(today)) }
}

/** `+Xs` worth of work the *target* is missing for this row, or 0 if it's not short. */
export const deltaToApply = (row: ReconcileRow, direction: ReconcileDirection): number => {
  const delta = direction === "clockify-to-jira"
    ? row.clockifySeconds - row.jiraSeconds
    : row.jiraSeconds - row.clockifySeconds
  return delta >= TOLERANCE_SECONDS ? delta : 0
}

const sign = (n: number): string => (n > 0 ? `+${formatDuration(n)}` : n < 0 ? `-${formatDuration(-n)}` : "0")

export const reconcile = Command.make(
  "reconcile",
  {
    direction: Args.string("direction").pipe(Args.optional),
    week: Options.boolean("week").pipe(
      Options.withDescription("Reconcile the last 7 days (default: today)"),
      Options.withDefault(false)
    ),
    day: Options.boolean("day").pipe(
      Options.withDescription("Reconcile today (the default)"),
      Options.withDefault(false)
    ),
    since: Options.string("since").pipe(
      Options.withDescription("Start of a custom window, YYYY-MM-DD"),
      Options.optional
    ),
    until: Options.string("until").pipe(
      Options.withDescription("End of a custom window (inclusive), YYYY-MM-DD"),
      Options.optional
    )
  },
  ({ direction, since, until, week }) =>
    Effect.gen(function*() {
      const dir = Option.isSome(direction) ? direction.value : "clockify-to-jira"
      if (dir !== "clockify-to-jira" && dir !== "jira-to-clockify") {
        yield* Console.log("Usage: jcf reconcile [clockify-to-jira|jira-to-clockify] [--day|--week|--since|--until]")
        return
      }
      const directionTag: ReconcileDirection = dir

      const period = resolvePeriod({
        week,
        since: Option.isSome(since) ? since.value : undefined,
        until: Option.isSome(until) ? until.value : undefined
      })
      if ("error" in period) {
        yield* Console.log(period.error)
        return
      }

      const svc = yield* ReconcileService
      const rows = yield* svc.compare(period).pipe(
        Effect.catch((e) => Console.log(`Reconcile failed: ${e.message}`).pipe(Effect.as(null)))
      )
      if (rows === null) return

      const fromDay = localDay(period.from)
      const toDay = localDay(new Date(period.to.getTime() - 1))
      yield* Console.log(
        `Reconcile ${directionTag}  (${fromDay === toDay ? fromDay : `${fromDay}..${toDay}`})`
      )

      if (rows.length === 0) {
        yield* Console.log("  No time logged on either side for this period.")
        return
      }

      // Report every bucket, marking the gap relative to the chosen target.
      for (const row of rows) {
        const delta = row.clockifySeconds - row.jiraSeconds
        const mark = Math.abs(delta) < TOLERANCE_SECONDS ? "=" : "Δ"
        yield* Console.log(
          `  ${row.day}  ${row.ticketKey.padEnd(12)} Clockify ${formatDuration(row.clockifySeconds).padStart(6)}` +
            `  Jira ${formatDuration(row.jiraSeconds).padStart(6)}  ${mark} ${sign(delta)}`
        )
      }

      const fixable = rows.filter((r) => deltaToApply(r, directionTag) > 0)
      if (fixable.length === 0) {
        yield* Console.log(
          directionTag === "clockify-to-jira"
            ? "  Jira is in sync with Clockify (nothing to add)."
            : "  Clockify is in sync with Jira (nothing to add)."
        )
        return
      }

      const target = directionTag === "clockify-to-jira" ? "Jira" : "Clockify"
      yield* Console.log(`\n  ${fixable.length} row(s) where ${target} is short — confirm each fix:`)

      for (const row of fixable) {
        const delta = deltaToApply(row, directionTag)
        const apply = yield* Prompt.confirm({
          message: `  Add ${formatDuration(delta)} to ${target} for ${row.ticketKey} on ${row.day}?`,
          initial: true
        })
        if (!apply) continue

        if (directionTag === "clockify-to-jira") {
          const outcome = yield* svc.applyToJira(row.ticketKey, row.day, delta)
          if (outcome._tag === "Posted") {
            yield* Console.log(`    ✓ posted to Jira`)
          } else if (outcome._tag === "NotLoggedIn") {
            yield* Console.log(`    ✗ ${NOT_LOGGED_IN_HINT}`)
            return // no point continuing — every Jira write will fail
          } else {
            yield* Console.log(`    ✗ ${outcome.message}`)
          }
        } else {
          const ok = yield* svc.applyToClockify(row.ticketKey, row.day, delta).pipe(
            Effect.catch((e) => Console.log(`    ✗ ${e.message}`).pipe(Effect.as(false)))
          )
          if (ok) yield* Console.log(`    ✓ created Clockify entry`)
        }
      }
    })
)
