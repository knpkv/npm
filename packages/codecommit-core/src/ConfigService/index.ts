/**
 * Configuration service for CodeCommit application.
 *
 * @category Config
 * @module
 */
import type { FileSystem, Path } from "@effect/platform"
import { Config, Context, Effect, Layer } from "effect"
import { EventsHub } from "../CacheService/EventsHub.js"
import { ConfigError, ProfileDetectionError } from "../Errors.js"
import type { ConfigParseError } from "../Errors.js"
import { backup } from "./backup.js"
import { detectProfiles } from "./detectProfiles.js"
import type { DetectedProfile, TuiConfig } from "./internal.js"
import { ConfigPaths } from "./internal.js"
import { makeLoad } from "./load.js"
import { makeReset } from "./reset.js"
import { save } from "./save.js"
import type { ConfigValidationResult } from "./validate.js"
import { validate } from "./validate.js"

export { AccountConfig, DetectedProfile, TuiConfig } from "./internal.js"
export { ConfigValidationResult } from "./validate.js"

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

export class ConfigService extends Context.Tag("@knpkv/codecommit-core/ConfigService")<
  ConfigService,
  {
    readonly load: Effect.Effect<TuiConfig, ConfigError | ConfigParseError>
    readonly save: (config: TuiConfig) => Effect.Effect<void, ConfigError>
    readonly detectProfiles: Effect.Effect<ReadonlyArray<DetectedProfile>, ProfileDetectionError>
    readonly getConfigPath: Effect.Effect<string, ConfigError>
    readonly backup: Effect.Effect<string, ConfigError>
    readonly reset: Effect.Effect<TuiConfig, ConfigError | ProfileDetectionError>
    readonly validate: Effect.Effect<ConfigValidationResult, ConfigError>
  }
>() {}

// ---------------------------------------------------------------------------
// Live Implementation
// ---------------------------------------------------------------------------

const ConfigPathsLive = Layer.effect(
  ConfigPaths,
  Effect.gen(function*() {
    const getConfigPath = Config.string("HOME").pipe(
      Config.map((h) => `${h}/.codecommit/config.json`),
      Config.orElse(() =>
        Config.string("USERPROFILE").pipe(
          Config.map((h) => `${h}/.codecommit/config.json`)
        )
      )
    )

    const getHomePath = Config.string("HOME").pipe(
      Config.orElse(() => Config.string("USERPROFILE"))
    )

    const configPath = Effect.configProviderWith((provider) => provider.load(getConfigPath)).pipe(
      Effect.catchAll(() =>
        Effect.fail(new ConfigError({ message: "Could not determine home directory (HOME/USERPROFILE)" }))
      )
    )

    const homePath = Effect.configProviderWith((provider) => provider.load(getHomePath)).pipe(
      Effect.catchAll(() => Effect.fail(new ProfileDetectionError({ message: "Could not determine home directory" })))
    )

    return { configPath, homePath }
  })
)

export const ConfigServiceLive = Layer.effect(
  ConfigService,
  Effect.gen(function*() {
    const ctx = yield* Effect.context<FileSystem.FileSystem | Path.Path | ConfigPaths>()
    const hub = yield* EventsHub

    const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ConfigPaths>) =>
      Effect.provide(effect, ctx)

    const load = makeLoad(detectProfiles)
    const reset = makeReset(detectProfiles)

    return {
      load: provide(load),
      save: (config) => provide(save(config)).pipe(Effect.tap(() => hub.publish({ _tag: "Config" }))),
      detectProfiles: provide(detectProfiles),
      getConfigPath: provide(ConfigPaths.pipe(Effect.flatMap((p) => p.configPath))),
      backup: provide(backup),
      reset: provide(reset),
      validate: provide(validate)
    }
  })
).pipe(Layer.provide(ConfigPathsLive))
