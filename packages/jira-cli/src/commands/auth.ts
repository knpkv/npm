/**
 * Authentication commands for Jira CLI.
 *
 * @module
 */
import { Command, Options, Prompt } from "@effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { JiraAuth } from "../JiraAuth.js"

// === Auth create command ===
const createCommand = Command.make("create", {}, () =>
  Effect.gen(function*() {
    yield* Console.log(`
Creating OAuth app in Atlassian Developer Console...

1. Browser will open to create a new OAuth 2.0 (3LO) app
2. Enter app name (e.g., "Jira CLI")
3. After creation, go to "Permissions" and add:

   Jira API:
   - read:jira-work    Search and read issues, comments, attachments
   - read:jira-user    Read user info for assignee/reporter fields

   User Identity API:
   - read:me           Get your account ID and email for auth

4. Go to "Authorization" and set callback URL:
   http://localhost:8585/callback
5. Go to "Settings" and copy Client ID and Secret
6. Run: jira auth configure --client-id <ID> --client-secret <SECRET>
`)
    const url = "https://developer.atlassian.com/console/myapps/create-3lo-app/"
    yield* Effect.promise(() =>
      import("node:child_process").then((cp) =>
        new Promise<void>((resolve, reject) => {
          const platform = process.platform
          if (platform === "darwin") {
            cp.execFile("open", [url], (err) => err ? reject(err) : resolve())
          } else if (platform === "win32") {
            cp.execFile("cmd", ["/c", "start", "", url], (err) => err ? reject(err) : resolve())
          } else {
            cp.execFile("xdg-open", [url], (err) => err ? reject(err) : resolve())
          }
        })
      )
    )
  })).pipe(Command.withDescription("Create OAuth app in Atlassian Developer Console"))

// === Auth configure command ===
const clientIdOption = Options.text("client-id").pipe(
  Options.withDescription("OAuth client ID from Atlassian Developer Console"),
  Options.optional
)
const clientSecretOption = Options.text("client-secret").pipe(
  Options.withDescription("OAuth client secret"),
  Options.optional
)

const configureCommand = Command.make(
  "configure",
  { clientId: clientIdOption, clientSecret: clientSecretOption },
  ({ clientId, clientSecret }) =>
    Effect.gen(function*() {
      const auth = yield* JiraAuth

      const rawClientId = Option.isSome(clientId)
        ? clientId.value
        : yield* Prompt.text({ message: "Enter OAuth client ID:" })
      const rawClientSecret = Option.isSome(clientSecret)
        ? clientSecret.value
        : yield* Prompt.text({ message: "Enter OAuth client secret:" })

      yield* auth.configure({ clientId: rawClientId, clientSecret: rawClientSecret })
      yield* Console.log("OAuth configured. Run 'jira auth login' to authenticate.")
    })
).pipe(Command.withDescription("Configure OAuth client credentials"))

// === Auth login command ===
const siteOption = Options.text("site").pipe(
  Options.withDescription("Jira site URL to use (for accounts with multiple sites)"),
  Options.optional
)

const loginCommand = Command.make("login", { site: siteOption }, ({ site }) =>
  Effect.gen(function*() {
    const auth = yield* JiraAuth
    const result = yield* auth.login(Option.isSome(site) ? { siteUrl: site.value } : undefined)
    if (Array.isArray(result) && result.length > 0) {
      yield* Console.log("\nRe-run with --site to select a specific site.")
    }
  })).pipe(Command.withDescription("Authenticate with Atlassian via OAuth"))

// === Auth logout command ===
const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function*() {
    const auth = yield* JiraAuth
    yield* auth.logout()
    yield* Console.log("Logged out")
  })).pipe(Command.withDescription("Remove stored authentication"))

// === Auth status command ===
const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function*() {
    const auth = yield* JiraAuth
    const user = yield* auth.getCurrentUser()
    if (user) {
      yield* Console.log(`Logged in as: ${user.name} (${user.email})`)
    } else {
      yield* Console.log("Not logged in. Use 'jira auth login' to authenticate.")
    }
  })).pipe(Command.withDescription("Show authentication status"))

// === Auth command group ===
export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage OAuth authentication"),
  Command.withSubcommands([
    createCommand,
    configureCommand,
    loginCommand,
    logoutCommand,
    statusCommand
  ])
)
