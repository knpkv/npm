/**
 * Timer `log` command — add a completed interval manually (no running timer).
 *
 * @module
 */
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Option } from "effect"
import { TimerService } from "../../services/TimerService.js"
import { formatDuration, isFullIsoTimestamp, parseDuration, parseStartTime } from "../../utils/time.js"
import { fetchTicketByKey } from "../fetchTicket.js"

/** Today's calendar day in the user's *local* timezone as `YYYY-MM-DD`. */
const localToday = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export const log = Command.make(
  "log",
  {
    key: Args.text({ name: "key" }),
    time: Options.text("time").pipe(Options.withAlias("t"), Options.withDescription("Duration (e.g. 1h30m, 2h, 45m)")),
    date: Options.text("date").pipe(
      Options.withAlias("d"),
      Options.withDescription("Date (YYYY-MM-DD, default today)"),
      Options.optional
    ),
    at: Options.text("at").pipe(
      Options.withDescription("Start time on that date (HH:MM, default 09:00)"),
      Options.optional
    ),
    comment: Options.text("comment").pipe(
      Options.withAlias("c"),
      Options.withDescription("Worklog comment"),
      Options.optional
    )
  },
  ({ at, comment, date, key, time }) =>
    Effect.gen(function*() {
      const totalSeconds = parseDuration(time)
      if (totalSeconds === null || totalSeconds < 60) {
        yield* Console.log("Invalid duration. Use format: 1h30m, 2h, 45m (minimum 1m).")
        return
      }

      // A full ISO `--at` carries its own date — combining it with `--date` is
      // ambiguous (which date wins?), so reject the conflict explicitly.
      if (Option.isSome(at) && isFullIsoTimestamp(at.value) && Option.isSome(date)) {
        yield* Console.log("--at is a full ISO timestamp; drop --date (it conflicts).")
        return
      }

      // Parse date + start time → start instant. Default date is the *local*
      // calendar day, and the date base is parsed at local midnight so the
      // HH:MM `--at` lands on the intended local clock time.
      const dateStr = Option.isSome(date) ? date.value : localToday()
      const timeStr = Option.isSome(at) ? at.value : "09:00"
      const started = parseStartTime(timeStr, new Date(`${dateStr}T00:00:00`))
      if (!started || isNaN(started.getTime())) {
        yield* Console.log("Invalid date/time. Use --date YYYY-MM-DD and --at HH:MM.")
        return
      }

      // Validate ticket exists
      const fetched = yield* fetchTicketByKey(key)
      if (fetched._tag === "NotFound") {
        yield* Console.log(`Ticket ${key} not found in Jira.`)
        return
      }
      if (fetched._tag === "FetchError") {
        yield* Console.log(`Failed to fetch ticket ${key}: ${fetched.message}`)
        return
      }
      const ticket = fetched.ticket

      yield* Console.log(`Logging: ${ticket.key} — ${ticket.summary}`)
      yield* Console.log(`  Duration: ${formatDuration(totalSeconds)} (${totalSeconds}s)`)
      yield* Console.log(`  Started:  ${started.toISOString()}`)

      const timer = yield* TimerService
      const result = yield* timer.logManual(ticket, {
        start: started,
        durationSeconds: totalSeconds,
        comment: Option.isSome(comment) ? comment.value : undefined
      }).pipe(
        Effect.catchAll((e) => Console.log(`Error: ${e.message}`).pipe(Effect.as(null)))
      )

      if (result) {
        yield* Console.log(`  Clockify:     ${result.clockifyLogged ? "✓" : "✗"}`)
        yield* Console.log(`  Jira worklog: ${result.jiraWorklogLogged ? "✓" : "✗"}`)
      }
    })
)
