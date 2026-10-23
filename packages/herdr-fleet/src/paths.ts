/**
 * Where the hub and its fleet configuration live on this computer: one table, shared by herdr-fleet and
 * herdr-hub, so no second copy of these rules exists.
 *
 * **Mental model**
 *
 * - **Pure table, OS facts at the edge.** {@link hubPathTable} turns the platform, the home directory, the
 *   host name and a handful of environment variables into paths. `HubPaths.fromSystem` reads those facts once;
 *   tests provide {@link HubPaths} with a table built from fixtures and never touch `HOME`.
 * - **POSIX stays where it was.** Linux and macOS keep `~/.config/fleet/config.json`,
 *   `$XDG_STATE_HOME/fleet` (else `~/.local/state/fleet`) and `~/.config/herdr/apps.json`, so no running
 *   host moves.
 * - **Windows follows its own conventions.** Configuration under `%APPDATA%`, state under
 *   `%LOCALAPPDATA%`, or the XDG directories when they are set. File modes do nothing there: owner-only
 *   comes from the user profile's ACL, which covers both.
 * - **The hub's apps** keep their prefixes under `hubData/hub-apps`, their logs and manifest cache under
 *   `hubState/logs` and `hubState/manifests`, and their sockets under `hubRuntime` (`$XDG_RUNTIME_DIR/herdr-hub`,
 *   else `hubState/run`). Each subdirectory has one writer; only `hubRuntime` is ever wiped. On Windows `hubData`
 *   and `hubState` are the same directory, so the subdirectories keep them apart; its apps listen on named pipes,
 *   so it has no runtime directory.
 * - **Overrides win on every OS.** `HERDR_HUB_HOME` puts everything under one directory (`config/`,
 *   `state/`); `HERDR_HUB_CONFIG` names the directory holding `apps.json`. `FLEET_CONFIG_PATH` still
 *   names the fleet configuration file itself (see herdr-hub's config path).
 *
 * @module
 */
import { Config, Context, Effect, Layer, Option, Path } from "effect"
import { homedir, hostname as osHostname } from "node:os"
import { posix, win32 } from "node:path"

/** The environment variables the table reads. Empty values count as unset. */
export interface HubPathsEnvironment {
  readonly HERDR_HUB_HOME?: string | undefined
  readonly HERDR_HUB_CONFIG?: string | undefined
  readonly XDG_CONFIG_HOME?: string | undefined
  readonly XDG_STATE_HOME?: string | undefined
  readonly XDG_DATA_HOME?: string | undefined
  readonly XDG_RUNTIME_DIR?: string | undefined
  readonly APPDATA?: string | undefined
  readonly LOCALAPPDATA?: string | undefined
}

/** What the table is computed from. `windows` follows the platform's path separator. */
export interface HubPathsInput {
  readonly windows: boolean
  /** `os.homedir()`: `HOME` on POSIX, `USERPROFILE` on Windows. */
  readonly home: string
  /** `os.hostname()`. */
  readonly hostname: string
  readonly env: HubPathsEnvironment
}

export interface HubPathTable {
  readonly home: string
  readonly hostname: string
  /** The default fleet configuration file, used when `FLEET_CONFIG_PATH` is unset. */
  readonly fleetConfig: string
  /** The standalone host's state directory (job store, Relay, app tokens). */
  readonly fleetState: string
  /** The installed-apps file, `apps.json`. */
  readonly appsConfig: string
  /** The hub's data: one install prefix per app and version. */
  readonly hubData: string
  /** The hub's own state: app logs, manifest cache. */
  readonly hubState: string
  /** Where the hub's apps listen (owner-only, wiped at hub start); `null` on Windows, which uses named pipes. */
  readonly hubRuntime: string | null
}

const set = (value: string | undefined): string | undefined => value === undefined || value === "" ? undefined : value

/** The paths for `input`. Pure: the same input always gives the same table, on any OS. */
export const hubPathTable = (input: HubPathsInput): HubPathTable => {
  const join = input.windows ? win32.join : posix.join
  const env = input.env
  const hubHome = set(env.HERDR_HUB_HOME)
  const configHome = set(env.XDG_CONFIG_HOME)
  const stateHome = set(env.XDG_STATE_HOME)
  const dataHome = set(env.XDG_DATA_HOME)
  const runtimeHome = set(env.XDG_RUNTIME_DIR)
  const roaming = set(env.APPDATA) ?? join(input.home, "AppData", "Roaming")
  const local = set(env.LOCALAPPDATA) ?? join(input.home, "AppData", "Local")
  const fleetConfig = hubHome !== undefined
    ? join(hubHome, "config", "fleet", "config.json")
    : input.windows
    ? join(configHome ?? roaming, "fleet", "config.json")
    : join(input.home, ".config", "fleet", "config.json")
  const fleetState = hubHome !== undefined
    ? join(hubHome, "state", "fleet")
    : join(stateHome ?? (input.windows ? local : join(input.home, ".local", "state")), "fleet")
  const appsDirectory = set(env.HERDR_HUB_CONFIG) ?? (hubHome !== undefined
    ? join(hubHome, "config")
    : input.windows
    ? configHome === undefined ? join(roaming, "herdr-hub") : join(configHome, "herdr")
    : join(input.home, ".config", "herdr"))
  const hubData = hubHome !== undefined
    ? join(hubHome, "data")
    : join(dataHome ?? (input.windows ? local : join(input.home, ".local", "share")), "herdr-hub")
  const hubState = hubHome !== undefined
    ? join(hubHome, "state", "herdr-hub")
    : join(stateHome ?? (input.windows ? local : join(input.home, ".local", "state")), "herdr-hub")
  const hubRuntime = input.windows
    ? null
    : hubHome !== undefined
    ? join(hubHome, "run")
    : runtimeHome !== undefined
    ? join(runtimeHome, "herdr-hub")
    : join(hubState, "run")
  return {
    home: input.home,
    hostname: input.hostname,
    fleetConfig,
    fleetState,
    appsConfig: join(appsDirectory, "apps.json"),
    hubData,
    hubState,
    hubRuntime
  }
}

const variable = (name: keyof HubPathsEnvironment) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.getOrUndefined))

const environment = Config.all({
  HERDR_HUB_HOME: variable("HERDR_HUB_HOME"),
  HERDR_HUB_CONFIG: variable("HERDR_HUB_CONFIG"),
  XDG_CONFIG_HOME: variable("XDG_CONFIG_HOME"),
  XDG_STATE_HOME: variable("XDG_STATE_HOME"),
  XDG_DATA_HOME: variable("XDG_DATA_HOME"),
  XDG_RUNTIME_DIR: variable("XDG_RUNTIME_DIR"),
  APPDATA: variable("APPDATA"),
  LOCALAPPDATA: variable("LOCALAPPDATA")
})

/** This computer's {@link HubPathTable}, read from the OS facts and the environment. */
const fromSystem = Effect.gen(function*() {
  const paths = yield* Path.Path
  return hubPathTable({
    windows: paths.sep === "\\",
    home: homedir(),
    hostname: osHostname(),
    env: yield* environment
  })
})

/**
 * This computer's {@link HubPathTable}. Executables provide `HubPaths.layer` next to their Node services, or
 * `HubPaths.fromSystem` with `Effect.provideServiceEffect`; tests provide a `hubPathTable(…)` from fixtures.
 */
export class HubPaths extends Context.Service<HubPaths, HubPathTable>()("@knpkv/herdr-fleet/HubPaths") {
  static readonly fromSystem = fromSystem
  static readonly layer = Layer.effect(HubPaths, fromSystem)
}
