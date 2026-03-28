/**
 * Timer `start` command.
 *
 * @module
 */
import { Args, Command, Options, Prompt } from "@effect/cli"
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { JiraApiClient, toEffect } from "@knpkv/jira-api-client"
import { Console, Effect, Option, SubscriptionRef } from "effect"
import { ClockifyAuth } from "../../services/ClockifyAuth.js"
import { ConfigService } from "../../services/ConfigService.js"
import { TicketService } from "../../services/TicketService.js"
import { TimerService } from "../../services/TimerService.js"
import { fuzzySelect } from "../fuzzySelect.js"

export const start = Command.make(
  "start",
  {
    key: Args.text({ name: "key" }).pipe(Args.optional),
    project: Options.text("project").pipe(
      Options.withAlias("p"),
      Options.withDescription("Clockify project ID"),
      Options.optional
    ),
    billable: Options.boolean("billable").pipe(
      Options.withAlias("b"),
      Options.withDescription("Mark as billable"),
      Options.optional
    ),
    saveDefaults: Options.boolean("save-defaults").pipe(
      Options.withDescription("Save project/billable as defaults"),
      Options.withDefault(false)
    )
  },
  ({ billable, key, project, saveDefaults }) =>
    Effect.gen(function*() {
      const timer = yield* TimerService
      const ticketService = yield* TicketService
      const cfg = yield* ConfigService
      const clockifyAuth = yield* ClockifyAuth
      const clockifyClient = yield* ClockifyApiClient

      // Check for running timer
      yield* timer.detectRunning
      const currentState = yield* SubscriptionRef.get(timer.state)
      if (currentState.active && currentState.ticketKey) {
        const elapsed = currentState.startedAt
          ? Math.floor((Date.now() - currentState.startedAt.getTime()) / 1000)
          : 0
        const h = Math.floor(elapsed / 3600)
        const m = Math.floor((elapsed % 3600) / 60)
        const s = elapsed % 60
        yield* Console.log(
          `Timer running: ${currentState.ticketKey} — ${currentState.summary ?? ""} (${String(h).padStart(2, "0")}:${
            String(m).padStart(2, "0")
          }:${String(s).padStart(2, "0")})`
        )
        const action = yield* Prompt.select({
          message: "What to do?",
          choices: [
            { title: "Stop current and start new", value: "replace" as const },
            { title: "Keep current timer", value: "keep" as const }
          ]
        })
        if (action === "keep") return
      }

      // Refresh tickets for selection
      yield* ticketService.refresh
      yield* Effect.sleep("600 millis")
      const { tickets: allTickets } = yield* SubscriptionRef.get(ticketService.state)

      let ticket: typeof allTickets[number]

      if (key._tag === "None") {
        if (allTickets.length === 0) {
          yield* Console.log("No tickets found. Usage: jcf start PROJ-123")
          return
        }

        const selectedKey = yield* fuzzySelect({
          message: "Select ticket (/ to filter):",
          choices: allTickets.map((t) => ({
            title: `${t.key.padEnd(12)} ${t.summary.slice(0, 45).padEnd(45)} [${t.status}]`,
            value: t.key
          }))
        }).pipe(Effect.catchAll(() => Effect.succeed(null as string | null)))

        if (!selectedKey) return
        const found = allTickets.find((t) => t.key === selectedKey)
        if (!found) return
        ticket = found
      } else {
        // Key provided — fetch from Jira to validate and get title
        const jira = yield* JiraApiClient
        const issue = yield* toEffect(jira.v3.client.GET("/rest/api/3/issue/{issueIdOrKey}", {
          params: {
            path: { issueIdOrKey: key.value },
            query: { fields: ["summary", "status", "priority", "assignee", "issuetype", "labels"] }
          }
        })).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )
        if (!issue) {
          yield* Console.log(`Ticket ${key.value} not found in Jira.`)
          return
        }
        const fields = issue.fields as Record<string, unknown> | null | undefined
        const nested = (k: string, n: string) => {
          const v = fields?.[k]
          return v && typeof v === "object" && n in v ? (v as Record<string, unknown>)[n] : null
        }
        ticket = {
          key: issue.key ?? key.value,
          summary: (typeof fields?.["summary"] === "string" ? fields["summary"] : null) ?? key.value,
          status: (typeof nested("status", "name") === "string" ? nested("status", "name") as string : null) ??
            "Unknown",
          priority: typeof nested("priority", "name") === "string" ? nested("priority", "name") as string : null,
          assignee: typeof nested("assignee", "displayName") === "string"
            ? nested("assignee", "displayName") as string
            : null,
          type: (typeof nested("issuetype", "name") === "string" ? nested("issuetype", "name") as string : null) ??
            "Task",
          labels: Array.isArray(fields?.["labels"]) ? fields["labels"] as Array<string> : [],
          updated: (typeof fields?.["updated"] === "string" ? fields["updated"] : null) ?? new Date().toISOString()
        }
        yield* Console.log(`${ticket.key}: ${ticket.summary} [${ticket.status}]`)
      }

      // Resolve projectId
      let projectId: string | undefined = Option.isSome(project) ? project.value : undefined
      if (!projectId) {
        const config = yield* cfg.get
        if (config.defaultProjectId) {
          projectId = config.defaultProjectId
          yield* Console.log(`Using default project: ${config.defaultProjectName ?? config.defaultProjectId}`)
        } else {
          // Prompt: list projects
          const auth = yield* clockifyAuth.getConfig.pipe(Effect.catchAll(() => Effect.succeed(null)))
          if (auth) {
            const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
              Effect.catchAll(() => Effect.succeed([] as const))
            )
            if (projects.length > 0) {
              const selected = yield* Prompt.select({
                message: "Select Clockify project:",
                choices: [
                  ...projects.map((p) => ({ title: p.name, value: p.id })),
                  { title: "(skip)", value: "" }
                ]
              })
              if (selected) projectId = selected
            }
          }
        }
      }

      // Resolve billable
      let billableVal: boolean | undefined = Option.isSome(billable) ? billable.value : undefined
      if (billableVal === undefined) {
        const config = yield* cfg.get
        billableVal = config.defaultBillable
        yield* Console.log(`Billable: ${billableVal ? "yes" : "no"} (default)`)
      }

      // Save defaults if requested
      if (saveDefaults && (projectId || billableVal !== undefined)) {
        const auth = yield* clockifyAuth.getConfig.pipe(Effect.catchAll(() => Effect.succeed(null)))
        let projectName: string | null = null
        if (projectId && auth) {
          const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
            Effect.catchAll(() => Effect.succeed([] as const))
          )
          projectName = projects.find((p) => p.id === projectId)?.name ?? null
        }
        yield* cfg.set({
          ...(projectId ? { defaultProjectId: projectId, defaultProjectName: projectName } : {}),
          ...(billableVal !== undefined ? { defaultBillable: billableVal } : {})
        })
        yield* Console.log("Defaults saved to ~/.jcf/config.json")
      }

      yield* timer.start(ticket, { projectId, billable: billableVal }).pipe(
        Effect.catchAll((e) => Console.log(`Error: ${e.message}`))
      )

      yield* Console.log(`Timer started: ${ticket.key} — ${ticket.summary}`)
    })
)
