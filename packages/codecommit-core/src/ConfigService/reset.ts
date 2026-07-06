/**
 * @internal
 */
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type { ProfileDetectionError } from "../Errors.js"
import { backup } from "./backup.js"
import { ConfigPaths, type DetectedProfile, makeDefaultConfig } from "./internal.js"
import { save } from "./save.js"

const emptyDetectedProfiles = (): ReadonlyArray<DetectedProfile> => []

export const makeReset = (
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
      Effect.catchCause(() => Effect.succeed(false))
    )

    if (exists) {
      yield* backup
    }

    const detected = yield* detectProfiles.pipe(
      Effect.catchCause(() => Effect.succeed(emptyDetectedProfiles()))
    )

    const config = makeDefaultConfig(detected)

    yield* save(config)
    return config
  }).pipe(Effect.withSpan("ConfigService.reset"))
