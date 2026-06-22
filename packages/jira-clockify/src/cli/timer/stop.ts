/**
 * Timer `stop` command.
 *
 * @module
 */
import { Command, Options, Prompt } from "@effect/cli"
import type { QuitException, Terminal } from "@effect/platform/Terminal"
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { Console, Duration, Effect, Option, SubscriptionRef } from "effect"
import { ClockifyAuth } from "../../services/ClockifyAuth.js"
import { ConfigService } from "../../services/ConfigService.js"
import type { TimerError } from "../../services/TimerService.js"
import { TimerService } from "../../services/TimerService.js"
import { formatDuration, parseDuration, parseStartTime } from "../../utils/time.js"
import { fetchTicketByKey } from "../fetchTicket.js"

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
}): Effect.Effect<string | undefined, QuitException, ClockifyAuth | ClockifyApiClient | ConfigService | Terminal> =>
  Effect.gen(function*() {
    if (params.currentProjectId || params.flagProjectId) return params.flagProjectId

    const clockifyAuth = yield* ClockifyAuth
    const clockifyClient = yield* ClockifyApiClient
    const auth = yield* clockifyAuth.getConfig.pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (!auth) return undefined

    const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
      Effect.catchAll(() => Effect.succeed([] as const))
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
}): Effect.Effect<boolean | undefined, QuitException, ConfigService | Terminal> =>
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
    project: Options.text("project").pipe(
      Options.withAlias("p"),
      Options.withDescription("Clockify project ID"),
      Options.optional
    ),
    billable: Options.boolean("billable").pipe(
      Options.withAlias("b"),
      Options.withDescription("Mark as billable"),
      Options.optional
    )
  },
  ({ billable, project }) =>
    Effect.gen(function*() {
      const timer = yield* TimerService

      const flagProjectId = Option.isSome(project) ? project.value : undefined
      const flagBillable = Option.isSome(billable) ? billable.value : undefined

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
          start = new Date(Date.now() - durationSeconds * 1000)
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
          Effect.catchAll((e: TimerError) => Console.log(`Error: ${e.message}`).pipe(Effect.as(null)))
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

      // Check if project/billable need to be set
      const currentTimer = yield* SubscriptionRef.get(timer.state)
      const current = { projectId: currentTimer.projectId, billable: currentTimer.billable }

      // Prompt for project if not set on start and not provided via flag.
      const stopProjectId = yield* resolveStopProject({ currentProjectId: current.projectId, flagProjectId })

      // Prompt for billable if not set.
      const stopBillable = yield* resolveStopBillable({ currentBillable: current.billable, flagBillable })

      // Optional comment for Jira worklog
      const comment = yield* Prompt.text({ message: "Comment (empty to skip):" })

      const result = yield* timer.stop({
        projectId: stopProjectId,
        billable: stopBillable,
        comment: comment.trim() || undefined
      }).pipe(
        Effect.catchAll((e: TimerError) =>
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
        yield* Console.log(`  Clockify: ${result.clockifyLogged ? "✓" : "✗"}`)
        yield* Console.log(`  Jira worklog: ${result.jiraWorklogLogged ? "✓" : "skipped"}`)
      }
    })
)
