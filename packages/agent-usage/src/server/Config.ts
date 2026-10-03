/**
 * Where this Machine's store and agent sessions live, from the environment.
 *
 * - `AGENT_USAGE_HOME` — the store directory (default `~/.local/share/agent-usage`)
 * - `AGENT_USAGE_MACHINE` — the Machine name (default: the short, lower-cased hostname)
 * - `CLAUDE_CONFIG_DIR` / `CODEX_HOME` — the agents' own roots (default `~/.claude`, `~/.codex`)
 * - `AGENT_USAGE_PROJECTS` — extra Known Projects, comma-separated (`RPS,ABC`), for projects typed in
 *   sessions before any branch named them
 *
 * @module
 */
import { Config, Effect, Path, Schema, SchemaTransformation } from "effect"
import type { SourceRoots } from "../core/Ingest.js"

export interface AgentUsageConfig {
  readonly storeDirectory: string
  /** Known Projects from configuration, added to those branches and paths name. */
  readonly projects: ReadonlyArray<string>
  readonly claudeConfigDir: string
  readonly roots: SourceRoots
}

/**
 * The Machine name a hostname gives: the part before the first dot, lower-cased, so macOS's
 * `Andreys-MacBook.local` and `Andreys-MacBook` name the same Machine.
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

/** Reads the configuration; `hostname` comes from the executable, the only place that may ask. */
export const loadConfig = (hostname: string) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const home = yield* Config.String("HOME")
    const storeDirectory = yield* Config.String("AGENT_USAGE_HOME").pipe(
      Config.withDefault(path.join(home, ".local", "share", "agent-usage"))
    )
    const machine = yield* Config.NonEmptyString("AGENT_USAGE_MACHINE").pipe(
      Config.withDefault(machineName(hostname))
    )
    const claudeConfigDir = yield* Config.String("CLAUDE_CONFIG_DIR").pipe(
      Config.withDefault(path.join(home, ".claude"))
    )
    const codexHome = yield* Config.String("CODEX_HOME").pipe(Config.withDefault(path.join(home, ".codex")))
    const projects = yield* Config.schema(Projects, "AGENT_USAGE_PROJECTS").pipe(Config.withDefault([]))
    const config: AgentUsageConfig = {
      storeDirectory,
      projects,
      claudeConfigDir,
      roots: {
        claudeProjects: path.join(claudeConfigDir, "projects"),
        codexSessions: path.join(codexHome, "sessions"),
        machine
      }
    }
    return config
  })
