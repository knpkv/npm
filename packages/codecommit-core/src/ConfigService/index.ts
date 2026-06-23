/**
 * Configuration service for CodeCommit application.
 *
 * @category Config
 * @module
 */
import { Config, Context, Effect, Layer } from "effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import { EventsHub } from "../CacheService/EventsHub.js"
import { ConfigError, ProfileDetectionError } from "../Errors.js"
import { backup } from "./backup.js"
import { detectProfiles } from "./detectProfiles.js"
import type { DetectedProfile, TuiConfig } from "./internal.js"
import { ConfigPaths } from "./internal.js"
import { makeLoad } from "./load.js"
import { makeReset } from "./reset.js"
import { save } from "./save.js"
import type { ConfigValidationResult } from "./validate.js"
import { validate } from "./validate.js"

export { AccountConfig, defaultSandboxConfig, DetectedProfile, SandboxConfig, TuiConfig } from "./internal.js"
export { ConfigValidationResult } from "./validate.js"

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

export class ConfigService extends Context.Service<
  ConfigService,
  {
    readonly load: Effect.Effect<TuiConfig, unknown>
    readonly save: (config: TuiConfig) => Effect.Effect<void, unknown>
    readonly detectProfiles: Effect.Effect<ReadonlyArray<DetectedProfile>, unknown>
    readonly getConfigPath: Effect.Effect<string, unknown>
    readonly backup: Effect.Effect<string, unknown>
    readonly reset: Effect.Effect<TuiConfig, unknown>
    readonly validate: Effect.Effect<ConfigValidationResult, unknown>
  }
>()("@knpkv/codecommit-core/ConfigService") {}

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

    const configPath = getConfigPath.pipe(
      Effect.catchIf(
        (error): error is Config.ConfigError => true,
        () => Effect.fail(new ConfigError({ message: "Could not determine home directory (HOME/USERPROFILE)" }))
      )
    )

    const homePath = getHomePath.pipe(
      Effect.catchIf(
        (error): error is Config.ConfigError => true,
        () => Effect.fail(new ProfileDetectionError({ message: "Could not determine home directory" }))
      )
    )

    return { configPath, homePath }
  })
)

export const ConfigServiceLive = Layer.effect(
  ConfigService,
  Effect.gen(function*() {
    const ctx = yield* Effect.context<FileSystem.FileSystem | Path.Path | ConfigPaths>()
    const hub = yield* EventsHub

    const provide = <A, E>(
      effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ConfigPaths>
    ): Effect.Effect<A, E> => Effect.provide(effect, ctx) as Effect.Effect<A, E>

    const detectProfilesLive = detectProfiles.pipe(
      Effect.mapError((cause) => new ProfileDetectionError({ message: "Failed to detect AWS profiles", cause }))
    )
    const load = makeLoad(detectProfilesLive)
    const reset = makeReset(detectProfilesLive)

    return {
      load: provide(load),
      save: (config) => provide(save(config)).pipe(Effect.tap(() => hub.publish({ _tag: "Config" }))),
      detectProfiles: provide(detectProfilesLive),
      getConfigPath: provide(ConfigPaths.pipe(Effect.flatMap((p) => p.configPath))),
      backup: provide(backup),
      reset: provide(reset),
      validate: provide(validate)
    }
  })
).pipe(Layer.provide(ConfigPathsLive))
