/**
 * @internal
 */
import type { Path } from "@effect/platform"
import { FileSystem } from "@effect/platform"
import { Effect } from "effect"
import type { ConfigError, ProfileDetectionError } from "../Errors.js"
import { backup } from "./backup.js"
import { ConfigPaths, defaultSandboxConfig, type DetectedProfile, type TuiConfig } from "./internal.js"
import { save } from "./save.js"

export const makeReset = (
  detectProfiles: Effect.Effect<
    ReadonlyArray<DetectedProfile>,
    ProfileDetectionError,
    FileSystem.FileSystem | Path.Path | ConfigPaths
  >
): Effect.Effect<TuiConfig, ConfigError, FileSystem.FileSystem | Path.Path | ConfigPaths> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* ConfigPaths
    const configPath = yield* paths.configPath

    const exists = yield* fs.exists(configPath).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )

    if (exists) {
      yield* backup.pipe(
        Effect.catchAll((e) => e.message.includes("does not exist") ? Effect.void : Effect.fail(e))
      )
    }

    const detected = yield* detectProfiles.pipe(
      Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<DetectedProfile>))
    )

    const config: TuiConfig = {
      accounts: detected.map((p) => ({
        profile: p.name,
        regions: p.region ? [p.region] : [],
        enabled: false
      })),
      autoDetect: true,
      autoRefresh: true,
      refreshIntervalSeconds: 300,
      sandbox: defaultSandboxConfig
    }

    yield* save(config)
    return config
  }).pipe(Effect.withSpan("ConfigService.reset"))
