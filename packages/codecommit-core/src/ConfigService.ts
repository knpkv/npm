import { FileSystem, Path } from "@effect/platform"
import { Config, Context, Data, Effect, Layer, Schema } from "effect"

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const AccountConfig = Schema.Struct({
  profile: Schema.String,
  regions: Schema.Array(Schema.String).pipe(Schema.optionalWith({ default: () => ["us-east-1"] })),
  enabled: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true }))
})

export type AccountConfig = Schema.Schema.Type<typeof AccountConfig>

export const TuiConfig = Schema.Struct({
  accounts: Schema.Array(AccountConfig),
  /** If true, auto-detect profiles from ~/.aws/config when accounts is empty */
  autoDetect: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true }))
})

export type TuiConfig = Schema.Schema.Type<typeof TuiConfig>

interface DetectedProfile {
  readonly name: string
  readonly region: string
}

/**
 * Parse AWS config file format
 */
const parseAwsConfig = (content: string): ReadonlyArray<DetectedProfile> => {
  const lines = content.split("\n")
  const profiles: Array<DetectedProfile> = []
  let current: { name: string; region?: string } | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue

    // Match [profile name], [default], or [name]
    const profileMatch = trimmed.match(/^\[(?:profile\s+)?(.+)\]$/)

    if (profileMatch?.[1]) {
      if (current && current.name) {
        profiles.push({ name: current.name, region: current.region ?? "us-east-1" })
      }
      current = { name: profileMatch[1].trim() }
    } else if (current && trimmed.includes("=")) {
      const [key, ...valueParts] = trimmed.split("=")
      const value = valueParts.join("=").trim()
      if (key?.trim().toLowerCase() === "region") {
        current.region = value
      }
    }
  }

  if (current && current.name) {
    profiles.push({ name: current.name, region: current.region ?? "us-east-1" })
  }

  // Filter out duplicates and empty names
  const seen = new Set<string>()
  return profiles.filter((p) => {
    if (!p.name || seen.has(p.name)) return false
    seen.add(p.name)
    return true
  })
}

export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  {
    readonly load: Effect.Effect<TuiConfig, ConfigError>
    readonly save: (config: TuiConfig) => Effect.Effect<void, ConfigError>
    readonly detectProfiles: Effect.Effect<ReadonlyArray<DetectedProfile>, ConfigError>
  }
>() {}

export const ConfigServiceLive = Layer.effect(
  ConfigService,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const home = (globalThis as any).process?.env?.HOME ?? (globalThis as any).process?.env?.USERPROFILE ?? ""

    const getConfigPath = Config.string("HOME").pipe(
      Config.map((h) => `${h}/.codecommit-tui.json`),
      Config.orElse(() =>
        Config.string("USERPROFILE").pipe(
          Config.map((h) => `${h}/.codecommit-tui.json`)
        )
      )
    )

    const resolveConfigPath = Effect.configProviderWith((provider) => provider.load(getConfigPath)).pipe(
      Effect.catchAll(() =>
        Effect.fail(new ConfigError({ message: "Could not determine home directory (HOME/USERPROFILE)" }))
      )
    )

    const detectProfiles: Effect.Effect<ReadonlyArray<DetectedProfile>, ConfigError> = Effect.gen(function*() {
      if (!home) return []

      const configPath = path.join(home, ".aws", "config")
      const credsPath = path.join(home, ".aws", "credentials")

      const read = (p: string) =>
        fs.readFileString(p).pipe(
          Effect.catchAll(() => Effect.succeed(""))
        )

      const [configContent, credsContent] = yield* Effect.all([
        read(configPath),
        read(credsPath)
      ])

      const profiles = [
        ...parseAwsConfig(configContent),
        ...parseAwsConfig(credsContent)
      ]

      // Merge and deduplicate
      const merged = new Map<string, DetectedProfile>()
      for (const p of profiles) {
        if (!merged.has(p.name) || p.region !== "us-east-1") {
          merged.set(p.name, p)
        }
      }

      return Array.from(merged.values())
    }).pipe(
      Effect.mapError((e) => new ConfigError({ message: "Failed to detect AWS profiles", cause: e }))
    )

    const save = (config: TuiConfig) =>
      Effect.gen(function*() {
        const configPath = yield* resolveConfigPath
        const content = JSON.stringify(config, null, 2)
        yield* fs.writeFileString(configPath, content).pipe(
          Effect.mapError((e) => new ConfigError({ message: "Failed to save config", cause: e }))
        )
      })

    const load: Effect.Effect<TuiConfig, ConfigError> = Effect.gen(function*() {
      const configPath = yield* resolveConfigPath

      const exists = yield* fs.exists(configPath).pipe(
        Effect.mapError((e) => new ConfigError({ message: "FS Error", cause: e }))
      )

      if (!exists) {
        // Auto-detect profiles when no config exists
        const detected = yield* detectProfiles.pipe(Effect.catchAll(() => Effect.succeed([])))
        if (detected.length > 0) {
          return {
            accounts: detected.map((p) => ({
              profile: p.name,
              regions: [p.region],
              enabled: true
            })),
            autoDetect: true
          }
        }
        return { accounts: [], autoDetect: true }
      }

      const content = yield* fs.readFileString(configPath).pipe(
        Effect.mapError((e) => new ConfigError({ message: "Failed to read config file", cause: e }))
      )

      const parse = Schema.decodeUnknown(TuiConfig)
      const config = yield* parse(JSON.parse(content)).pipe(
        Effect.mapError((e) => new ConfigError({ message: "Invalid config format", cause: e }))
      )

      // If config has autoDetect and no accounts, detect them
      if (config.autoDetect && config.accounts.length === 0) {
        const detected = yield* detectProfiles.pipe(Effect.catchAll(() => Effect.succeed([])))
        if (detected.length > 0) {
          return {
            ...config,
            accounts: detected.map((p) => ({
              profile: p.name,
              regions: [p.region],
              enabled: true
            }))
          }
        }
      }

      return config
    })

    return { load, save, detectProfiles }
  })
)
