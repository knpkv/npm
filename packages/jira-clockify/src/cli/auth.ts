/**
 * Auth commands: jira (create/configure/login/logout/status), clockify (setup/status), combined status.
 *
 * @module
 */
import { make as makeClockifyApi } from "@knpkv/clockify-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import { Console, Data, Effect, Option, Predicate, Redacted, Schema } from "effect"
import { Command, Flag as Options, Prompt } from "effect/cli"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as ChildProcess from "effect/process/ChildProcess"
import { ClockifyAuth } from "../services/ClockifyAuth.js"
import { JiraAccess } from "../services/JiraAccess.js"
import { CONNECT_JIRA_COMMAND } from "../utils/hints.js"
import { CommandFailed, requireTerminal, toCommandFailed } from "./CommandFailed.js"

export class InvalidClockifyApiKeyError extends Data.TaggedError("InvalidClockifyApiKeyError")<{}> {
  override get message(): string {
    return "Invalid API key — check the value and try again"
  }
}

/**
 * A Clockify request failed for a reason other than the key: the network, an unexpected status, or a
 * response this client cannot decode. Names the operation, so a decode mismatch is not mistaken for
 * a missing workspace or a bad key.
 */
export class ClockifyRequestError extends Data.TaggedError("ClockifyRequestError")<{
  readonly operation: "getLoggedUser" | "getWorkspacesOfUser"
  readonly cause: unknown
}> {
  override get message(): string {
    const reason = Predicate.hasProperty(this.cause, "message") ? String(this.cause.message) : String(this.cause)
    return `Clockify ${this.operation} failed: ${reason}`
  }
}

const ClockifyUser = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String)
})

const ClockifyWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String
})

type ClockifyWorkspace = typeof ClockifyWorkspace.Type

const decodeClockifyUser = Schema.decodeUnknownEffect(ClockifyUser)
const decodeClockifyWorkspaces = Schema.decodeUnknownEffect(Schema.Array(ClockifyWorkspace))

/** Only Clockify's own rejection of the key means the key is wrong. */
const isRejectedKey = (error: HttpClientError.HttpClientError | Schema.SchemaError): boolean =>
  error._tag === "HttpClientError" && (error.response?.status === 401 || error.response?.status === 403)

/**
 * The account behind an API key: who it is and which workspaces it can use. An empty list is a real
 * answer; any failure is typed, so setup never reports "no workspaces" for a request that failed.
 */
export const loadClockifyAccount = Effect.fn("ClockifyAuth.loadClockifyAccount")(
  function*(client: ReturnType<typeof makeClockifyApi>) {
    const user = yield* client.getLoggedUser(undefined).pipe(
      Effect.flatMap(decodeClockifyUser),
      Effect.mapError((cause) =>
        isRejectedKey(cause)
          ? new InvalidClockifyApiKeyError()
          : new ClockifyRequestError({ operation: "getLoggedUser", cause })
      )
    )
    const workspaces = yield* client.getWorkspacesOfUser(undefined).pipe(
      Effect.flatMap(decodeClockifyWorkspaces),
      Effect.mapError((cause) =>
        isRejectedKey(cause)
          ? new InvalidClockifyApiKeyError()
          : new ClockifyRequestError({ operation: "getWorkspacesOfUser", cause })
      )
    )
    return { user, workspaces }
  }
)

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

const apiTokenPage = "https://id.atlassian.com/manage-profile/security/api-tokens"

/**
 * Asks for a site, email and API token, checks them against Jira and saves them. The token is read
 * without echo and never printed; a failed check names its cause and saves nothing.
 */
export const connectJiraWithToken = (given: {
  readonly site: Option.Option<string>
  readonly email: Option.Option<string>
}) =>
  Effect.gen(function*() {
    const access = yield* JiraAccess
    yield* requireTerminal(`Run ${CONNECT_JIRA_COMMAND} in a terminal to enter the API token.`)
    yield* Console.log(`Create an API token at ${apiTokenPage}, then paste it here.`)
    const site = Option.isSome(given.site)
      ? given.site.value
      : yield* Prompt.String({ message: "Jira address (your-team.atlassian.net):" })
    const email = Option.isSome(given.email)
      ? given.email.value
      : yield* Prompt.String({ message: "Email you sign in to Atlassian with:" })
    const apiToken = yield* Prompt.Password({ message: "API token:" })
    yield* Console.log("Checking with Jira...")
    const verified = yield* access.verifyToken({ site, email, apiToken })
    yield* access.saveToken(verified)
    yield* Console.log(`Jira connected: ${verified.displayName} on ${verified.siteUrl}.`)
    return verified
  }).pipe(
    Effect.catchTag("QuitError", () => Effect.fail(new CommandFailed({ message: "Jira was not connected." }))),
    Effect.mapError(toCommandFailed)
  )

const jiraToken = Command.make(
  "token",
  {
    site: Options.String("site").pipe(
      Options.withDescription("Your Jira address, such as your-team.atlassian.net"),
      Options.optional
    ),
    email: Options.String("email").pipe(
      Options.withDescription("The email you sign in to Atlassian with"),
      Options.optional
    )
  },
  (given) => Effect.asVoid(connectJiraWithToken(given))
).pipe(Command.withDescription("Connect Jira with an API token (recommended)"))

const jiraCreate = Command.make(
  "create",
  {},
  () =>
    Effect.gen(function*() {
      yield* Console.log(`
Advanced: connect Jira through your own Atlassian OAuth app.
For most people ${CONNECT_JIRA_COMMAND} is simpler.

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
      const url = "https://developer.atlassian.com/console/myapps/create-3lo-app/"
      const exitCode = (command: ChildProcess.Command) =>
        Effect.scoped(command.pipe(Effect.flatMap((handle) => handle.exitCode)))

      yield* exitCode(ChildProcess.make("open", [url])).pipe(
        Effect.catch(() => exitCode(ChildProcess.make("xdg-open", [url]))),
        Effect.catch(() => exitCode(ChildProcess.make("rundll32.exe", ["url.dll,FileProtocolHandler", url]))),
        Effect.asVoid,
        Effect.catch(() => Effect.void)
      )
    })
).pipe(Command.withDescription("Advanced: open the Atlassian console to create your own OAuth app"))

const jiraConfigure = Command.make(
  "configure",
  {
    clientId: Options.String("client-id").pipe(Options.withDescription("OAuth client ID"), Options.optional),
    clientSecret: Options.String("client-secret").pipe(Options.withDescription("OAuth client secret"), Options.optional)
  },
  ({ clientId, clientSecret }) =>
    Effect.gen(function*() {
      const auth = yield* JiraAuth
      if (Option.isNone(clientId) || Option.isNone(clientSecret)) {
        yield* requireTerminal("Pass --client-id and --client-secret.")
      }
      const id = Option.isSome(clientId)
        ? clientId.value
        : yield* Prompt.String({ message: "Enter OAuth client ID:" })

      const secret = Option.isSome(clientSecret)
        ? clientSecret.value
        : yield* Prompt.String({ message: "Enter OAuth client secret:" })

      yield* auth.configure({ clientId: id, clientSecret: secret })
      yield* Console.log("OAuth configured. Run: jcf auth jira login")
    }).pipe(Effect.mapError(toCommandFailed))
).pipe(Command.withDescription("Advanced: store your OAuth app's client ID and secret"))

const jiraLogin = Command.make(
  "login",
  { site: Options.String("site").pipe(Options.withDescription("Jira site URL"), Options.optional) },
  ({ site }) =>
    Effect.gen(function*() {
      const auth = yield* JiraAuth
      if (!(yield* auth.isConfigured())) {
        return yield* new CommandFailed({
          message: `No OAuth app is configured. Run ${CONNECT_JIRA_COMMAND} to use an API token instead, ` +
            "or jcf auth jira configure to set up your own OAuth app."
        })
      }
      const result = yield* auth.login(Option.isSome(site) ? { siteUrl: site.value } : undefined)
      if (Array.isArray(result) && result.length > 0) {
        yield* Console.log("\nRe-run with --site <url> to select a specific site.")
      }
    }).pipe(Effect.mapError(toCommandFailed))
).pipe(Command.withDescription("Advanced: sign in through your OAuth app in the browser"))

const jiraLogout = Command.make(
  "logout",
  {},
  () =>
    Effect.gen(function*() {
      const access = yield* JiraAccess
      const auth = yield* JiraAuth
      const removedToken = yield* access.removeToken
      const oauth = yield* auth.isLoggedIn()
      if (oauth) yield* auth.logout()
      yield* Console.log(removedToken || oauth ? "Jira disconnected." : "Jira was not connected.")
    }).pipe(Effect.mapError(toCommandFailed))
).pipe(Command.withDescription("Disconnect Jira: remove the API token and sign out of OAuth"))

/** One line saying how Jira is connected, or what to run when it is not. */
const jiraStatusLine = JiraAccess.use((access) => access.connection).pipe(
  Effect.map(Option.match({
    onNone: () => `Jira:     not connected. Run ${CONNECT_JIRA_COMMAND}`,
    onSome: (connection) =>
      `Jira:     connected as ${connection.displayName === "" ? "unknown user" : connection.displayName} on ` +
      `${connection.siteUrl} (${connection.method === "api-token" ? "API token" : "OAuth app"})`
  })),
  Effect.catch((error) => Effect.succeed(`Jira:     ${error.message}`))
)

const jiraStatus = Command.make("status", {}, () => Effect.flatMap(jiraStatusLine, Console.log)).pipe(
  Command.withDescription("Show whether Jira is connected, and how")
)

const authJira = Command.make(
  "jira",
  {},
  () => Console.log(`Connect Jira: ${CONNECT_JIRA_COMMAND}. Run jcf auth jira --help for every option.`)
).pipe(
  Command.withDescription("Connect Jira with an API token, or with your own OAuth app (advanced)"),
  Command.withSubcommands([jiraToken, jiraStatus, jiraLogout, jiraCreate, jiraConfigure, jiraLogin])
)

// ---------------------------------------------------------------------------
// Clockify API key
// ---------------------------------------------------------------------------

const clockifyBaseUrl = "https://api.clockify.me/api"

/**
 * Asks for a Clockify API key (unless given), checks it, picks a workspace and saves it. A key that
 * Clockify refuses, a failed request and an account with no workspace each fail with their own line.
 */
export const connectClockify = (given: Option.Option<string>) =>
  Effect.gen(function*() {
    const auth = yield* ClockifyAuth
    if (Option.isNone(given)) {
      yield* requireTerminal("Pass the key with --api-key, or run jcf auth clockify setup in a terminal.")
      yield* Console.log("Get your API key from https://app.clockify.me/manage-api-keys")
    }
    const apiKey = Option.isSome(given)
      ? given.value
      : Redacted.value(yield* Prompt.Password({ message: "Clockify API key:" }))
    if (apiKey.trim() === "") {
      return yield* new CommandFailed({ message: "No API key given; Clockify was not connected." })
    }

    yield* Console.log("Checking with Clockify...")
    const httpClient = yield* HttpClient.HttpClient
    const client = makeClockifyApi(httpClient, { apiKey: Redacted.make(apiKey), baseUrl: clockifyBaseUrl })
    const { user, workspaces } = yield* loadClockifyAccount(client)

    const [first] = workspaces
    if (first === undefined) {
      return yield* new CommandFailed({
        message: "This Clockify account has no workspace. Create one at https://app.clockify.me, then run this again."
      })
    }
    const workspace = workspaces.length === 1 ? first : yield* Prompt.Select({
      message: "Workspace:",
      choices: workspaces.map((candidate) => ({ title: candidate.name, value: candidate }))
    })

    yield* auth.save({ apiKey, workspaceId: workspace.id, userId: user.id, baseUrl: clockifyBaseUrl })
    yield* Console.log(`Clockify connected: ${user.name ?? user.email ?? user.id}, workspace ${workspace.name}.`)
  }).pipe(
    Effect.catchTag("QuitError", () => Effect.fail(new CommandFailed({ message: "Clockify was not connected." }))),
    Effect.mapError(toCommandFailed)
  )

export const clockifySetup = Command.make(
  "setup",
  {
    apiKey: Options.String("api-key").pipe(
      Options.withDescription("Clockify API key, for scripts; without it the key is asked for and not echoed"),
      Options.optional
    )
  },
  ({ apiKey }) => connectClockify(apiKey)
).pipe(Command.withDescription("Connect Clockify with an API key"))

/** One line saying which Clockify workspace is connected, or what to run when none is. */
const clockifyStatusLine = Effect.gen(function*() {
  const auth = yield* ClockifyAuth
  if (!(yield* auth.isConfigured)) return "Clockify: not connected. Run jcf auth clockify setup"
  const config = yield* auth.getConfig
  const httpClient = yield* HttpClient.HttpClient
  const account = yield* Effect.result(loadClockifyAccount(makeClockifyApi(httpClient, config)))
  if (account._tag === "Failure") {
    return `Clockify: connected, workspace ${config.workspaceId} (could not read its name: ${account.failure.message})`
  }
  const name = account.success.workspaces.find((workspace) => workspace.id === config.workspaceId)?.name
  return `Clockify: connected, workspace ${name ?? `${config.workspaceId}, which this key can no longer see`}`
}).pipe(Effect.catch((error) => Effect.succeed(`Clockify: ${error.message}. Run jcf auth clockify setup`)))

const clockifyStatus = Command.make("status", {}, () => Effect.flatMap(clockifyStatusLine, Console.log)).pipe(
  Command.withDescription("Show whether Clockify is connected, and to which workspace")
)

const authClockify = Command.make(
  "clockify",
  {},
  () => Console.log("Connect Clockify: jcf auth clockify setup. Run jcf auth clockify --help for every option.")
).pipe(
  Command.withDescription("Connect Clockify with an API key"),
  Command.withSubcommands([clockifySetup, clockifyStatus])
)

// ---------------------------------------------------------------------------
// Combined status
// ---------------------------------------------------------------------------

/** Both systems' status lines, Jira first. */
export const printAuthStatus = Effect.gen(function*() {
  yield* Console.log(yield* jiraStatusLine)
  yield* Console.log(yield* clockifyStatusLine)
})

const authStatus = Command.make("status", {}, () => printAuthStatus).pipe(
  Command.withDescription("Show whether Jira and Clockify are connected")
)

/** Top-level `auth` command with jira/clockify/status subcommands. */
export const auth = Command.make("auth", {}, () => printAuthStatus).pipe(
  Command.withDescription("Connect Jira and Clockify, and see which are connected"),
  Command.withSubcommands([authJira, authClockify, authStatus])
)
