/**
 * Where this Machine's store and agent sessions live, from the environment.
 *
 * - `AGENT_USAGE_HOME` — the store directory (default `~/.local/share/agent-usage`)
 * - `AGENT_USAGE_MACHINE` — the Machine name (default: the short, lower-cased hostname)
 * - `CLAUDE_CONFIG_DIR` / `CODEX_HOME` — the agents' own roots (default `~/.claude`, `~/.codex`)
 *
 * @module
 */
import { Config, Effect, Path } from "effect"
import type { SourceRoots } from "../core/Ingest.js"

export interface AgentUsageConfig {
  readonly storeDirectory: string
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
    const config: AgentUsageConfig = {
      storeDirectory,
      claudeConfigDir,
      roots: {
        claudeProjects: path.join(claudeConfigDir, "projects"),
        codexSessions: path.join(codexHome, "sessions"),
        machine
      }
    }
    return config
  })
