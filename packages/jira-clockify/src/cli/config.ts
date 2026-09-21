/**
 * Config commands: show, set (project/billable/jql), reset.
 *
 * @module
 */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { Console, Effect } from "effect"
import { Argument as Args, Command, Flag as Options, Prompt } from "effect/unstable/cli"
import { isTicketKey } from "../agent/sessions.js"
import { ClockifyAuth } from "../services/ClockifyAuth.js"
import { ConfigService, defaultJcfConfig, type JcfConfig } from "../services/ConfigService.js"

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

/** One printer so `jcf config` and `jcf config show` cannot drift apart. */
const printConfig = (config: JcfConfig) =>
  Effect.gen(function*() {
    yield* Console.log("~/.jcf/config.json:")
    yield* Console.log("")
    yield* Console.log(`  Default JQL:     ${config.defaultJql}`)
    yield* Console.log(`  Refresh (sec):   ${config.refreshInterval}`)
    yield* Console.log(`  Default project: ${config.defaultProjectName ?? config.defaultProjectId ?? "(none)"}`)
    yield* Console.log(`  Default billable:${config.defaultBillable ? " yes" : " no"}`)
    yield* Console.log(`  Project map:     ${JSON.stringify(config.projectMap)}`)
    yield* Console.log(
      `  Session roots:   ${config.sessionRoots.length > 0 ? config.sessionRoots.join(", ") : "(none)"}`
    )
    yield* Console.log(`  Session tickets: ${JSON.stringify(config.sessionTicketMap)}`)
    yield* Console.log(`  Idle cap (sec):  ${config.sessionIdleCapSeconds}`)
    yield* Console.log(
      `  Dwell (sec):     ${config.sessionDwellSeconds === 0 ? "off" : config.sessionDwellSeconds}`
    )
    yield* Console.log(`  Confidence floor:${` ${config.sessionConfidenceFloor}`}`)
    yield* Console.log(
      `  Ownership:       ${
        config.sessionOwnership === "assigned" ? "assigned to you only" : "any ticket a signal placed"
      }`
    )
    yield* Console.log(
      `  Yours anyway:    ${
        config.sessionOwnershipOverrides.length > 0 ? config.sessionOwnershipOverrides.join(", ") : "(none)"
      }`
    )
  })

const configShow = Command.make(
  "show",
  {},
  () =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      yield* printConfig(yield* cfg.get)
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
      if (auth === null) {
        yield* Console.log("Clockify not configured. Run: jcf auth clockify setup")
        return
      }
      const projects = yield* clockifyClient.getProjects(auth.workspaceId).pipe(
        Effect.catch(() => Effect.succeed([]))
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
      if (selected !== "") {
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
// Agent session settings
// ---------------------------------------------------------------------------

/**
 * A Session Root or Standing Attribution prefix must be absolute or `~`-relative. Anything else
 * would be interpreted against a working directory that is not the one the sessions ran in, so it
 * is rejected rather than resolved into a surprising path.
 */
const normalisePrefix = (input: string): { readonly path: string } | { readonly error: string } => {
  const raw = input.trim()
  const trimmed = /^[A-Za-z]:[\\/]+$/.test(raw) ? raw.slice(0, 3) : raw.replace(/[\\/]+$/, "")
  if (trimmed.length === 0) return { error: "Provide a directory." }
  if (
    !trimmed.startsWith("/") && !trimmed.startsWith("~") && !/^[A-Za-z]:[\\/]/.test(trimmed) &&
    !/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(trimmed)
  ) {
    return { error: `Use an absolute path or one starting with ~ (got "${input}").` }
  }
  return { path: trimmed }
}

const removeOption = Options.boolean("remove").pipe(
  Options.withDescription("Remove the entry instead of adding it"),
  Options.withDefault(false)
)

const configSetSessionRoot = Command.make(
  "session-root",
  { dir: Args.string("dir"), remove: removeOption },
  ({ dir, remove }) =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      const normalised = normalisePrefix(dir)
      if ("error" in normalised) {
        yield* Console.log(normalised.error)
        return
      }
      const current = (yield* cfg.get).sessionRoots
      const next = remove
        ? current.filter((root) => root !== normalised.path)
        : current.includes(normalised.path)
        ? current
        : [...current, normalised.path]
      yield* cfg.set({ sessionRoots: next })
      yield* Console.log(
        next.length > 0 ? `Session roots: ${next.join(", ")}` : "Session roots cleared — no work is opted in."
      )
    })
).pipe(Command.withDescription("Directories whose Agent Sessions may become Proposed Worklogs"))

const configSetSessionTicket = Command.make(
  "session-ticket",
  { dir: Args.string("dir"), ticket: Args.string("ticket").pipe(Args.optional), remove: removeOption },
  ({ dir, remove, ticket }) =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      const normalised = normalisePrefix(dir)
      if ("error" in normalised) {
        yield* Console.log(normalised.error)
        return
      }
      const current = (yield* cfg.get).sessionTicketMap
      if (remove) {
        const next = Object.fromEntries(Object.entries(current).filter(([prefix]) => prefix !== normalised.path))
        yield* cfg.set({ sessionTicketMap: next })
        yield* Console.log(`Standing attributions: ${JSON.stringify(next)}`)
        return
      }
      if (ticket._tag === "None") {
        yield* Console.log("Provide an issue key, e.g. jcf config set session-ticket ~/dev/docs PROJ-42")
        return
      }
      if (!isTicketKey(ticket.value)) {
        yield* Console.log(`"${ticket.value}" is not an issue key. Use the Jira form, e.g. PROJ-42.`)
        return
      }
      const next = { ...current, [normalised.path]: ticket.value }
      yield* cfg.set({ sessionTicketMap: next })
      yield* Console.log(`Standing attributions: ${JSON.stringify(next)}`)
    })
).pipe(Command.withDescription("Standing Attribution: map a directory to an issue key"))

const configSetIdleCap = Command.make(
  "idle-cap",
  { seconds: Args.string("seconds") },
  ({ seconds }) =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      const parsed = Number(seconds)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        yield* Console.log("Provide a positive number of seconds, e.g. 300.")
        return
      }
      yield* cfg.set({ sessionIdleCapSeconds: parsed })
      yield* Console.log(`Idle cap: ${parsed}s`)
    })
).pipe(Command.withDescription("Longest gap between Session Activity events still counted as work"))

const configSetDwell = Command.make(
  "dwell",
  { seconds: Args.string("seconds") },
  ({ seconds }) =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      const parsed = Number(seconds)
      // Zero is allowed here, unlike an idle cap: it turns the floor off and reports the raw
      // interleaving, which is a legitimate thing to want to look at once.
      if (!Number.isFinite(parsed) || parsed < 0) {
        yield* Console.log("Provide a number of seconds, e.g. 900. Zero turns the dwell floor off.")
        return
      }
      yield* cfg.set({ sessionDwellSeconds: parsed })
      yield* Console.log(
        parsed === 0
          ? "Dwell floor: off — ownership may change as often as the transcripts interleave"
          : `Dwell floor: ${parsed}s`
      )
    })
).pipe(Command.withDescription("Shortest stretch that may own time on its own"))

const configSetOwnership = Command.make(
  "ownership",
  { mode: Args.string("assigned|any") },
  ({ mode }) =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      if (mode !== "assigned" && mode !== "any") {
        yield* Console.log("Provide `assigned` (only your own tickets) or `any`.")
        return
      }
      yield* cfg.set({ sessionOwnership: mode })
      yield* Console.log(
        mode === "assigned"
          ? "Ownership: only tickets assigned to you are proposed — the rest are reported"
          : "Ownership: any ticket an Attribution Signal placed is proposed"
      )
    })
).pipe(Command.withDescription("Whether a proposal may name a ticket assigned to somebody else"))

const configSetMine = Command.make(
  "mine",
  { key: Args.string("ISSUE-KEY") },
  ({ key }) =>
    Effect.gen(function*() {
      const cfg = yield* ConfigService
      const ticketKey = key.trim().toUpperCase()
      if (!isTicketKey(ticketKey)) {
        yield* Console.log("That is not an Issue Key, e.g. PROJ-123.")
        return
      }
      const current = yield* cfg.get
      if (current.sessionOwnershipOverrides.includes(ticketKey)) {
        yield* Console.log(`${ticketKey} is already treated as yours.`)
        return
      }
      yield* cfg.set({
        sessionOwnershipOverrides: [...current.sessionOwnershipOverrides, ticketKey].sort()
      })
      yield* Console.log(`${ticketKey} will be proposed as yours whatever Jira says its assignee is.`)
    })
).pipe(Command.withDescription("Treat one ticket as yours even when Jira assigns it to somebody else"))

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
        projectMap: {},
        // Reset means reset. Leaving these behind was invisible — `jcf config show` lists them, so a
        // user chasing a bad idle cap or a stale Standing Attribution would reset, see them still
        // there, and have nothing to go on.
        sessionRoots: defaultJcfConfig.sessionRoots,
        sessionTicketMap: defaultJcfConfig.sessionTicketMap,
        sessionIdleCapSeconds: defaultJcfConfig.sessionIdleCapSeconds,
        sessionConfidenceFloor: defaultJcfConfig.sessionConfidenceFloor,
        sessionDwellSeconds: defaultJcfConfig.sessionDwellSeconds,
        sessionAgent: defaultJcfConfig.sessionAgent,
        sessionOwnership: defaultJcfConfig.sessionOwnership,
        sessionOwnershipOverrides: defaultJcfConfig.sessionOwnershipOverrides
      })
      yield* Console.log("Config reset to defaults, including session roots and standing attributions.")
    })
)

const configSet = Command.make(
  "set",
  {},
  () =>
    Console.log(
      "Config set: project, billable, jql, session-root, session-ticket, idle-cap, dwell, ownership, mine"
    )
).pipe(
  Command.withSubcommands([
    configSetProject,
    configSetBillable,
    configSetJql,
    configSetSessionRoot,
    configSetSessionTicket,
    configSetIdleCap,
    configSetDwell,
    configSetOwnership,
    configSetMine
  ])
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
      yield* printConfig(yield* cfg.get)
    })
).pipe(
  Command.withSubcommands([configShow, configSet, configReset])
)
