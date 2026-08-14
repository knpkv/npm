/**
 * Authentication commands for Confluence CLI.
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Command, Flag as Options, Prompt } from "effect/unstable/cli"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { CLI_LOGIN_SCOPES, ConfluenceAuth } from "../ConfluenceAuth.js"

const CONSOLE_APPS_URL = "https://developer.atlassian.com/console/myapps/"
const CALLBACK_URL = "http://localhost:8585/callback"

/**
 * The scopes to enable on the OAuth app, split by the console section they live
 * under. Derived from {@link CLI_LOGIN_SCOPES} rather than written out, so the
 * setup instructions cannot drift from what `auth login` actually requests —
 * Atlassian rejects an authorization request naming a scope the app lacks, so a
 * stale list here produces a login that cannot succeed.
 */
const scopeInstructions = (): string => {
  const section = (heading: string, scopes: ReadonlyArray<string>): ReadonlyArray<string> =>
    scopes.length === 0 ? [] : [`   - ${heading}:`, ...scopes.map((scope) => `       ${scope}`)]

  // `offline_access` is requested at authorize time but is not an app permission,
  // so it is deliberately absent from both sections.
  return [
    ...section("Confluence API (granular)", CLI_LOGIN_SCOPES.filter((scope) => scope.endsWith(":confluence"))),
    ...section("User Identity API", CLI_LOGIN_SCOPES.filter((scope) => scope === "read:me"))
  ].join("\n")
}

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
${scopeInstructions()}
4. Go to "Authorization" and set callback URL:
   ${CALLBACK_URL}
5. Go to "Settings" and copy Client ID and Secret
6. Run: confluence auth configure --client-id <ID> --client-secret <SECRET>
`)
    const url = "https://developer.atlassian.com/console/myapps/create-3lo-app/"
    yield* openBrowser(url)
  })).pipe(Command.withDescription("Create OAuth app in Atlassian Developer Console"))

// === Auth manage command ===
/**
 * Open the existing OAuth app for editing.
 *
 * Opens the app list rather than the app itself: the console addresses an app by
 * an app id that is not the OAuth client id, and the client id is the only app
 * identifier this CLI stores — so a deep link cannot be built from what is on
 * disk without guessing.
 */
const manageCommand = Command.make("manage", {}, () =>
  Effect.gen(function*() {
    yield* Console.log(`
Opening the Atlassian Developer Console app list...

Select your OAuth app, then under "Permissions" make sure every scope below is
enabled. \`confluence auth login\` requests all of them, and Atlassian rejects an
authorization request naming a scope the app does not have — so a missing scope
here fails the login itself, not just the command that needed it.

${scopeInstructions()}

Under "Authorization", the callback URL must be:
   ${CALLBACK_URL}

After adding scopes, run: confluence auth login
`)
    yield* openBrowser(CONSOLE_APPS_URL)
  })).pipe(
    Command.withDescription(
      "Open the Atlassian Developer Console to edit the OAuth app's scopes"
    )
  )

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
    manageCommand,
    configureCommand,
    loginCommand,
    logoutCommand,
    statusCommand
  ])
)
