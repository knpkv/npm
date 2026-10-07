/**
 * First-run setup + TUI launcher.
 *
 * @module
 */
import { Console, Effect, Option, Predicate } from "effect"
import { Prompt } from "effect/cli"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import { ClockifyAuth } from "../services/ClockifyAuth.js"
import { JiraAccess } from "../services/JiraAccess.js"
import { CONNECT_JIRA_COMMAND } from "../utils/hints.js"
import { connectClockify, connectJiraWithToken } from "./auth.js"
import { CommandFailed, requireTerminal } from "./CommandFailed.js"

declare const Bun: unknown

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

/** Runs one system's setup; a failure is printed and the wizard moves on, so the other can still connect. */
const attempt = <R>(setup: Effect.Effect<unknown, CommandFailed, R>) =>
  setup.pipe(
    Effect.as(true),
    Effect.catch((error) => Console.log(`${error.message}\n`).pipe(Effect.as(false)))
  )

/**
 * Before the TUI: when neither system is connected, offer to connect each, either skippable. With one
 * connected it goes straight on; the TUI and `jcf auth status` say what the other needs. Without a
 * terminal to ask in, it prints the two commands and fails.
 */
export const checkAuthOrSetup = Effect.gen(function*() {
  const clockifyAuth = yield* ClockifyAuth
  const access = yield* JiraAccess
  const jiraOk = Option.isSome(yield* access.connection.pipe(Effect.orElseSucceed(() => Option.none())))
  const clockifyOk = yield* clockifyAuth.isConfigured
  if (jiraOk || clockifyOk) return true

  yield* requireTerminal(`Connect Jira with ${CONNECT_JIRA_COMMAND}, or Clockify with jcf auth clockify setup.`)
  yield* Console.log(
    "jcf records your time in Jira and Clockify. Connect either or both; you can add the other later.\n"
  )

  yield* Console.log("Jira")
  const jira = yield* Prompt.Select({
    message: "How should jcf reach Jira?",
    choices: [
      { title: "Connect with an API token (recommended)", value: "token" },
      { title: "Use my own Atlassian OAuth app (advanced)", value: "oauth" },
      { title: "Skip Jira for now", value: "skip" }
    ]
  })
  const jiraConnected = jira === "token"
    ? yield* attempt(connectJiraWithToken({ site: Option.none(), email: Option.none() }))
    : false
  if (jira === "oauth") yield* Console.log("Run jcf auth jira create; it walks you through the Atlassian console.\n")

  yield* Console.log("Clockify")
  const clockify = yield* Prompt.Select({
    message: "Connect Clockify?",
    choices: [
      { title: "Connect with an API key", value: "key" },
      { title: "Skip Clockify for now", value: "skip" }
    ]
  })
  const clockifyConnected = clockify === "key" ? yield* attempt(connectClockify(Option.none())) : false

  if (!jiraConnected && !clockifyConnected) {
    return yield* new CommandFailed({
      message: `Nothing is connected yet. Run ${CONNECT_JIRA_COMMAND} or jcf auth clockify setup.`
    })
  }
  return true
}).pipe(
  Effect.catchTag(
    "QuitError",
    () => Effect.fail(new CommandFailed({ message: "Setup stopped; nothing more was connected." }))
  )
)

// ---------------------------------------------------------------------------
// TUI launcher
// ---------------------------------------------------------------------------

export const launchTui = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    // @opentui/react requires Bun (react-reconciler import without .js extension)
    const isBun = yield* Effect.try(() => !Predicate.isUndefined(Bun)).pipe(Effect.orElseSucceed(() => false))
    if (isBun) {
      yield* Effect.promise(() => import("../main.js")).pipe(Effect.flatMap((mod) => mod.default))
    } else {
      // Relaunch with Bun if available
      const exitCode = (command: ChildProcess.Command) =>
        Effect.scoped(command.pipe(Effect.flatMap((handle) => handle.exitCode)))

      const hasBun = yield* exitCode(ChildProcess.make("bun", ["--version"])).pipe(
        Effect.map((code) => code === 0),
        Effect.catch(() => Effect.succeed(false))
      )
      if (!hasBun) {
        yield* Console.log("TUI requires Bun runtime (@opentui/react dependency).")
        yield* Console.log("Install Bun: curl -fsSL https://bun.sh/install | bash")
        yield* Console.log("")
        yield* Console.log(
          "CLI commands work without Bun: jcf timer start, jcf timer stop, jcf timer status, jcf issue list"
        )
        return
      }
      // Re-exec with bun — must point to bin.ts, not this module
      const path = yield* Path.Path
      const thisDir = yield* path.fromFileUrl(new URL(".", import.meta.url))
      const scriptPath = path.join(thisDir, "../bin.js")
      const cliArgs = args.slice(2)
      yield* exitCode(ChildProcess.make("bun", [scriptPath, ...cliArgs], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
      })).pipe(
        Effect.catch(() => Effect.void)
      )
    }
  })

export const launchTuiOrSetup = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    yield* checkAuthOrSetup
    yield* launchTui(args)
  })
