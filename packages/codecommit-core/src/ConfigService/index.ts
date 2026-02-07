/**
 * Configuration service for CodeCommit application.
 *
 * @category Config
 * @module
 */
import type { FileSystem, Path } from "@effect/platform"
import { Config, Context, Effect, Layer } from "effect"
import { ConfigError, ProfileDetectionError } from "../Errors.js"
import type { ConfigParseError } from "../Errors.js"
import { detectProfiles } from "./detectProfiles.js"
import type { DetectedProfile, TuiConfig } from "./internal.js"
import { ConfigPaths } from "./internal.js"
import { makeLoad } from "./load.js"
import { save } from "./save.js"

export { AccountConfig, DetectedProfile, TuiConfig } from "./internal.js"

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

export class ConfigService extends Context.Tag("@knpkv/codecommit-core/ConfigService")<
  ConfigService,
  {
    readonly load: Effect.Effect<TuiConfig, ConfigError | ConfigParseError>
    readonly save: (config: TuiConfig) => Effect.Effect<void, ConfigError>
    readonly detectProfiles: Effect.Effect<ReadonlyArray<DetectedProfile>, ProfileDetectionError>
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

    const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ConfigPaths>) =>
      Effect.provide(effect, ctx)

    const load = makeLoad(detectProfiles)

    return {
      load: provide(load),
      save: (config) => provide(save(config)),
      detectProfiles: provide(detectProfiles)
    }
  })
).pipe(Layer.provide(ConfigPathsLive))
