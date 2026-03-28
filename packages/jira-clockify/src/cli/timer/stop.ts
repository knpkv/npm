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
import { TimerService } from "../../services/TimerService.js"

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
      yield* timer.detectRunning

      // Check if project/billable need to be set
      const currentTimer = yield* SubscriptionRef.get(timer.state)
      const current = { projectId: currentTimer.projectId, billable: currentTimer.billable }

      let stopProjectId: string | undefined = Option.isSome(project) ? project.value : undefined
      let stopBillable: boolean | undefined = Option.isSome(billable) ? billable.value : undefined

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
        Effect.catchAll((e: { readonly message: string }) =>
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
