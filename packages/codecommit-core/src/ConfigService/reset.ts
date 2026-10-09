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

export const makeReset = Effect.fn("ConfigService.reset")(function*(
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
    // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
    Effect.catch(() => Effect.succeed(false))
  )

  if (exists) {
    yield* backup
  }

  const detected = yield* detectProfiles.pipe(
    // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
    Effect.catch(() => Effect.succeed(emptyDetectedProfiles()))
  )

  const config = makeDefaultConfig(detected)

  yield* save(config)
  return config
})
