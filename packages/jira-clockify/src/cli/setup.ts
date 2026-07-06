/**
 * First-run setup + TUI launcher.
 *
 * @module
 */
import { makeOpenApiFetchClient, toEffect } from "@knpkv/clockify-api-client"
import type { V1 } from "@knpkv/clockify-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import { Console, Effect, Predicate } from "effect"
import * as Path from "effect/Path"
import { Prompt } from "effect/unstable/cli"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ClockifyAuth } from "../services/ClockifyAuth.js"

declare const Bun: unknown

interface ClockifySetupUser {
  readonly id: string
  readonly name: string
  readonly email: string
}

interface ClockifySetupWorkspace {
  readonly id: string
  readonly name: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringField = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

const clockifyUserFrom = (value: unknown): ClockifySetupUser | null => {
  if (!isRecord(value)) return null
  const id = stringField(value, "id")
  const name = stringField(value, "name")
  const email = stringField(value, "email")
  if (id === null || name === null || email === null) return null
  return { id, name, email }
}

const clockifyWorkspaceFrom = (value: unknown): ClockifySetupWorkspace | null => {
  if (!isRecord(value)) return null
  const id = stringField(value, "id")
  const name = stringField(value, "name")
  if (id === null || name === null) return null
  return { id, name }
}

const clockifyWorkspaceListFrom = (value: unknown): ReadonlyArray<ClockifySetupWorkspace> =>
  Array.isArray(value)
    ? value.map(clockifyWorkspaceFrom).filter((workspace): workspace is ClockifySetupWorkspace => workspace !== null)
    : []

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

export const checkAuthOrSetup = Effect.gen(function*() {
  const clockifyAuth = yield* ClockifyAuth
  const jira = yield* JiraAuth

  const clockifyOk = yield* clockifyAuth.isConfigured
  const jiraOk = yield* jira.isLoggedIn()

  if (clockifyOk && jiraOk) return true

  yield* Console.log("Welcome to jcf! Let's set up your accounts.\n")

  if (!jiraOk) {
    yield* Console.log("─── Jira ───")
    const jiraConfigured = yield* jira.isConfigured()
    if (!jiraConfigured) {
      yield* Console.log("Jira OAuth not configured.")
      yield* Console.log("1. Create an OAuth app: https://developer.atlassian.com/console/myapps/create-3lo-app/")
      yield* Console.log("   Permissions: read:jira-work, write:jira-work, read:jira-user, read:me")
      yield* Console.log("   Callback URL: http://localhost:8585/callback")
      yield* Console.log("")

      const id = yield* Prompt.text({ message: "Enter OAuth client ID:" })
      const secret = yield* Prompt.text({ message: "Enter OAuth client secret:" })
      yield* jira.configure({ clientId: id, clientSecret: secret })
      yield* Console.log("OAuth configured.")
    }

    yield* Console.log("Starting Jira login...")
    yield* jira.login().pipe(
      Effect.catch((e) =>
        Console.log(`Jira login failed: ${Predicate.hasProperty(e, "message") ? String(e.message) : String(e)}`)
      )
    )
    const user = yield* jira.getCurrentUser().pipe(Effect.catch(() => Effect.succeed(null)))
    if (user) {
      yield* Console.log(`✓ Logged in as ${user.name} (${user.email})\n`)
    } else {
      yield* Console.log("✗ Jira login incomplete. You can retry with: jcf auth jira login\n")
    }
  }

  if (!clockifyOk) {
    yield* Console.log("─── Clockify ───")
    yield* Console.log("Get your API key from: https://app.clockify.me/manage-api-keys\n")

    const apiKey = yield* Prompt.text({ message: "Enter Clockify API key:" })
    if (!apiKey) {
      yield* Console.log("Skipped. Run: jcf auth clockify setup\n")
      return false
    }

    // Create a temporary openapi-fetch client with the entered key
    const { client } = makeOpenApiFetchClient<V1.paths>("https://api.clockify.me/api", {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json"
    })

    const user = yield* toEffect(client.GET("/v1/user")).pipe(
      Effect.map(clockifyUserFrom),
      Effect.catch(() => Effect.succeed(null))
    )
    if (!user) {
      yield* Console.log("✗ Invalid API key. Run: jcf auth clockify setup\n")
      return false
    }
    yield* Console.log(`Authenticated as: ${user.name} (${user.email})`)

    const workspaces = yield* toEffect(client.GET("/v1/workspaces")).pipe(
      Effect.map(clockifyWorkspaceListFrom),
      Effect.catch(() => Effect.succeed<ReadonlyArray<ClockifySetupWorkspace>>([]))
    )
    let workspaceId = ""
    let workspaceName = ""
    if (workspaces.length === 1) {
      const workspace = workspaces[0]
      if (workspace !== undefined) {
        workspaceId = workspace.id
        workspaceName = workspace.name
      }
    } else if (workspaces.length > 1) {
      workspaceId = yield* Prompt.select({
        message: "Select workspace:",
        choices: workspaces.map((workspace) => ({ title: workspace.name, value: workspace.id }))
      })
      workspaceName = workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? ""
    }

    if (workspaceId) {
      yield* clockifyAuth.save({
        apiKey,
        workspaceId,
        userId: user.id,
        baseUrl: "https://api.clockify.me/api"
      })
      yield* Console.log(`✓ Clockify configured (workspace: ${workspaceName})\n`)
    }
  }

  yield* Console.log("─── Setup complete! ───\n")
  return true
})

// ---------------------------------------------------------------------------
// TUI launcher
// ---------------------------------------------------------------------------

export const launchTui = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    // @opentui/react requires Bun (react-reconciler import without .js extension)
    const isBun = typeof Bun !== "undefined"
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
    const ready = yield* checkAuthOrSetup.pipe(Effect.catch(() => Effect.succeed(false)))
    if (!ready) {
      yield* Console.log("Setup incomplete. Run 'jcf auth status' to check.")
      return
    }
    yield* launchTui(args)
  })
