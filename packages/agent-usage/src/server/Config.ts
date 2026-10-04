/**
 * Where this Machine's store and agent sessions live, from the environment.
 *
 * - `AGENT_USAGE_HOME` — the store directory (default `~/.local/share/agent-usage`)
 * - `AGENT_USAGE_MACHINE` — the Machine name (default: the short, lower-cased hostname)
 * - `CLAUDE_CONFIG_DIR` / `CODEX_HOME` — the agents' own roots (default `~/.claude`, `~/.codex`)
 * - `CLAUDE_SECURESTORAGE_CONFIG_DIR` — where Claude Code keeps its credentials when it differs from
 *   the config directory; with `CLAUDE_CONFIG_DIR` it decides the macOS Keychain item's name
 * - `AGENT_USAGE_CLAUDE_LIMITS` — the Claude limit samples claude-statusline appends (default
 *   `${XDG_STATE_HOME:-~/.local/state}/agent-usage/claude-limits.jsonl`)
 * - `AGENT_USAGE_PROJECTS` — extra Known Projects, comma-separated (`RPS,ABC`), for projects typed in
 *   sessions before any branch named them
 *
 * @module
 */
import { Config, ConfigProvider, Crypto, Effect, Path, Schema, SchemaTransformation } from "effect"
import { Hex } from "effect/encoding"
import type { SourceRoots } from "../core/Ingest.js"

/** Where Claude Code keeps the OAuth credentials a limit poll reads. */
export interface ClaudeCredentialsLocation {
  /** Linux: `<secure storage dir>/.credentials.json`. */
  readonly file: string
  /** macOS: the login Keychain item's service name… */
  readonly keychainService: string
  /** …and its account, the user name. */
  readonly keychainAccount: string
}

export interface AgentUsageConfig {
  readonly storeDirectory: string
  /** Known Projects from configuration, added to those branches and paths name. */
  readonly projects: ReadonlyArray<string>
  readonly claudeConfigDir: string
  readonly claudeCredentials: ClaudeCredentialsLocation
  readonly roots: SourceRoots
}

const KEYCHAIN_SERVICE = "Claude Code-credentials"

/**
 * Where Claude Code (2.1.289) keeps its credentials, named the way it names them. The secure-storage
 * directory is `CLAUDE_SECURESTORAGE_CONFIG_DIR` when set (empty meaning the default `~/.claude`),
 * else the config directory. The Keychain item is `Claude Code-credentials`, suffixed with the first
 * eight hex digits of the directory's SHA-256 whenever a non-default directory was chosen, under the
 * user's account. Asking for the bare name with a custom directory reads another account's item.
 *
 * An explicitly empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` means the default directory and the bare
 * item name, as in Claude Code, so it is read from an environment that keeps empty values.
 */
const claudeCredentialsLocation = (options: {
  readonly home: string
  readonly user: string
  readonly claudeConfigDir: string
  readonly configDirChosen: boolean
  readonly secureStorageDir: string | undefined
}) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const digests = yield* Crypto.Crypto
    const unsuffixed = options.secureStorageDir === undefined
      ? !options.configDirChosen
      : options.secureStorageDir === ""
    const directory = (options.secureStorageDir === undefined
      ? options.claudeConfigDir
      : options.secureStorageDir === ""
      ? path.join(options.home, ".claude")
      : options.secureStorageDir).normalize("NFC")
    const suffix = unsuffixed
      ? ""
      : `-${Hex.encode(yield* digests.digest("SHA-256", new TextEncoder().encode(directory))).slice(0, 8)}`
    const location: ClaudeCredentialsLocation = {
      file: path.join(directory, ".credentials.json"),
      keychainService: `${KEYCHAIN_SERVICE}${suffix}`,
      keychainAccount: options.user
    }
    return location
  })

/**
 * The Machine name a hostname gives: the part before the first dot, lower-cased, so macOS's
 * `Example-MacBook.local` and `Example-MacBook` name the same Machine.
 */
export const machineName = (hostname: string): string => {
  const short = hostname.split(".")[0]?.trim().toLowerCase() ?? ""
  return short === "" ? "localhost" : short
}

/** A Jira project key as the Booking pattern reads one. */
const ProjectKey = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{1,9}$/u))

/** `RPS, ABC` → `["RPS", "ABC"]`; an entry that is not a project key fails the configuration. */
const Projects = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(ProjectKey),
    SchemaTransformation.transform({
      decode: (raw: string): ReadonlyArray<string> =>
        raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""),
      encode: (keys: ReadonlyArray<string>) => keys.join(",")
    })
  )
)

/**
 * Reads the configuration; `hostname` comes from the executable, the only place that may ask.
 * `exactEnvironment` is the environment with empty values kept, which the executable builds; it
 * is read only where an empty value means something (`CLAUDE_SECURESTORAGE_CONFIG_DIR`).
 * `osUser` is the operating system's name for the user, the Keychain account when `USER` is unset.
 */
export const loadConfig = (
  hostname: string,
  exactEnvironment?: ConfigProvider.ConfigProvider,
  osUser = "claude-code-user"
) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const home = yield* Config.String("HOME")
    const storeDirectory = yield* Config.String("AGENT_USAGE_HOME").pipe(
      Config.withDefault(path.join(home, ".local", "share", "agent-usage"))
    )
    const machine = yield* Config.NonEmptyString("AGENT_USAGE_MACHINE").pipe(
      Config.withDefault(machineName(hostname))
    )
    const chosenConfigDir = yield* Config.option(Config.String("CLAUDE_CONFIG_DIR"))
    const claudeConfigDir = chosenConfigDir._tag === "Some" ? chosenConfigDir.value : path.join(home, ".claude")
    const secureStorageRead = Config.option(Config.String("CLAUDE_SECURESTORAGE_CONFIG_DIR"))
    const secureStorageDir = yield* (exactEnvironment === undefined
      ? secureStorageRead
      : secureStorageRead.pipe(Effect.provideService(ConfigProvider.ConfigProvider, exactEnvironment)))
    // The Keychain account, as Claude Code names it: USER, else the OS user, kept only when it is a
    // plain name.
    const named = yield* Config.String("USER").pipe(Config.withDefault(osUser))
    const user = /^[a-zA-Z0-9._-]+$/u.test(named) ? named : "claude-code-user"
    const claudeCredentials = yield* claudeCredentialsLocation({
      home,
      user,
      claudeConfigDir,
      configDirChosen: chosenConfigDir._tag === "Some",
      secureStorageDir: secureStorageDir._tag === "Some" ? secureStorageDir.value : undefined
    })
    const stateHome = yield* Config.String("XDG_STATE_HOME").pipe(
      Config.withDefault(path.join(home, ".local", "state"))
    )
    const claudeLimitSamples = yield* Config.String("AGENT_USAGE_CLAUDE_LIMITS").pipe(
      Config.withDefault(path.join(stateHome, "agent-usage", "claude-limits.jsonl"))
    )
    const codexHome = yield* Config.String("CODEX_HOME").pipe(Config.withDefault(path.join(home, ".codex")))
    const projects = yield* Config.schema(Projects, "AGENT_USAGE_PROJECTS").pipe(Config.withDefault([]))
    const config: AgentUsageConfig = {
      storeDirectory,
      projects,
      claudeConfigDir,
      claudeCredentials,
      roots: {
        claudeProjects: path.join(claudeConfigDir, "projects"),
        codexHome,
        claudeLimitSamples,
        machine
      }
    }
    return config
  })
