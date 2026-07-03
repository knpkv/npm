/**
 * Authentication commands for Confluence CLI.
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Command, Flag as Options, Prompt } from "effect/unstable/cli"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ConfluenceAuth } from "../ConfluenceAuth.js"

const openBrowser = (url: string) => {
  const run = (command: ChildProcess.Command) =>
    Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
      spawner.exitCode(command).pipe(
        Effect.flatMap((code) => code === 0 ? Effect.void : Effect.fail(code))
      ))

  return run(ChildProcess.make("open", [url])).pipe(
    Effect.catchIf(() => true, () => run(ChildProcess.make("xdg-open", [url]))),
    Effect.catchIf(() => true, () => run(ChildProcess.make("rundll32.exe", ["url.dll,FileProtocolHandler", url]))),
    Effect.asVoid
  )
}

// === Auth create command ===
const createCommand = Command.make("create", {}, () =>
  Effect.gen(function*() {
    yield* Console.log(`
Creating OAuth app in Atlassian Developer Console...

1. Browser will open to create a new OAuth 2.0 (3LO) app
2. Enter app name (e.g., "Confluence CLI")
3. After creation, go to "Permissions" and add:
   - Confluence API (granular): read:page:confluence, write:page:confluence, delete:page:confluence
   - User Identity API: read:me
4. Go to "Authorization" and set callback URL:
   http://localhost:8585/callback
5. Go to "Settings" and copy Client ID and Secret
6. Run: confluence auth configure --client-id <ID> --client-secret <SECRET>
`)
    const url = "https://developer.atlassian.com/console/myapps/create-3lo-app/"
    yield* openBrowser(url)
  })).pipe(Command.withDescription("Create OAuth app in Atlassian Developer Console"))

// === Auth configure command ===
const clientIdOption = Options.string("client-id").pipe(
  Options.withDescription("OAuth client ID from Atlassian Developer Console"),
  Options.optional
)
const clientSecretOption = Options.string("client-secret").pipe(
  Options.withDescription("OAuth client secret"),
  Options.optional
)

const configureCommand = Command.make(
  "configure",
  { clientId: clientIdOption, clientSecret: clientSecretOption },
  ({ clientId, clientSecret }) =>
    Effect.gen(function*() {
      const auth = yield* ConfluenceAuth

      const rawClientId = Option.isSome(clientId)
        ? clientId.value
        : yield* Prompt.text({ message: "Enter OAuth client ID:" })
      const rawClientSecret = Option.isSome(clientSecret)
        ? clientSecret.value
        : yield* Prompt.text({ message: "Enter OAuth client secret:" })

      yield* auth.configure({ clientId: rawClientId, clientSecret: rawClientSecret })
      yield* Console.log("OAuth configured. Run 'confluence auth login' to authenticate.")
    })
).pipe(Command.withDescription("Configure OAuth client credentials"))

// === Auth login command ===
const siteOption = Options.string("site").pipe(
  Options.withDescription("Confluence site URL to use (for accounts with multiple sites)"),
  Options.optional
)

const loginCommand = Command.make("login", { site: siteOption }, ({ site }) =>
  Effect.gen(function*() {
    const auth = yield* ConfluenceAuth
    const result = yield* auth.login(Option.isSome(site) ? { siteUrl: site.value } : undefined)
    if (Array.isArray(result) && result.length > 0) {
      yield* Console.log("\nRe-run with --site to select a specific site.")
    }
  })).pipe(Command.withDescription("Authenticate with Atlassian via OAuth"))

// === Auth logout command ===
const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function*() {
    const auth = yield* ConfluenceAuth
    yield* auth.logout()
    yield* Console.log("Logged out")
  })).pipe(Command.withDescription("Remove stored authentication"))

// === Auth status command ===
const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function*() {
    const auth = yield* ConfluenceAuth
    const user = yield* auth.getCurrentUser()
    if (user) {
      yield* Console.log(`Logged in as: ${user.name} (${user.email})`)
    } else {
      yield* Console.log("Not logged in. Use 'confluence auth login' to authenticate.")
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
