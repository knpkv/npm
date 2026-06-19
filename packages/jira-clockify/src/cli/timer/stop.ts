/**
 * Timer `stop` command.
 *
 * @module
 */
import { Command, Options, Prompt } from "@effect/cli"
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { Console, Duration, Effect, Option, SubscriptionRef } from "effect"
import { ClockifyAuth } from "../../services/ClockifyAuth.js"
import { ConfigService } from "../../services/ConfigService.js"
import type { TimerError } from "../../services/TimerService.js"
import { TimerService } from "../../services/TimerService.js"
import { formatDuration, parseDuration, parseStartTime } from "../../utils/time.js"
import { fetchTicketByKey } from "../fetchTicket.js"

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
      // TODO(review #20): correction can't pick project/billable interactively —
      // it only forwards --project/--billable flags. Deferred: reusing the rich
      // project-selection + save-as-default prompts (the normal stop branch
      // below) needs them extracted into a shared helper, a larger refactor.
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

        const correctionComment = (yield* Prompt.text({ message: "Comment (empty to skip):" })).trim()

        yield* Console.log(`Correction: ${ticket.key} — ${ticket.summary}`)
        yield* Console.log(`  Duration: ${formatDuration(durationSeconds)}`)
        yield* Console.log(`  Started:  ${start.toISOString()}`)

        const result = yield* timer.logManual(ticket, {
          start,
          durationSeconds,
          projectId: flagProjectId,
          billable: flagBillable,
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

      let stopProjectId: string | undefined = flagProjectId
      let stopBillable: boolean | undefined = flagBillable

      // Prompt for project if not set on start and not provided via flag
      if (!current.projectId && !stopProjectId) {
        const clockifyAuth = yield* ClockifyAuth
        const clockifyClient = yield* ClockifyApiClient
        const auth = yield* clockifyAuth.getConfig.pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (auth) {
          const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
            Effect.catchAll(() => Effect.succeed([] as const))
          )
          if (projects.length > 0) {
            const selected = yield* Prompt.select({
              message: "No project set. Select Clockify project:",
              choices: [
                ...projects.map((p) => ({ title: p.name, value: p.id })),
                { title: "(skip)", value: "" }
              ]
            })
            if (selected) {
              stopProjectId = selected
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
                yield* cfg.set({ defaultProjectId: stopProjectId, defaultProjectName: selectedName })
                yield* Console.log("Default project saved.")
              }
            }
          }
        }
      }

      // Prompt for billable if not set
      if (current.billable === null && stopBillable === undefined) {
        stopBillable = yield* Prompt.select({
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
      }

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
