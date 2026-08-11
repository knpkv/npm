/**
 * Auth subcommands: create, configure, login, logout, status.
 *
 * **Mental model**
 *
 * - Each command is a standalone `Command.make` that yields into `JiraAuth` service methods.
 * - `create` opens the Atlassian Developer Console; `configure` prompts for client ID/secret.
 *
 * @internal
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Argument as Args, Command, Flag as Options, Prompt } from "effect/unstable/cli"
import { openBrowser } from "../internal/openBrowser.js"
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
    yield* openBrowser(url).pipe(Effect.catch(() => Effect.void))
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
const siteOption = Options.string("site").pipe(
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
    const profile = yield* auth.getActiveProfile()
    if (profile) {
      const user = profile.token.user
      const account = user ? `${user.name} (${user.email})` : "unknown user"
      yield* Console.log(`Active profile: ${profile.name}`)
      yield* Console.log(`Account: ${account}`)
      yield* Console.log(`Site: ${profile.token.site_url}`)
      yield* Console.log(`Profile ID: ${profile.id}`)
    } else {
      yield* Console.log("Not logged in. Use 'jira auth login' to authenticate.")
    }
  })).pipe(Command.withDescription("Show authentication status"))

// === Auth profiles command ===
const profilesCommand = Command.make("profiles", {}, () =>
  Effect.gen(function*() {
    const auth = yield* JiraAuth
    const [profiles, active] = yield* Effect.all([auth.listProfiles(), auth.getActiveProfile()])
    if (profiles.length === 0) {
      yield* Console.log("No auth profiles. Use 'jira auth login' to authenticate.")
      return
    }

    for (const profile of profiles) {
      const marker = active?.id === profile.id ? "*" : " "
      yield* Console.log(`${marker} ${profile.id}`)
      yield* Console.log(`    ${profile.name}`)
      yield* Console.log(`    ${profile.token.site_url}`)
    }
  })).pipe(Command.withDescription("List stored auth profiles"))

const profileArg = Args.string("profile").pipe(
  Args.withDescription("Profile ID, name, site URL, cloud ID, or account ID")
)

// === Auth use command ===
const useCommand = Command.make("use", { profile: profileArg }, ({ profile }) =>
  Effect.gen(function*() {
    const auth = yield* JiraAuth
    const selected = yield* auth.switchProfile(profile)
    if (!selected) {
      yield* Console.log(`Profile not found: ${profile}`)
      return
    }
    yield* Console.log(`Active profile: ${selected.name}`)
  })).pipe(Command.withDescription("Switch active auth profile"))

// === Auth remove command ===
const removeCommand = Command.make("remove", { profile: profileArg }, ({ profile }) =>
  Effect.gen(function*() {
    const auth = yield* JiraAuth
    const removed = yield* auth.removeProfile(profile)
    if (!removed) {
      yield* Console.log(`Profile not found: ${profile}`)
      return
    }
    yield* Console.log(`Removed profile: ${removed.name}`)
  })).pipe(Command.withDescription("Remove stored auth profile"))

// === Auth command group ===
export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage OAuth authentication"),
  Command.withSubcommands([
    createCommand,
    configureCommand,
    loginCommand,
    logoutCommand,
    statusCommand,
    profilesCommand,
    useCommand,
    removeCommand
  ])
)
