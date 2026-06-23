/**
 * Timer `start` command.
 *
 * @module
 */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { Console, Effect, Option, SubscriptionRef } from "effect"
import { Argument as Args, Command, Flag as Options, Prompt } from "effect/unstable/cli"
import { ClockifyAuth } from "../../services/ClockifyAuth.js"
import { ConfigService } from "../../services/ConfigService.js"
import { TicketService } from "../../services/TicketService.js"
import { TimerService } from "../../services/TimerService.js"
import { formatElapsed, parseDuration, parseStartTime } from "../../utils/time.js"
import { fetchTicketByKey } from "../fetchTicket.js"
import { fuzzySelect } from "../fuzzySelect.js"

export const start = Command.make(
  "start",
  {
    key: Args.string("key").pipe(Args.optional),
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
    saveDefaults: Options.boolean("save-defaults").pipe(
      Options.withDescription("Save project/billable as defaults"),
      Options.withDefault(false)
    ),
    ago: Options.string("ago").pipe(
      Options.withAlias("a"),
      Options.withDescription("Backdate the start by a duration (e.g. 15m, 1h30m) — corrects a forgotten start"),
      Options.optional
    ),
    since: Options.string("since").pipe(
      Options.withDescription("Backdate the start to a past time today (HH:MM) or an ISO timestamp"),
      Options.optional
    )
  },
  ({ ago, billable, key, project, saveDefaults, since }) =>
    Effect.gen(function*() {
      const timer = yield* TimerService
      const ticketService = yield* TicketService
      const cfg = yield* ConfigService
      const clockifyAuth = yield* ClockifyAuth
      const clockifyClient = yield* ClockifyApiClient

      // Resolve a backdated start, if requested. --ago wins over --since.
      let startedAt: Date | undefined
      if (Option.isSome(ago)) {
        const secs = parseDuration(ago.value)
        if (secs === null) {
          yield* Console.log("Invalid --ago. Use a duration like 15m, 1h, 1h30m.")
          return
        }
        if (secs <= 0) {
          yield* Console.log("--ago must be greater than zero (e.g. 15m, 1h).")
          return
        }
        startedAt = new Date(Date.now() - secs * 1000)
      } else if (Option.isSome(since)) {
        const parsed = parseStartTime(since.value)
        if (!parsed) {
          yield* Console.log("Invalid --since. Use HH:MM (today) or an ISO timestamp.")
          return
        }
        if (parsed.getTime() > Date.now()) {
          yield* Console.log("--since is in the future. Pick a time at or before now.")
          return
        }
        startedAt = parsed
      }

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
        }).pipe(Effect.catch(() => Effect.succeed(null as string | null)))

        if (!selectedKey) return
        const found = allTickets.find((t) => t.key === selectedKey)
        if (!found) return
        ticket = found
      } else {
        // Key provided — fetch from Jira to validate and get title
        const fetched = yield* fetchTicketByKey(key.value)
        if (fetched._tag === "NotFound") {
          yield* Console.log(`Ticket ${key.value} not found in Jira.`)
          return
        }
        if (fetched._tag === "FetchError") {
          yield* Console.log(`Failed to fetch ticket ${key.value}: ${fetched.message}`)
          return
        }
        ticket = fetched.ticket
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
          const auth = yield* clockifyAuth.getConfig.pipe(Effect.catch(() => Effect.succeed(null)))
          if (auth) {
            const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
              Effect.catch(() => Effect.succeed([] as const))
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
        const auth = yield* clockifyAuth.getConfig.pipe(Effect.catch(() => Effect.succeed(null)))
        let projectName: string | null = null
        if (projectId && auth) {
          const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
            Effect.catch(() => Effect.succeed([] as const))
          )
          projectName = projects.find((p) => p.id === projectId)?.name ?? null
        }
        yield* cfg.set({
          ...(projectId ? { defaultProjectId: projectId, defaultProjectName: projectName } : {}),
          ...(billableVal !== undefined ? { defaultBillable: billableVal } : {})
        })
        yield* Console.log("Defaults saved to ~/.jcf/config.json")
      }

      yield* timer.start(ticket, { projectId, billable: billableVal, startedAt }).pipe(
        Effect.catch((e) => Console.log(`Error: ${e.message}`))
      )

      const startedSuffix = startedAt
        ? ` (started ${formatElapsed(Math.floor((Date.now() - startedAt.getTime()) / 1000))} ago)`
        : ""
      yield* Console.log(`Timer started: ${ticket.key} — ${ticket.summary}${startedSuffix}`)
    })
)
