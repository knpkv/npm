/**
 * `herdr-hub apps`: install, update, roll back, remove and inspect hub apps.
 *
 * Mental model:
 * - **A thin client.** Every write goes through `AppsStore` and the installer; the CLI never talks to a running app.
 *   It works with the hub down: the hub reads `apps.json` when it starts.
 * - **The hub, when it answers**, is asked on its loopback listener: `GET /v1/apps` for the apps' states (to wait for a
 *   removed app to stop, or for an update to start or crashloop), and `POST /v1/apps/<id>/restart` with this hub
 *   start's CLI token. `logs` needs no hub: it reads `<hubState>/logs/<id>.log` (and the previous `.1`).
 * - **Trust is asked, not assumed.** Inside `trust.scopes` the CLI asks y/N (`--yes` answers for you); without a
 *   terminal and without `--yes` it refuses. `trust add` needs a terminal, so a script can't widen trust silently.
 *
 * @since 0.1.0
 */
import { openBrowser } from "@knpkv/browser-pairing/launch"
import { AppId, type AppsConfigInvalid, type AppState, AppStates } from "@knpkv/hub-app"
import {
  Clock,
  Console,
  Context,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Redacted,
  Runtime,
  Schema,
  Terminal
} from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { HttpClient, HttpClientRequest } from "effect/http"
import { cliTokenHeader, readCliToken } from "./cli-token.js"
import {
  type AppIdConflict,
  type AppInstallDeclined,
  type AppInstaller,
  type AppNoPreviousVersion,
  AppNotInstalled,
  type InstallerOptions
} from "./installer.js"
import type { AppInstallFailed, NotAHubApp, NpmUnavailable } from "./npm.js"
import type { AppsConfigManaged, AppsLockBusy, AppsStore } from "./store.js"
import { type AppNotTrusted, AppsNeedTerminal } from "./trust.js"

/** The hub didn't answer a request that needs it. */
export class HubNotRunning extends Schema.TaggedError<HubNotRunning>()("HubNotRunning", {}) {
  override get message() {
    return "The hub is not running."
  }
}

/** An update's new version kept stopping after the hub started it. */
export class AppUpdateCrashloop extends Schema.TaggedError<AppUpdateCrashloop>()("AppUpdateCrashloop", {
  id: Schema.String,
  version: Schema.String
}) {
  override get message() {
    return `${this.id} ${this.version} keeps stopping. Run \`herdr-hub apps rollback ${this.id}\` to go back.`
  }
}

/** What the hub says about the apps it runs, when it answers. */
export interface HubClient {
  /** The apps' states, or none when the hub doesn't answer. */
  readonly states: Effect.Effect<Option.Option<ReadonlyArray<AppState>>>
  /** Restarts `id`: true when the hub restarted it, false when it runs no such app. */
  readonly restart: (id: AppId) => Effect.Effect<boolean, HubNotRunning>
  /** A one-time link that opens the hub's page logged in as the local user (`herdr-hub login`). */
  readonly loginUrl: Effect.Effect<string, HubNotRunning>
}

/** Everything a command needs; `main.ts` builds it, tests stub it. */
export interface AppsCliEnvironment {
  readonly store: AppsStore
  /** The installer, asking the trust question with `confirm`. */
  readonly installer: (confirm: InstallerOptions["confirm"]) => Effect.Effect<AppInstaller, NpmUnavailable>
  readonly hub: HubClient
  /** `<hubState>/logs`. */
  readonly logsDirectory: string
  /** Whether stdin is a terminal (the y/N questions need one). */
  readonly interactive: boolean
  /** How long to wait for an updated app to settle; 2 min by default. */
  readonly settleTimeout?: Duration.Duration
}

export class AppsCli extends Context.Service<AppsCli, AppsCliEnvironment>()("@knpkv/herdr-hub/AppsCli") {}

const appState = (states: ReadonlyArray<AppState>, id: AppId) =>
  states.find((state) => (state._tag === "Ready" ? state.manifest.id : state.id) === id)

const LoginCode = Schema.Struct({ code: Schema.String.check(Schema.isMaxLength(128)) })

/** The hub over HTTP on its loopback port; `url` null when no port is configured. */
export const makeHubClient = Effect.fn("AppsCli.hubClient")(function*(options: {
  readonly url: string | null
  /** `<hubState>/cli`, where the hub writes this start's token. */
  readonly tokenDirectory: string
}) {
  const http = yield* HttpClient.HttpClient
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const decodeStates = Schema.decodeUnknownEffect(AppStates)
  const url = options.url
  const states: HubClient["states"] = url === null
    ? Effect.succeed(Option.none())
    : http.get(new URL("v1/apps", url).href).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeStates),
      Effect.map((body): Option.Option<ReadonlyArray<AppState>> => Option.some(body.apps)),
      Effect.timeoutOrElse({ duration: Duration.seconds(5), orElse: () => Effect.succeed(Option.none()) }),
      // A refused connection, a non-JSON or undecodable answer: the hub isn't answering for apps.
      Effect.catchTags({
        HttpClientError: () => Effect.succeed(Option.none()),
        SchemaError: () => Effect.succeed(Option.none())
      })
    )
  const restart = Effect.fn("AppsCli.restart")(function*(id: AppId) {
    if (options.url === null) return yield* new HubNotRunning()
    const token = yield* readCliToken(options.tokenDirectory).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => new HubNotRunning())
    )
    const response = yield* HttpClientRequest.post(new URL(`v1/apps/${id}/restart`, options.url).href).pipe(
      HttpClientRequest.setHeader(cliTokenHeader, Redacted.value(token)),
      http.execute,
      Effect.mapError(() => new HubNotRunning())
    )
    if (response.status === 202) return true
    if (response.status === 404) return false
    return yield* new HubNotRunning()
  })
  // The code rides in the fragment, which the browser never sends: no server log, history request or Referer
  // sees it. The CLI token itself never enters a URL.
  const loginUrl = Effect.gen(function*() {
    if (options.url === null) return yield* new HubNotRunning()
    const token = yield* readCliToken(options.tokenDirectory).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => new HubNotRunning())
    )
    const response = yield* HttpClientRequest.post(new URL("v1/session/local-code", options.url).href).pipe(
      HttpClientRequest.setHeader(cliTokenHeader, Redacted.value(token)),
      http.execute,
      Effect.mapError(() => new HubNotRunning())
    )
    if (response.status !== 200) return yield* new HubNotRunning()
    const answer = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(LoginCode)),
      Effect.mapError(() => new HubNotRunning())
    )
    const page = new URL(options.url)
    page.hash = `login=${answer.code}`
    return page.href
  })
  return { states, restart, loginUrl } satisfies HubClient
})

/** Polls `done` against the hub's states every 250 ms until it holds or `timeout` passes; none when the hub is down. */
const untilStates = Effect.fn("AppsCli.untilStates")(function*(
  hub: HubClient,
  timeout: Duration.Duration,
  done: (states: ReadonlyArray<AppState>) => boolean
) {
  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(timeout)
  let last = Option.none<ReadonlyArray<AppState>>()
  while ((yield* Clock.currentTimeMillis) < deadline) {
    last = yield* hub.states
    if (Option.isNone(last) || done(last.value)) return last
    yield* Effect.sleep(Duration.millis(250))
  }
  return last
})

/** Waits (at most 10 s) until the hub no longer runs `id`; returns at once when the hub is down. */
export const waitStopped = (hub: HubClient, id: AppId) =>
  untilStates(hub, Duration.seconds(10), (states) => appState(states, id)?._tag !== "Ready").pipe(Effect.asVoid)

/** Prints the trust lines and asks y/N on `terminal`, or answers yes for `--yes`; refuses without a terminal. */
export const confirmer = (
  action: string,
  flags: { readonly yes: boolean; readonly interactive: boolean },
  terminal: Terminal.Terminal
): InstallerOptions["confirm"] =>
  Effect.fn("AppsCli.confirm")(function*(lines: ReadonlyArray<string>) {
    for (const line of lines) yield* Console.log(line)
    if (flags.yes) return true
    if (!flags.interactive) return yield* new AppsNeedTerminal({ action })
    const answer = yield* terminal.display("Install it? [y/N] ").pipe(
      Effect.andThen(terminal.readLine),
      // The terminal closed or the user quit: no answer is a no.
      Effect.catchTags({ QuitError: () => Effect.succeed(""), PlatformError: () => Effect.succeed("") })
    )
    return /^y(es)?$/iu.test(answer.trim())
  })

/** The installer for one command, asking as `action` with the command's `--yes`. */
const installerFor = Effect.fn("AppsCli.installerFor")(function*(action: string, yes: boolean) {
  const cli = yield* AppsCli
  const terminal = yield* Terminal.Terminal
  return yield* cli.installer(confirmer(action, { yes, interactive: cli.interactive }, terminal))
})

const appIdArgument = Argument.String("id").pipe(Argument.withSchema(AppId))

const list = Command.make(
  "list",
  { json: Flag.Boolean("json").pipe(Flag.withDefault(false)) },
  ({ json }) =>
    Effect.gen(function*() {
      const cli = yield* AppsCli
      const config = yield* cli.store.read
      const states = yield* cli.hub.states
      const rows = config.apps.map((app) => ({
        id: app.id,
        package: app.package,
        version: app.version,
        enabled: app.enabled,
        state: Option.match(states, {
          onNone: () => "hub not running",
          onSome: (all) => {
            const state = appState(all, app.id)
            return state === undefined ? "not registered" : state._tag === "Ready" ? "ready" : state.reason
          }
        })
      }))
      if (json) return yield* Console.log(JSON.stringify({ managedBy: config.managedBy, apps: rows }))
      if (rows.length === 0) {
        return yield* Console.log(`No apps installed (apps.json is managed by ${config.managedBy}).`)
      }
      for (const row of rows) {
        yield* Console.log(`${row.id}  ${row.package}@${row.version}  ${row.enabled ? row.state : "disabled"}`)
      }
    })
)

/** `<pkg>` or `<pkg>@<spec>`; a scope's leading `@` is not a separator. */
export const splitSpec = (input: string): { readonly name: string; readonly spec: string | null } => {
  const at = input.lastIndexOf("@")
  return at <= 0 ? { name: input, spec: null } : { name: input.slice(0, at), spec: input.slice(at + 1) }
}

const add = Command.make(
  "add",
  {
    package: Argument.String("package"),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    allowScripts: Flag.Boolean("allow-scripts").pipe(Flag.withDefault(false))
  },
  (input) =>
    Effect.gen(function*() {
      const installer = yield* installerFor("apps add", input.yes)
      const { name, spec } = splitSpec(input.package)
      const entry = yield* installer.add(name, spec ?? "latest", { allowScripts: input.allowScripts })
      yield* Console.log(`Installed ${entry.id} (${entry.package}@${entry.version}).`)
    })
)

const remove = Command.make("remove", {
  id: appIdArgument,
  keepFiles: Flag.Boolean("keep-files").pipe(Flag.withDefault(false))
}, (input) =>
  Effect.gen(function*() {
    const installer = yield* installerFor("apps remove", false)
    yield* installer.remove(input.id, { keepFiles: input.keepFiles })
    yield* Console.log(`Removed ${input.id}.`)
  }))

/**
 * After an update the hub swaps the app; with `--wait` (the default) the CLI watches it settle: ready is done, a
 * crashloop fails with the rollback hint, and a hub that doesn't answer leaves it to the next start.
 */
const update = Command.make(
  "update",
  {
    target: Argument.String("id").pipe(Argument.optional),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
    allowScripts: Flag.Boolean("allow-scripts").pipe(Flag.withDefault(false)),
    noWait: Flag.Boolean("no-wait").pipe(Flag.withDefault(false))
  },
  (input) =>
    Effect.gen(function*() {
      const cli = yield* AppsCli
      const installer = yield* installerFor("apps update", input.yes)
      const targets = Option.match(input.target, {
        onNone: () =>
          cli.store.read.pipe(Effect.map((config) => config.apps.map((app) => ({ id: app.id, spec: null })))),
        onSome: (target) => {
          const { name, spec } = splitSpec(target)
          return Schema.decodeUnknownEffect(AppId)(name).pipe(Effect.map((id) => [{ id, spec }]))
        }
      })
      for (const target of yield* targets) {
        const outcome = yield* installer.update(target.id, target.spec, { allowScripts: input.allowScripts })
        if (outcome === null) {
          yield* Console.log(`${target.id} is up to date.`)
          continue
        }
        yield* Console.log(`Updated ${target.id} from ${outcome.from} to ${outcome.to}.`)
        if (input.noWait) continue
        const settled = yield* untilStates(cli.hub, cli.settleTimeout ?? Duration.minutes(2), (states) => {
          const state = appState(states, target.id)
          return state?._tag === "Ready" && state.manifest.version === outcome.to ||
            state?._tag === "Unavailable" && state.reason === "crashloop"
        })
        const state = Option.map(settled, (states) => appState(states, target.id))
        if (Option.isSome(state) && state.value?._tag === "Unavailable" && state.value.reason === "crashloop") {
          return yield* new AppUpdateCrashloop({ id: target.id, version: outcome.to })
        }
      }
    })
)

const rollback = Command.make("rollback", { id: appIdArgument }, (input) =>
  Effect.gen(function*() {
    const installer = yield* installerFor("apps rollback", false)
    const outcome = yield* installer.rollback(input.id)
    yield* Console.log(`Rolled ${input.id} back from ${outcome.from} to ${outcome.to}.`)
  }))

const setEnabled = (name: "enable" | "disable") =>
  Command.make(name, { id: appIdArgument }, (input) =>
    Effect.gen(function*() {
      const cli = yield* AppsCli
      yield* cli.store.withLock((locked) =>
        Effect.gen(function*() {
          const config = yield* locked.read
          if (!config.apps.some((app) => app.id === input.id)) return yield* new AppNotInstalled({ id: input.id })
          yield* locked.write({
            ...config,
            apps: config.apps.map((app) => app.id === input.id ? { ...app, enabled: name === "enable" } : app)
          })
        })
      )
      yield* Console.log(`${name === "enable" ? "Enabled" : "Disabled"} ${input.id}.`)
    }))

const restart = Command.make("restart", { id: appIdArgument }, (input) =>
  Effect.gen(function*() {
    const cli = yield* AppsCli
    const restarted = yield* cli.hub.restart(input.id)
    yield* Console.log(restarted ? `Restarting ${input.id}.` : `The hub runs no app called ${input.id}.`)
  }))

/**
 * `herdr-hub login`: prints a one-time link that opens the hub's page on this computer logged in as the local
 * user, and opens it. The hub mints the code only for this user's CLI token, and the page spends it once.
 */
export const loginCommand = Command.make("login", {}, () =>
  Effect.gen(function*() {
    const cli = yield* AppsCli
    const url = yield* cli.hub.loginUrl
    yield* Console.log(url)
    yield* openBrowser(url)
  })).pipe(Command.withDescription("Open the hub's page on this computer, logged in as the local user"))

/** Prints the app's log (the previous file first); with `--follow`, keeps printing what is appended. */
const logs = Command.make(
  "logs",
  { id: appIdArgument, follow: Flag.Boolean("follow").pipe(Flag.withDefault(false)) },
  (input) =>
    Effect.gen(function*() {
      const cli = yield* AppsCli
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = path.join(cli.logsDirectory, `${input.id}.log`)
      const read = (target: string) =>
        fileSystem.readFileString(target).pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")))
      const previous = yield* read(`${file}.1`)
      let current = yield* read(file)
      if (previous === "" && current === "" && !input.follow) {
        return yield* Console.log(`No log for ${input.id} yet.`)
      }
      yield* Console.log(`${previous}${current}`.replace(/\n$/u, ""))
      while (input.follow) {
        yield* Effect.sleep(Duration.millis(500))
        const next = yield* read(file)
        // A rotation starts the file over: print it from the start.
        const added = next.startsWith(current) ? next.slice(current.length) : next
        if (added !== "") yield* Console.log(added.replace(/\n$/u, ""))
        current = next
      }
    })
)

const trustList = Command.make("list", {}, () =>
  Effect.gen(function*() {
    const cli = yield* AppsCli
    for (const scope of (yield* cli.store.read).trust.scopes) yield* Console.log(scope)
  }))

const trustChange = (name: "add" | "remove") =>
  Command.make(name, { scope: Argument.String("scope") }, (input) =>
    Effect.gen(function*() {
      const cli = yield* AppsCli
      // Widening trust is a person's decision, never a script's.
      if (name === "add" && !cli.interactive) return yield* new AppsNeedTerminal({ action: "trust add" })
      yield* cli.store.withLock((locked) =>
        Effect.gen(function*() {
          const config = yield* locked.read
          const scopes = name === "add"
            ? [...new Set([...config.trust.scopes, input.scope])]
            : config.trust.scopes.filter((scope) => scope !== input.scope)
          yield* locked.write({ ...config, trust: { scopes } })
        })
      )
      yield* Console.log(`${name === "add" ? "Trusted" : "No longer trusting"} ${input.scope}.`)
    }))

const trust = Command.make("trust").pipe(
  Command.withSubcommands([trustList, trustChange("add"), trustChange("remove")])
)

/** A failure already explained on stderr: the runtime exits 1 without printing it again. */
export class AppsCommandFailed extends Schema.TaggedError<AppsCommandFailed>()("AppsCommandFailed", {}) {
  override readonly [Runtime.errorReported] = false
}

/** The failures a user can act on; each has one sentence. */
type Explained =
  | AppsNeedTerminal
  | HubNotRunning
  | AppUpdateCrashloop
  | AppNotInstalled
  | AppIdConflict
  | AppInstallDeclined
  | AppNoPreviousVersion
  | AppNotTrusted
  | AppInstallFailed
  | NotAHubApp
  | NpmUnavailable
  | AppsConfigManaged
  | AppsLockBusy
  | AppsConfigInvalid

/** Every explained tag, once: a tag added to `Explained` and missing here is a type error. */
const explained = {
  AppsNeedTerminal: true,
  HubNotRunning: true,
  AppUpdateCrashloop: true,
  AppNotInstalled: true,
  AppIdConflict: true,
  AppInstallDeclined: true,
  AppNoPreviousVersion: true,
  AppNotTrusted: true,
  AppInstallFailed: true,
  NotAHubApp: true,
  NpmUnavailable: true,
  AppsConfigManaged: true,
  AppsLockBusy: true,
  AppsConfigInvalid: true
} satisfies Record<Explained["_tag"], true>
const explainedTags: ReadonlySet<string> = new Set(Object.keys(explained))

/** What to tell the user for `error`. */
export const failureLine = (error: Explained): string => {
  switch (error._tag) {
    case "AppsNeedTerminal":
    case "AppUpdateCrashloop":
    case "NpmUnavailable":
      return error.message
    case "HubNotRunning":
      return `${error.message} Start it and try again.`
    case "AppNotInstalled":
      return `No app called ${error.id} is installed.`
    case "AppIdConflict":
      return error.with === "core"
        ? `${error.id} is the name of one of the hub's own modules.`
        : `An app called ${error.id} is already installed.`
    case "AppInstallDeclined":
      return "Nothing was installed."
    case "AppNoPreviousVersion":
      return `${error.id} has no previous version to go back to.`
    case "AppNotTrusted":
      return `${error.package} is outside the trusted scopes; run \`herdr-hub apps trust add <scope>\` first.`
    case "AppInstallFailed":
      return `Could not install ${error.package} (${error.stage}): ${error.detail}`
    case "NotAHubApp":
      return `${error.package} is not a hub app: its package.json has no valid hubApp field.`
    case "AppsConfigManaged":
      return "apps.json is managed by nix; edit hub.apps in your nix configuration instead."
    case "AppsLockBusy":
      return `Another apps command is running${
        error.pid === null ? "" : ` (pid ${error.pid})`
      }; try again when it is done.`
    case "AppsConfigInvalid":
      return `${error.path} can't be read as apps.json; fix or remove it.`
  }
}

/**
 * Turns the failures a user can act on into one sentence on stderr and exit 1; anything else (a bug) keeps the
 * runtime's full report.
 */
export const explainFailures = <A, E extends { readonly _tag: string }, R>(command: Effect.Effect<A, E, R>) =>
  command.pipe(
    Effect.catchIf(
      (error): error is Extract<E, Explained> => explainedTags.has(error._tag),
      (error) => Console.error(failureLine(error)).pipe(Effect.andThen(Effect.fail(new AppsCommandFailed())))
    )
  )

/** `herdr-hub apps …`. */
export const appsCommand = Command.make("apps").pipe(
  Command.withSubcommands([
    list,
    add,
    remove,
    update,
    rollback,
    setEnabled("enable"),
    setEnabled("disable"),
    restart,
    logs,
    trust
  ])
)
