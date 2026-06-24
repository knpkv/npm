import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import { Command, Flag as Options } from "effect/unstable/cli"

export const allSkillNames = ["codecommit", "confluence", "jira", "jcf"] as const

export type SkillName = typeof allSkillNames[number]
export type Agent = "codex" | "claude"
export type AgentSelection = Agent | "all"

export type InstallOptions = {
  readonly agent: AgentSelection
  readonly claudeDir?: string
  readonly codexDir?: string
  readonly dryRun: boolean
  readonly force: boolean
  readonly skills: ReadonlyArray<SkillName>
}

export type InstallResult = {
  readonly agent: Agent
  readonly destination: string
  readonly skill: SkillName
  readonly status: "copied" | "dry-run" | "skipped"
}

type InstallError = Config.ConfigError | PlatformError.BadArgument | PlatformError.PlatformError

type InstallContext = FileSystem.FileSystem | Path.Path

const homeDirectory = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE"))
)

const optionalEnv = (name: string) => Config.option(Config.string(name))

const defaultCodexDir = Effect.gen(function*() {
  const path = yield* Path.Path
  const codexHome = yield* optionalEnv("CODEX_HOME")
  if (Option.isSome(codexHome)) return path.join(codexHome.value, "skills")
  const home = yield* homeDirectory
  return path.join(home, ".codex", "skills")
})

const defaultClaudeDir = Effect.gen(function*() {
  const path = yield* Path.Path
  const claudeHome = yield* optionalEnv("CLAUDE_HOME")
  if (Option.isSome(claudeHome)) return path.join(claudeHome.value, "skills")
  const home = yield* homeDirectory
  return path.join(home, ".claude", "skills")
})

const bundledSkillsRoot = Effect.gen(function*() {
  const path = yield* Path.Path
  return yield* path.fromFileUrl(new URL("../skills", import.meta.url))
})

const selectedAgents = (agent: AgentSelection): ReadonlyArray<Agent> => agent === "all" ? ["codex", "claude"] : [agent]

const resolveInstallDirs = (options: {
  readonly agent: AgentSelection
  readonly claudeDir?: string
  readonly codexDir?: string
}): Effect.Effect<ReadonlyArray<readonly [Agent, string]>, Config.ConfigError, Path.Path> =>
  Effect.gen(function*() {
    const agents = selectedAgents(options.agent)
    const pairs: Array<readonly [Agent, string]> = []

    if (agents.includes("codex")) {
      const codexDir = options.codexDir ?? (yield* defaultCodexDir)
      pairs.push(["codex", codexDir])
    }

    if (agents.includes("claude")) {
      const claudeDir = options.claudeDir ?? (yield* defaultClaudeDir)
      pairs.push(["claude", claudeDir])
    }

    return pairs
  })

const installSkill = (params: {
  readonly agent: Agent
  readonly destinationRoot: string
  readonly dryRun: boolean
  readonly force: boolean
  readonly skill: SkillName
}): Effect.Effect<InstallResult, PlatformError.BadArgument | PlatformError.PlatformError, InstallContext> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const skillsRoot = yield* bundledSkillsRoot
    const destination = path.join(params.destinationRoot, params.skill)
    const source = path.join(skillsRoot, params.skill)
    const targetExists = yield* fs.exists(destination)

    if (params.dryRun) {
      return { agent: params.agent, destination, skill: params.skill, status: "dry-run" as const }
    }

    if (targetExists && !params.force) {
      return { agent: params.agent, destination, skill: params.skill, status: "skipped" as const }
    }

    if (targetExists) {
      yield* fs.remove(destination, { force: true, recursive: true })
    }

    yield* fs.makeDirectory(params.destinationRoot, { recursive: true })
    yield* fs.copy(source, destination)
    return { agent: params.agent, destination, skill: params.skill, status: "copied" as const }
  })

export const installSkills = (
  options: InstallOptions
): Effect.Effect<ReadonlyArray<InstallResult>, InstallError, InstallContext> =>
  Effect.gen(function*() {
    const installDirs = yield* resolveInstallDirs(options)
    const results: Array<InstallResult> = []

    for (const [targetAgent, destinationRoot] of installDirs) {
      for (const skill of options.skills) {
        const result = yield* installSkill({
          agent: targetAgent,
          destinationRoot,
          dryRun: options.dryRun,
          force: options.force,
          skill
        })
        results.push(result)
      }
    }

    return results
  })

export const renderInstallResult = (result: InstallResult): string => {
  const prefix = result.status === "copied"
    ? "installed"
    : result.status === "dry-run"
    ? "would install"
    : "skipped existing"
  return `${prefix}: ${result.agent}/${result.skill} -> ${result.destination}`
}

export const agentOption = Options.choice("agent", ["codex", "claude", "all"]).pipe(
  Options.withDescription("Agent skill home to install into"),
  Options.withDefault("all" as const)
)

export const codexDirOption = Options.directory("codex-dir").pipe(
  Options.withDescription("Override Codex skills directory"),
  Options.optional
)

export const claudeDirOption = Options.directory("claude-dir").pipe(
  Options.withDescription("Override Claude skills directory"),
  Options.optional
)

export const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Print planned installs without writing files"),
  Options.withDefault(false)
)

export const forceOption = Options.boolean("force").pipe(
  Options.withDescription("Replace existing skill directories"),
  Options.withDefault(false)
)

const optionValue = (option: Option.Option<string>): string | undefined =>
  Option.isSome(option) ? option.value : undefined

const optionalDirectoryOverrides = (options: {
  readonly claudeDir: Option.Option<string>
  readonly codexDir: Option.Option<string>
}): Pick<InstallOptions, "claudeDir" | "codexDir"> => {
  const overrides: { claudeDir?: string; codexDir?: string } = {}
  const claudeDir = optionValue(options.claudeDir)
  const codexDir = optionValue(options.codexDir)
  if (claudeDir !== undefined) overrides.claudeDir = claudeDir
  if (codexDir !== undefined) overrides.codexDir = codexDir
  return overrides
}

export const makeInstallCommand = (options: {
  readonly description: string
  readonly name: string
  readonly skills: ReadonlyArray<SkillName>
}) =>
  Command.make(
    options.name,
    {
      agent: agentOption,
      claudeDir: claudeDirOption,
      codexDir: codexDirOption,
      dryRun: dryRunOption,
      force: forceOption
    },
    ({ agent, claudeDir, codexDir, dryRun, force }) =>
      Effect.gen(function*() {
        const directoryOverrides = optionalDirectoryOverrides({ claudeDir, codexDir })
        const results = yield* installSkills({
          agent,
          dryRun,
          force,
          ...directoryOverrides,
          skills: options.skills
        })

        for (const result of results) {
          yield* Console.log(renderInstallResult(result))
        }

        if (!dryRun) {
          yield* Console.log("Restart Codex or Claude so the new skill metadata is loaded.")
        }
      })
  ).pipe(Command.withDescription(options.description))
