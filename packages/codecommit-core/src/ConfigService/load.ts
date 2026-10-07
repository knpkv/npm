/**
 * @internal
 */
import { Effect, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import { ConfigError, ConfigParseError } from "../Errors.js"
import type { ProfileDetectionError } from "../Errors.js"
import {
  accountsFromDetected,
  ConfigPaths,
  type DetectedProfile,
  makeDefaultConfig,
  migrateLegacySandboxImage,
  TuiConfig
} from "./internal.js"

const emptyDetectedProfiles = (): ReadonlyArray<DetectedProfile> => []

export const makeLoad = Effect.fn("ConfigService.load")(function*(
  detectProfiles: Effect.Effect<
    ReadonlyArray<DetectedProfile>,
    ProfileDetectionError,
    FileSystem.FileSystem | Path.Path | ConfigPaths
  >
) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* ConfigPaths
  const configPath = yield* paths.configPath

  const exists = yield* fs.exists(configPath).pipe(
    Effect.mapError((e) => new ConfigError({ message: "FS Error", cause: e }))
  )

  if (!exists) {
    const detected = yield* detectProfiles.pipe(
      // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
      Effect.catch(() => Effect.succeed(emptyDetectedProfiles()))
    )
    if (detected.length > 0) {
      return makeDefaultConfig(detected)
    }
    return makeDefaultConfig()
  }

  const content = yield* fs.readFileString(configPath).pipe(
    Effect.mapError((e) => new ConfigError({ message: "Failed to read config file", cause: e }))
  )

  const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TuiConfig))(content).pipe(
    Effect.map(migrateLegacySandboxImage),
    Effect.mapError((cause) => new ConfigParseError({ path: configPath, cause }))
  )

  if (config.autoDetect && config.accounts.length === 0) {
    const detected = yield* detectProfiles.pipe(
      // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
      Effect.catch(() => Effect.succeed(emptyDetectedProfiles()))
    )
    if (detected.length > 0) {
      return {
        ...config,
        accounts: accountsFromDetected(detected)
      }
    }
  }

  return config
})
