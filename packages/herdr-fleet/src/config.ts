import { Config, Effect, FileSystem, Option, Path, Schema } from "effect"
import { FleetValidationError } from "./errors.js"
import { HostConfiguration } from "./model.js"

export const loadConfiguration = Effect.fn("FleetConfiguration.load")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const text = yield* fileSystem.readFileString(path).pipe(
      Effect.mapError((cause) =>
        new FleetValidationError({
          // A first run has no file yet: say where it is looked for and how to point elsewhere.
          detail: cause.reason._tag === "NotFound"
            ? `no fleet configuration at ${path}; create it, or set FLEET_CONFIG_PATH to an existing file`
            : `cannot read ${path}: ${String(cause)}`
        })
      )
    )
    const unknown = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: (cause) =>
        new FleetValidationError({
          detail: `invalid JSON in ${path}: ${String(cause)}`
        })
    })
    return yield* Schema.decodeUnknownEffect(HostConfiguration, {
      onExcessProperty: "error"
    })(unknown).pipe(
      Effect.mapError(
        (error) =>
          new FleetValidationError({
            detail: `invalid fleet configuration: ${String(error)}`
          })
      )
    )
  }
)

/** Keeps a host name's letters, digits, dots and dashes; anything else becomes a dash, ends are trimmed. */
const fleetHostName = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9.-]+/gu, "-").slice(0, 253).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "")
  return cleaned.length === 0 ? "localhost" : cleaned
}

/**
 * A computer outside any fleet: its own local hub on 127.0.0.1:4778, no tailnet, no peers, no push.
 * The state directory follows XDG (`$XDG_STATE_HOME/fleet`, else `$HOME/.local/state/fleet`). Nix jobs
 * are refused on such a computer (see `nixJobs`), so `repository` and `checkCommand` are never run.
 * Built through `HostConfiguration` itself, so a default that broke its rules fails here, loudly.
 */
export const standaloneDefaults = Effect.gen(function*() {
  const home = yield* Config.String("HOME")
  const stateHome = yield* Config.option(Config.String("XDG_STATE_HOME"))
  const hostname = yield* Config.option(Config.String("HOSTNAME"))
  const host = fleetHostName(Option.getOrElse(hostname, () => ""))
  const stateDirectory = Option.match(Option.filter(stateHome, (value) => value.length > 0), {
    onNone: () => `${home}/.local/state/fleet`,
    onSome: (value) => `${value}/fleet`
  })
  return yield* Schema.decodeUnknownEffect(HostConfiguration)({
    host,
    repository: home,
    stateDirectory,
    crossHost: false,
    port: 4777,
    localPort: 4778,
    approvalPort: 4779,
    allowedUsers: [],
    approvalNodes: [],
    machines: [{ host, nodeId: "local" }],
    applyMachines: [],
    checkCommand: ["nix", "flake", "check"],
    applyCommand: null,
    browserMcpRecoverCommand: null,
    coordinatorCommand: ["host-coordinator"],
    herdrCommand: "herdr",
    tailscaleCommand: "tailscale",
    approvalTls: null,
    approvalHub: { host, nodeId: "local", url: "https://localhost:4779/" },
    pushAllowedOrigins: [],
    pushSubject: "mailto:hostd@localhost"
  }).pipe(
    Effect.mapError((error) =>
      new FleetValidationError({ detail: `standalone defaults are invalid: ${String(error)}` })
    )
  )
})

/** Where hostd's configuration came from: the operator's file, or the standalone defaults. */
export type LoadedConfiguration =
  | { readonly _tag: "File"; readonly path: string; readonly config: HostConfiguration }
  | { readonly _tag: "Standalone"; readonly path: string; readonly config: HostConfiguration }

/**
 * The fleet configuration at `path`, or the standalone defaults when nothing exists there. Only an
 * absent entry falls back, and only with `standaloneWhenMissing` (hostd passes false for an explicit
 * `FLEET_CONFIG_PATH`). An entry that does not resolve, such as a managed symlink a switch briefly left
 * dangling, fails; an unreadable, malformed or invalid file is the operator's and still fails.
 */
export const loadConfigurationOrStandalone = Effect.fn("FleetConfiguration.loadOrStandalone")(
  function*(path: string, options: { readonly standaloneWhenMissing?: boolean } = {}) {
    const fileSystem = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const directory = paths.dirname(path)
    // The parent's listing names the entry without following it, so a dangling symlink still counts.
    const listed = yield* fileSystem.readDirectory(directory).pipe(
      Effect.map((names) => names.includes(paths.basename(path))),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(false)
          : Effect.fail(new FleetValidationError({ detail: `cannot read ${directory}: ${String(error)}` }))
      )
    )
    const resolves = yield* fileSystem.exists(path).pipe(
      Effect.mapError((error) => new FleetValidationError({ detail: `cannot read ${path}: ${String(error)}` }))
    )
    // A case-insensitive volume can resolve `config.json` to a listed `Config.json`: that is present too.
    if (!listed && !resolves && options.standaloneWhenMissing !== false) {
      return { _tag: "Standalone", path, config: yield* standaloneDefaults } satisfies LoadedConfiguration
    }
    if (listed) {
      if (!resolves) {
        return yield* new FleetValidationError({
          detail: `fleet configuration at ${path} exists but does not resolve; is it a symlink whose target is missing?`
        })
      }
    }
    return { _tag: "File", path, config: yield* loadConfiguration(path) } satisfies LoadedConfiguration
  }
)
