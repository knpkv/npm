/**
 * Config commands: show, set (project/billable/jql), reset.
 *
 * @module
 */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { Console, Effect } from "effect"
import { Argument as Args, Command, Prompt } from "effect/unstable/cli"
import { ClockifyAuth } from "../services/ClockifyAuth.js"
import { ConfigService } from "../services/ConfigService.js"

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

const configShow = Command.make(
  "show",
  {},
  () =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      const config = yield* cfg.get
      yield* Console.log("~/.jcf/config.json:")
      yield* Console.log("")
      yield* Console.log(`  Default JQL:     ${config.defaultJql}`)
      yield* Console.log(`  Refresh (sec):   ${config.refreshInterval}`)
      yield* Console.log(`  Default project: ${config.defaultProjectName ?? config.defaultProjectId ?? "(none)"}`)
      yield* Console.log(`  Default billable:${config.defaultBillable ? " yes" : " no"}`)
      yield* Console.log(`  Project map:     ${JSON.stringify(config.projectMap)}`)
    })
)

// ---------------------------------------------------------------------------
// set subcommands
// ---------------------------------------------------------------------------

const configSetProject = Command.make(
  "project",
  {},
  () =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      const clockifyAuth = yield* ClockifyAuth
      const clockifyClient = yield* ClockifyApiClient
      const auth = yield* clockifyAuth.getConfig.pipe(Effect.catch(() => Effect.succeed(null)))
      if (!auth) {
        yield* Console.log("Clockify not configured. Run: jcf auth clockify setup")
        return
      }
      const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
        Effect.catch(() => Effect.succeed([] as const))
      )
      if (projects.length === 0) {
        yield* Console.log("No projects found in Clockify workspace.")
        return
      }
      const selected = yield* Prompt.select({
        message: "Default project:",
        choices: [
          ...projects.map((p) => ({ title: p.name, value: p.id })),
          { title: "(none)", value: "" }
        ]
      })
      if (selected) {
        const name = projects.find((p) => p.id === selected)?.name ?? null
        yield* cfg.set({ defaultProjectId: selected, defaultProjectName: name })
        yield* Console.log(`Default project: ${name ?? selected}`)
      } else {
        yield* cfg.set({ defaultProjectId: null, defaultProjectName: null })
        yield* Console.log("Default project cleared.")
      }
    })
)

const configSetBillable = Command.make(
  "billable",
  {},
  () =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      const val = yield* Prompt.select({
        message: "Default billable:",
        choices: [
          { title: "Yes", value: true },
          { title: "No", value: false }
        ]
      })
      yield* cfg.set({ defaultBillable: val })
      yield* Console.log(`Default billable: ${val ? "yes" : "no"}`)
    })
)

const configSetJql = Command.make(
  "jql",
  { jql: Args.string("jql") },
  ({ jql }) =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      yield* cfg.set({ defaultJql: jql })
      yield* Console.log(`Default JQL: ${jql}`)
    })
)

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

const configReset = Command.make(
  "reset",
  {},
  () =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      yield* cfg.set({
        defaultProjectId: null,
        defaultProjectName: null,
        defaultBillable: true,
        defaultJql: "assignee = currentUser() AND status != Done ORDER BY updated DESC",
        refreshInterval: 30,
        projectMap: {}
      })
      yield* Console.log("Config reset to defaults.")
    })
)

const configSet = Command.make("set", {}, () => Console.log("Config set: project, billable, jql")).pipe(
  Command.withSubcommands([configSetProject, configSetBillable, configSetJql])
)

// ---------------------------------------------------------------------------
// Top-level config command
// ---------------------------------------------------------------------------

/** Top-level `config` command with show/set/reset subcommands. */
export const config = Command.make(
  "config",
  {},
  () =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      const c = yield* cfg.get
      yield* Console.log("~/.jcf/config.json:")
      yield* Console.log("")
      yield* Console.log(`  Default JQL:     ${c.defaultJql}`)
      yield* Console.log(`  Refresh (sec):   ${c.refreshInterval}`)
      yield* Console.log(`  Default project: ${c.defaultProjectName ?? c.defaultProjectId ?? "(none)"}`)
      yield* Console.log(`  Default billable:${c.defaultBillable ? " yes" : " no"}`)
      yield* Console.log(`  Project map:     ${JSON.stringify(c.projectMap)}`)
    })
).pipe(
  Command.withSubcommands([configShow, configSet, configReset])
)
