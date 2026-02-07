/**
 * @internal
 */
import type { Path } from "@effect/platform"
import { FileSystem } from "@effect/platform"
import { Effect, Schema } from "effect"
import { ConfigError, ConfigParseError } from "../Errors.js"
import type { ProfileDetectionError } from "../Errors.js"
import { ConfigPaths, type DetectedProfile, TuiConfig } from "./internal.js"

export const makeLoad = (
  detectProfiles: Effect.Effect<
    ReadonlyArray<DetectedProfile>,
    ProfileDetectionError,
    FileSystem.FileSystem | Path.Path | ConfigPaths
  >
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* ConfigPaths
    const configPath = yield* paths.configPath

    const exists = yield* fs.exists(configPath).pipe(
      Effect.mapError((e) => new ConfigError({ message: "FS Error", cause: e }))
    )

    if (!exists) {
      const detected = yield* detectProfiles.pipe(
        Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<DetectedProfile>))
      )
      if (detected.length > 0) {
        return {
          accounts: detected.map((p) => ({
            profile: p.name,
            regions: p.region ? [p.region] : [],
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

    const config = yield* Schema.decodeUnknown(Schema.parseJson(TuiConfig))(content).pipe(
      Effect.mapError((cause) => new ConfigParseError({ path: configPath, cause }))
    )

    if (config.autoDetect && config.accounts.length === 0) {
      const detected = yield* detectProfiles.pipe(
        Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<DetectedProfile>))
      )
      if (detected.length > 0) {
        return {
          ...config,
          accounts: detected.map((p) => ({
            profile: p.name,
            regions: p.region ? [p.region] : [],
            enabled: true
          }))
        }
      }
    }

    return config
  }).pipe(Effect.withSpan("ConfigService.load"))
