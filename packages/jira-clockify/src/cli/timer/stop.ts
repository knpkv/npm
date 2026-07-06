/**
 * Timer `stop` command.
 *
 * @module
 */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { Clock, Console, Duration, Effect, Option, SubscriptionRef } from "effect"
import type { QuitError } from "effect/Terminal"
import { Command, Flag as Options, Prompt } from "effect/unstable/cli"
import { ClockifyAuth } from "../../services/ClockifyAuth.js"
import { ConfigService } from "../../services/ConfigService.js"
import type { JiraWorklogOutcome, TimerError } from "../../services/TimerService.js"
import { TimerService } from "../../services/TimerService.js"
import { formatClock, formatDuration, parseDuration, parseStartTime, resolveCorrectedEnd } from "../../utils/time.js"
import { fetchTicketByKey, NOT_LOGGED_IN_HINT } from "../fetchTicket.js"

/** Final one-line Jira worklog status, including the reason a non-retried failure stuck. */
const worklogStatusLine = (outcome: JiraWorklogOutcome | null): string => {
  if (outcome === null) return "skipped"
  switch (outcome._tag) {
    case "Posted":
      return "✓"
    case "NotLoggedIn":
      return `✗ — not logged in (${NOT_LOGGED_IN_HINT})`
    case "Failed":
      return `✗ — ${outcome.message} (Clockify time saved; worklog not posted)`
  }
}

/**
 * Interactively resolve a Clockify project for the stop/correction flows.
 *
 * Returns the project to use, or `undefined` to leave it unset. No prompt is
 * shown when the project is already known (set on the running timer) or supplied
 * via `--project`; in that case the provided value is passed straight through.
 *
 * When prompting, offers a "save as default" follow-up exactly like the normal
 * stop path.
 */
export const resolveStopProject = (params: {
  readonly currentProjectId: string | null
  readonly flagProjectId: string | undefined
}): Effect.Effect<
  string | undefined,
  QuitError,
  ClockifyAuth | ClockifyApiClient | ConfigService | Prompt.Environment
> =>
  Effect.gen(function*() {
    if (params.currentProjectId || params.flagProjectId) return params.flagProjectId

    const clockifyAuth = yield* ClockifyAuth
    const clockifyClient = yield* ClockifyApiClient
    const auth = yield* clockifyAuth.getConfig.pipe(Effect.catch(() => Effect.succeed(null)))
    if (!auth) return undefined

    const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
      Effect.catch(() => Effect.succeed([]))
    )
    if (projects.length === 0) return undefined

    const selected = yield* Prompt.select({
      message: "No project set. Select Clockify project:",
      choices: [
        ...projects.map((p) => ({ title: p.name, value: p.id })),
        { title: "(skip)", value: "" }
      ]
    })
    if (!selected) return undefined

    const selectedName = projects.find((p) => p.id === selected)?.name ?? selected
    const saveDefault = yield* Prompt.select({
      message: `Save "${selectedName}" as default project?`,
      choices: [
        { title: "Yes", value: true },
        { title: "No", value: false }
      ]
    })
    if (saveDefault) {
      const cfg = yield* ConfigService
      yield* cfg.set({ defaultProjectId: selected, defaultProjectName: selectedName })
      yield* Console.log("Default project saved.")
    }
    return selected
  })

/**
 * Interactively resolve the billable flag for the stop/correction flows.
 *
 * Returns the billable value to use, or `undefined` to leave it unset. No prompt
 * is shown when billable was already set on the running timer (`currentBillable`
 * is non-null) or supplied via `--billable`; in that case the provided value is
 * passed straight through.
 *
 * When prompting, offers a "save as default" follow-up exactly like the normal
 * stop path.
 */
export const resolveStopBillable = (params: {
  readonly currentBillable: boolean | null
  readonly flagBillable: boolean | undefined
}): Effect.Effect<boolean | undefined, QuitError, ConfigService | Prompt.Environment> =>
  Effect.gen(function*() {
    if (params.currentBillable !== null || params.flagBillable !== undefined) return params.flagBillable

    const stopBillable = yield* Prompt.select({
      message: "Billable?",
      choices: [
        { title: "Yes", value: true },
        { title: "No", value: false }
      ]
    })

    const saveDefault = yield* Prompt.select({
      message: `Save billable=${stopBillable ? "yes" : "no"} as default?`,
      choices: [
        { title: "Yes", value: true },
        { title: "No", value: false }
      ]
    })
    if (saveDefault) {
      const cfg = yield* ConfigService
      yield* cfg.set({ defaultBillable: stopBillable })
      yield* Console.log("Default billable saved.")
    }
    return stopBillable
  })

export const stop = Command.make(
  "stop",
  {
    project: Options.string("project").pipe(
      Options.withAlias("p"),
      Options.withDescription("Clockify project ID"),
      Options.optional
    ),
    billable: Options.boolean("billable").pipe(
      Options.withAlias("b"),
      Options.withDescription("Mark as billable"),
      Options.optional
    ),
    at: Options.string("at").pipe(
      Options.withDescription(
        "Correct the end time (HH:MM today or ISO); a future HH:MM rolls back to yesterday. Skips the confirm."
      ),
      Options.optional
    )
  },
  ({ at, billable, project }) =>
    Effect.gen(function*() {
      const timer = yield* TimerService

      const flagProjectId = Option.isSome(project) ? project.value : undefined
      const flagBillable = Option.isSome(billable) ? billable.value : undefined
      const flagAt = Option.isSome(at) ? at.value : undefined

      // Correction flow: log a completed interval when no timer was ever started.
      // Reuses the same project/billable prompts as the normal stop path below.
      const runCorrection = Effect.gen(function*() {
        const proceed = yield* Prompt.select({
          message: "No active timer. Add a correction interval instead?",
          choices: [
            { title: "Yes", value: true },
            { title: "No", value: false }
          ]
        })
        if (!proceed) {
          yield* Console.log("No active timer.")
          return
        }

        const key = (yield* Prompt.text({ message: "Ticket key (e.g. PROJ-123):" })).trim()
        if (!key) {
          yield* Console.log("No ticket key given.")
          return
        }
        const fetched = yield* fetchTicketByKey(key)
        if (fetched._tag === "NotLoggedIn") {
          yield* Console.log(NOT_LOGGED_IN_HINT)
          return
        }
        if (fetched._tag === "NotFound") {
          yield* Console.log(`Ticket ${key} not found in Jira.`)
          return
        }
        if (fetched._tag === "FetchError") {
          yield* Console.log(`Failed to fetch ticket ${key}: ${fetched.message}`)
          return
        }
        const ticket = fetched.ticket

        const durationStr = yield* Prompt.text({ message: "Duration (e.g. 45m, 1h30m):" })
        const durationSeconds = parseDuration(durationStr)
        if (durationSeconds === null || durationSeconds < 60) {
          yield* Console.log("Invalid duration. Use format: 45m, 1h30m (minimum 1m).")
          return
        }

        const whenStr = (yield* Prompt.text({
          message: "Started at (HH:MM today or ISO, empty = ends now):"
        })).trim()
        let start: Date
        if (!whenStr) {
          const nowMs = yield* Clock.currentTimeMillis
          start = new Date(nowMs - durationSeconds * 1000)
        } else {
          const parsed = parseStartTime(whenStr)
          if (!parsed) {
            yield* Console.log("Invalid start time. Use HH:MM (today) or an ISO timestamp.")
            return
          }
          start = parsed
        }

        // Same interactive project/billable prompts as a normal stop (with
        // save-as-default). No running timer here, so there is nothing prefilled.
        const correctionProjectId = yield* resolveStopProject({ currentProjectId: null, flagProjectId })
        const correctionBillable = yield* resolveStopBillable({ currentBillable: null, flagBillable })

        const correctionComment = (yield* Prompt.text({ message: "Comment (empty to skip):" })).trim()

        yield* Console.log(`Correction: ${ticket.key} — ${ticket.summary}`)
        yield* Console.log(`  Duration: ${formatDuration(durationSeconds)}`)
        yield* Console.log(`  Started:  ${start.toISOString()}`)

        const result = yield* timer.logManual(ticket, {
          start,
          durationSeconds,
          projectId: correctionProjectId,
          billable: correctionBillable,
          comment: correctionComment || undefined
        }).pipe(
          Effect.catch((e: TimerError) => Console.log(`Error: ${e.message}`).pipe(Effect.as(null)))
        )

        if (result) {
          yield* Console.log(`  Clockify:     ${result.clockifyLogged ? "✓" : "✗"}`)
          yield* Console.log(`  Jira worklog: ${result.jiraWorklogLogged ? "✓" : "✗"}`)
        }
      })

      yield* timer.detectRunning

      // No running timer: offer to log a correction interval (forgot to start it).
      const detected = yield* SubscriptionRef.get(timer.state)
      if (!detected.active) {
        yield* runCorrection
        return
      }

      const currentTimer = yield* SubscriptionRef.get(timer.state)

      // End Correction (first, before project/billable/comment): confirm the end,
      // defaulting to "now". If the user forgot to stop, they correct it here. The
      // --at flag is Explicit Intent and skips the confirm. Resolved bounds live in
      // `resolveCorrectedEnd`; `now` is captured once so the confirm and re-prompt agree.
      const nowMs = yield* Clock.currentTimeMillis
      const now = new Date(nowMs)
      const startedAt = currentTimer.startedAt
      let endedAt: Date | undefined
      if (flagAt !== undefined) {
        const resolved = resolveCorrectedEnd({ start: startedAt ?? now, input: flagAt, now })
        if (!resolved.ok) {
          yield* Console.log(resolved.error)
          return
        }
        endedAt = resolved.end
      } else if (startedAt) {
        const elapsedSec = Math.max(0, Math.floor((nowMs - startedAt.getTime()) / 1000))
        const correct = yield* Prompt.confirm({
          message: `Started ${formatClock(startedAt)} · ends now ${formatClock(now)} (${
            formatDuration(elapsedSec)
          }) — end time correct?`,
          initial: true
        })
        if (!correct) {
          // Prompt.text re-runs `validate` until it succeeds, so this is the re-prompt loop.
          const entered = yield* Prompt.text({
            message: "Real end time (HH:MM today or ISO):",
            default: formatClock(now),
            validate: (value) => {
              const r = resolveCorrectedEnd({ start: startedAt, input: value, now })
              return r.ok ? Effect.succeed(value) : Effect.fail(r.error)
            }
          })
          const r = resolveCorrectedEnd({ start: startedAt, input: entered, now })
          if (r.ok) endedAt = r.end
        }
      }

      // Prompt for project if not set on start and not provided via flag.
      const stopProjectId = yield* resolveStopProject({ currentProjectId: currentTimer.projectId, flagProjectId })

      // Prompt for billable if not set.
      const stopBillable = yield* resolveStopBillable({ currentBillable: currentTimer.billable, flagBillable })

      // Optional comment for Jira worklog
      const comment = yield* Prompt.text({ message: "Comment (empty to skip):" })

      const result = yield* timer.stop({
        projectId: stopProjectId,
        billable: stopBillable,
        comment: comment.trim() || undefined,
        ...(endedAt ? { endedAt } : {})
      }).pipe(
        Effect.catch((e: TimerError) =>
          Console.log(`Error: ${e.message}`).pipe(Effect.flatMap(() => Effect.succeed(null)))
        )
      )

      if (result) {
        const secs = Duration.toSeconds(result.duration)
        const h = Math.floor(secs / 3600)
        const m = Math.floor((secs % 3600) / 60)
        const s = Math.floor(secs % 60)
        yield* Console.log(
          `Timer stopped: ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
        )
        if (endedAt) yield* Console.log(`  Ended at: ${formatClock(endedAt)} (corrected)`)
        yield* Console.log(`  Clockify: ${result.clockifyLogged ? "✓" : "✗"}`)

        // Clockify saved but the Jira worklog failed — show why, and offer to retry just the
        // worklog when it's retryable. The Clockify entry stays put, so retrying never double-logs.
        // `NotLoggedIn` can't be fixed by retrying, so we skip the loop and point at the login command.
        let outcome = result.jiraWorklog
        const worklog = result.worklog
        if (outcome?._tag === "Failed" && worklog) {
          yield* Console.log(`  Jira worklog: ✗ — ${outcome.message}`)
          let retry = yield* Prompt.confirm({ message: "  Retry Jira worklog?", initial: true })
          while (retry) {
            outcome = yield* timer.logWorklog(worklog)
            if (outcome._tag === "Posted" || outcome._tag === "NotLoggedIn") break
            yield* Console.log(`  Jira worklog: ✗ — ${outcome.message}`)
            // Default the re-prompt to No: if a retry just failed, don't keep nudging Yes.
            retry = yield* Prompt.confirm({ message: "  Retry again?", initial: false })
          }
        }
        yield* Console.log(`  Jira worklog: ${worklogStatusLine(outcome)}`)
      }
    })
)
