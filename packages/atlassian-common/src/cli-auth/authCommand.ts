/**
 * The `auth` command group every Atlassian CLI exposes, built once over its {@link AtlassianCliAuth}.
 *
 * **Mental model**
 *
 * - **One descriptor, two readers.** The CLI passes the same {@link AtlassianCliDescriptor} it built
 *   its auth from, so the setup instructions list exactly the scopes `auth login` requests. A second,
 *   hand-written list is how a setup that cannot log in happens: Atlassian rejects an authorization
 *   request naming a scope the app lacks.
 * - **Only presentation is configured.** The heading the product's scopes sit under in the
 *   developer console, and what to call a site in `--site`.
 * - **A browser that does not open is an error.** The URL is printed first, so a headless or SSH
 *   user can still finish by hand; the exit code just stops claiming it worked.
 *
 * @module
 */
import { Argument, Command, Flag, Prompt } from "effect/cli"
import * as Console from "effect/Console"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { AtlassianCliAuth, AtlassianCliDescriptor } from "./AtlassianCliAuth.js"
import { openBrowser } from "./openBrowser.js"

const CREATE_APP_URL = "https://developer.atlassian.com/console/myapps/create-3lo-app/"
const CONSOLE_APPS_URL = "https://developer.atlassian.com/console/myapps/"
const CALLBACK_URL = "http://localhost:8585/callback"

/** The part of an Atlassian CLI's auth the `auth` commands drive. */
export type AuthCommandService = Pick<
  AtlassianCliAuth<never>,
  | "configure"
  | "login"
  | "logout"
  | "getActiveProfile"
  | "listProfiles"
  | "switchProfile"
  | "removeProfile"
>

/** What only the product decides about how its `auth` commands read. */
export interface AuthCommandOptions {
  /** Developer-console heading the product's scopes live under, e.g. `"Jira API"`. */
  readonly apiSection: string
}

/**
 * The scopes to enable on the OAuth app, by console section. `read:me` is a User Identity scope;
 * `offline_access` is requested at authorize time but is not an app permission, so it is omitted.
 */
export const scopeInstructions = (descriptor: AtlassianCliDescriptor, apiSection: string): string => {
  const section = (heading: string, scopes: ReadonlyArray<string>): ReadonlyArray<string> =>
    scopes.length === 0 ? [] : [`   - ${heading}:`, ...scopes.map((scope) => `       ${scope}`)]
  const permissions = descriptor.scopes.filter((scope) => scope !== "offline_access")
  return [
    ...section(apiSection, permissions.filter((scope) => scope !== "read:me")),
    ...section("User Identity API", permissions.filter((scope) => scope === "read:me"))
  ].join("\n")
}

/** Print the URL, then try to open it; a browser that never opened fails the command. */
const visit = (url: string) => Console.log(`Opening ${url}`).pipe(Effect.andThen(openBrowser(url)))

/** Build `<cli> auth` with create, manage, configure, login, logout, status, profiles, use, remove. */
export const makeAuthCommand = <I, S extends AuthCommandService>(
  service: Context.Key<I, S>,
  descriptor: AtlassianCliDescriptor,
  options: AuthCommandOptions
) => {
  const withAuth = <A, Err, R>(f: (auth: S) => Effect.Effect<A, Err, R>) => Effect.flatMap(Effect.service(service), f)
  const loginHint = `${descriptor.commandName} auth login`

  const create = Command.make("create", {}, () =>
    Effect.gen(function*() {
      yield* Console.log(`
Creating OAuth app in Atlassian Developer Console...

1. Browser will open to create a new OAuth 2.0 (3LO) app
2. Enter app name (e.g., "${descriptor.productName} CLI")
3. After creation, go to "Permissions" and add:
${scopeInstructions(descriptor, options.apiSection)}
4. Go to "Authorization" and set callback URL:
   ${CALLBACK_URL}
5. Go to "Settings" and copy Client ID and Secret
6. Run: ${descriptor.commandName} auth configure --client-id <ID> --client-secret <SECRET>
`)
      yield* visit(CREATE_APP_URL)
    })).pipe(Command.withDescription("Create OAuth app in Atlassian Developer Console"))

  // Opens the app list, not the app: the console addresses an app by an id that is not the OAuth
  // client id, and the client id is the only app identifier the CLI stores.
  const manage = Command.make("manage", {}, () =>
    Effect.gen(function*() {
      yield* Console.log(`
Opening the Atlassian Developer Console app list...

Select your OAuth app, then under "Permissions" make sure every scope below is
enabled. \`${loginHint}\` requests all of them, and Atlassian rejects an
authorization request naming a scope the app does not have — so a missing scope
here fails the login itself, not just the command that needed it.

${scopeInstructions(descriptor, options.apiSection)}

Under "Authorization", the callback URL must be:
   ${CALLBACK_URL}

After adding scopes, run: ${loginHint}
`)
      yield* visit(CONSOLE_APPS_URL)
    })).pipe(Command.withDescription("Open the Atlassian Developer Console to edit the OAuth app's scopes"))

  const configure = Command.make(
    "configure",
    {
      clientId: Flag.String("client-id").pipe(
        Flag.withDescription("OAuth client ID from Atlassian Developer Console"),
        Flag.optional
      ),
      clientSecret: Flag.String("client-secret").pipe(Flag.withDescription("OAuth client secret"), Flag.optional)
    },
    ({ clientId, clientSecret }) =>
      withAuth((auth) =>
        Effect.gen(function*() {
          const id = Option.isSome(clientId)
            ? clientId.value
            : yield* Prompt.String({ message: "Enter OAuth client ID:" })
          const secret = Option.isSome(clientSecret)
            ? clientSecret.value
            : yield* Prompt.String({ message: "Enter OAuth client secret:" })
          yield* auth.configure({ clientId: id, clientSecret: secret })
          yield* Console.log(`OAuth configured. Run '${loginHint}' to authenticate.`)
        })
      )
  ).pipe(Command.withDescription("Configure OAuth client credentials"))

  const login = Command.make(
    "login",
    {
      site: Flag.String("site").pipe(
        Flag.withDescription("Site URL to use (for accounts with multiple sites)"),
        Flag.optional
      )
    },
    ({ site }) =>
      withAuth((auth) =>
        Effect.gen(function*() {
          const sites = yield* auth.login(Option.isSome(site) ? { siteUrl: site.value } : undefined)
          if (Array.isArray(sites) && sites.length > 0) {
            yield* Console.log("\nRe-run with --site to select a specific site.")
          }
        })
      )
  ).pipe(Command.withDescription("Authenticate with Atlassian via OAuth"))

  const logout = Command.make(
    "logout",
    {},
    () => withAuth((auth) => auth.logout().pipe(Effect.andThen(Console.log("Logged out"))))
  ).pipe(
    Command.withDescription("Remove stored authentication")
  )

  const status = Command.make("status", {}, () =>
    withAuth((auth) =>
      Effect.gen(function*() {
        const profile = yield* auth.getActiveProfile()
        if (profile === null) {
          return yield* Console.log(`Not logged in. Use '${loginHint}' to authenticate.`)
        }
        const user = profile.token.user
        yield* Console.log(`Active profile: ${profile.name}`)
        yield* Console.log(`Account: ${user !== undefined ? `${user.name} (${user.email})` : "unknown user"}`)
        yield* Console.log(`Site: ${profile.token.site_url}`)
        yield* Console.log(`Profile ID: ${profile.id}`)
      })
    )).pipe(Command.withDescription("Show authentication status"))

  const profiles = Command.make("profiles", {}, () =>
    withAuth((auth) =>
      Effect.gen(function*() {
        const [stored, active] = yield* Effect.all([auth.listProfiles(), auth.getActiveProfile()])
        if (stored.length === 0) {
          return yield* Console.log(`No auth profiles. Use '${loginHint}' to authenticate.`)
        }
        for (const profile of stored) {
          yield* Console.log(`${active?.id === profile.id ? "*" : " "} ${profile.id}`)
          yield* Console.log(`    ${profile.name}`)
          yield* Console.log(`    ${profile.token.site_url}`)
        }
      })
    )).pipe(Command.withDescription("List stored auth profiles"))

  const profile = Argument.String("profile").pipe(
    Argument.withDescription("Profile ID, name, site URL, cloud ID, or account ID")
  )

  const use = Command.make(
    "use",
    { profile },
    ({ profile }) =>
      withAuth((auth) =>
        Effect.flatMap(
          auth.switchProfile(profile),
          (selected) =>
            Console.log(selected === null ? `Profile not found: ${profile}` : `Active profile: ${selected.name}`)
        )
      )
  ).pipe(Command.withDescription("Switch active auth profile"))

  const remove = Command.make(
    "remove",
    { profile },
    ({ profile }) =>
      withAuth((auth) =>
        Effect.flatMap(
          auth.removeProfile(profile),
          (removed) =>
            Console.log(removed === null ? `Profile not found: ${profile}` : `Removed profile: ${removed.name}`)
        )
      )
  ).pipe(Command.withDescription("Remove stored auth profile"))

  return Command.make("auth").pipe(
    Command.withDescription("Manage OAuth authentication"),
    Command.withSubcommands([create, manage, configure, login, logout, status, profiles, use, remove])
  )
}
