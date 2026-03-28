/**
 * Auth commands: jira (create/configure/login/logout/status), clockify (setup/status), combined status.
 *
 * @module
 */
import { Command, Options, Prompt } from "@effect/cli"
import { makeOpenApiFetchClient, toEffect } from "@knpkv/clockify-api-client"
import type { V1 } from "@knpkv/clockify-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import { Console, Effect, Option } from "effect"
import { ClockifyAuth } from "../services/ClockifyAuth.js"

// ---------------------------------------------------------------------------
// Jira OAuth
// ---------------------------------------------------------------------------

const jiraCreate = Command.make(
  "create",
  {},
  () =>
    Effect.gen(function*() {
      yield* Console.log(`
Create OAuth app in Atlassian Developer Console:

1. Browser will open to create a new OAuth 2.0 (3LO) app
2. Enter app name (e.g., "jcf")
3. Go to "Permissions" → add Jira API:
   - read:jira-work
   - write:jira-work
   - read:jira-user
   And User Identity API:
   - read:me
4. Go to "Authorization" → callback URL: http://localhost:8585/callback
5. Go to "Settings" → copy Client ID and Secret
6. Run: jcf auth jira configure
`)
      yield* Effect.promise(() =>
        import("node:child_process").then(
          (cp) =>
            new Promise<void>((resolve, reject) => {
              cp.execFile(
                process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open",
                process.platform === "win32"
                  ? ["/c", "start", "", "https://developer.atlassian.com/console/myapps/create-3lo-app/"]
                  : ["https://developer.atlassian.com/console/myapps/create-3lo-app/"],
                (err) => (err ? reject(err) : resolve())
              )
            })
        )
      )
    })
)

const jiraConfigure = Command.make(
  "configure",
  {
    clientId: Options.text("client-id").pipe(Options.withDescription("OAuth client ID"), Options.optional),
    clientSecret: Options.text("client-secret").pipe(Options.withDescription("OAuth client secret"), Options.optional)
  },
  ({ clientId, clientSecret }) =>
    Effect.gen(function*() {
      const auth = yield* JiraAuth

      const id = Option.isSome(clientId)
        ? clientId.value
        : yield* Prompt.text({ message: "Enter OAuth client ID:" })

      const secret = Option.isSome(clientSecret)
        ? clientSecret.value
        : yield* Prompt.text({ message: "Enter OAuth client secret:" })

      yield* auth.configure({ clientId: id, clientSecret: secret })
      yield* Console.log("OAuth configured. Run: jcf auth jira login")
    })
)

const jiraLogin = Command.make(
  "login",
  { site: Options.text("site").pipe(Options.withDescription("Jira site URL"), Options.optional) },
  ({ site }) =>
    Effect.gen(function*() {
      const auth = yield* JiraAuth
      const result = yield* auth.login(Option.isSome(site) ? { siteUrl: site.value } : undefined)
      if (Array.isArray(result) && result.length > 0) {
        yield* Console.log("\nRe-run with --site <url> to select a specific site.")
      }
    }).pipe(
      Effect.catchAll((e) =>
        Console.log(`Error: ${"message" in (e as object) ? (e as { message: string }).message : String(e)}`)
      )
    )
)

const jiraLogout = Command.make(
  "logout",
  {},
  () =>
    Effect.gen(function*() {
      const auth = yield* JiraAuth
      yield* auth.logout()
      yield* Console.log("Logged out from Jira")
    }).pipe(Effect.catchAll((e) =>
      Console.log(`Error: ${"message" in (e as object) ? (e as { message: string }).message : String(e)}`)
    ))
)

const jiraStatus = Command.make(
  "status",
  {},
  () =>
    Effect.gen(function*() {
      const auth = yield* JiraAuth
      const user = yield* auth.getCurrentUser()
      if (user) {
        yield* Console.log(`Jira: ✓ logged in as ${user.name} (${user.email})`)
      } else {
        yield* Console.log("Jira: ✗ not logged in")
        yield* Console.log("  Run: jcf auth jira create → configure → login")
      }
    }).pipe(Effect.catchAll(() => Console.log("Jira: ✗ not configured")))
)

const authJira = Command.make("jira", {}, () => Console.log("Jira auth: create, configure, login, logout, status"))
  .pipe(
    Command.withSubcommands([jiraCreate, jiraConfigure, jiraLogin, jiraLogout, jiraStatus])
  )

// ---------------------------------------------------------------------------
// Clockify API key
// ---------------------------------------------------------------------------

export const clockifySetup = Command.make(
  "setup",
  {},
  () =>
    Effect.gen(function*() {
      const auth = yield* ClockifyAuth

      yield* Console.log("Clockify API Key Setup")
      yield* Console.log("Get your API key from: https://app.clockify.me/manage-api-keys")
      yield* Console.log("")

      const apiKey = yield* Prompt.text({ message: "Enter API key:" })

      if (!apiKey) {
        yield* Console.log("No API key provided, aborting.")
        return
      }

      yield* Console.log("Validating...")

      // Create a temporary openapi-fetch client with the entered key
      const { client } = makeOpenApiFetchClient<V1.paths>("https://api.clockify.me/api", {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json"
      })

      const user = yield* toEffect(client.GET("/v1/user")).pipe(
        Effect.catchAll(() => Effect.fail(new Error("Invalid API key — check the value and try again")))
      )
      yield* Console.log(`Authenticated as: ${(user as { name: string }).name} (${(user as { email: string }).email})`)

      const workspaces = yield* toEffect(client.GET("/v1/workspaces")).pipe(
        Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<{ id: string; name: string }>))
      )

      if (workspaces.length === 0) {
        yield* Console.log("No workspaces found.")
        return
      }

      yield* Console.log("")
      yield* Console.log("Workspaces:")
      for (let i = 0; i < workspaces.length; i++) {
        yield* Console.log(`  ${i + 1}. ${(workspaces[i] as { name: string }).name}`)
      }

      let selectedIdx = 0
      if (workspaces.length > 1) {
        const choice = yield* Prompt.text({ message: `Select workspace (1-${workspaces.length}):` })
        selectedIdx = Math.max(0, Math.min(workspaces.length - 1, parseInt(choice, 10) - 1))
      }

      const workspace = workspaces[selectedIdx]!
      yield* Console.log(`Selected: ${(workspace as { name: string }).name}`)

      yield* auth.save({
        apiKey,
        workspaceId: (workspace as { id: string }).id,
        userId: (user as { id: string }).id,
        baseUrl: "https://api.clockify.me/api"
      })

      yield* Console.log("")
      yield* Console.log("Clockify configured! Saved to ~/.jcf/clockify.json")
    }).pipe(
      Effect.catchAll((e) =>
        Console.log(`Error: ${"message" in (e as object) ? (e as { message: string }).message : String(e)}`)
      )
    )
)

const clockifyStatus = Command.make(
  "status",
  {},
  () =>
    Effect.gen(function*() {
      const auth = yield* ClockifyAuth
      const configured = yield* auth.isConfigured
      if (!configured) {
        yield* Console.log("Clockify: ✗ not configured")
        yield* Console.log("  Run: jcf auth clockify setup")
        return
      }
      const config = yield* auth.getConfig.pipe(
        Effect.catchAll((e) => Console.log(`Clockify: error — ${e.message}`).pipe(Effect.flatMap(() => Effect.fail(e))))
      )
      yield* Console.log("Clockify: ✓ authenticated")
      yield* Console.log(`  Workspace: ${config.workspaceId}`)
      yield* Console.log(`  User: ${config.userId}`)
    }).pipe(Effect.catchAll(() => Effect.void))
)

const authClockify = Command.make("clockify", {}, () => Console.log("Clockify auth: setup, status")).pipe(
  Command.withSubcommands([clockifySetup, clockifyStatus])
)

// ---------------------------------------------------------------------------
// Combined status
// ---------------------------------------------------------------------------

const authStatus = Command.make(
  "status",
  {},
  () =>
    Effect.gen(function*() {
      yield* Console.log("=== Auth Status ===")
      yield* Console.log("")

      // Jira
      const jira = yield* JiraAuth
      const jiraUser = yield* jira.getCurrentUser().pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (jiraUser) {
        yield* Console.log(`Jira:     ✓ ${jiraUser.name} (${jiraUser.email})`)
      } else {
        yield* Console.log("Jira:     ✗ not logged in")
      }

      // Clockify
      const clockifyAuth = yield* ClockifyAuth
      const clockifyOk = yield* clockifyAuth.isConfigured
      if (clockifyOk) {
        const cfg = yield* clockifyAuth.getConfig.pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (cfg) {
          yield* Console.log(`Clockify: ✓ workspace ${cfg.workspaceId}`)
        } else {
          yield* Console.log("Clockify: ✗ config corrupt")
        }
      } else {
        yield* Console.log("Clockify: ✗ not configured")
      }
    })
)

/** Top-level `auth` command with jira/clockify/status subcommands. */
export const auth = Command.make("auth", {}, () => Console.log("Auth: jira, clockify, status")).pipe(
  Command.withSubcommands([authJira, authClockify, authStatus])
)
