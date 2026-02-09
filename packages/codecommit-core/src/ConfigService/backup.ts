/**
 * @internal
 */
import { FileSystem } from "@effect/platform"
import { Effect } from "effect"
import { ConfigError } from "../Errors.js"
import { ConfigPaths } from "./internal.js"

export const backup = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* ConfigPaths
  const configPath = yield* paths.configPath
  const backupPath = configPath + ".bak"

  const exists = yield* fs.exists(configPath).pipe(
    Effect.mapError((e) => new ConfigError({ message: "FS Error", cause: e }))
  )
  if (!exists) {
    return yield* new ConfigError({ message: "Config file does not exist, nothing to backup" })
  }

  const tmpPath = backupPath + ".tmp"
  yield* fs.copyFile(configPath, tmpPath).pipe(
    Effect.mapError((e) => new ConfigError({ message: "Failed to backup config", cause: e }))
  )
  yield* fs.rename(tmpPath, backupPath).pipe(
    Effect.mapError((e) => new ConfigError({ message: "Failed to rename backup", cause: e }))
  )
  return backupPath
}).pipe(Effect.withSpan("ConfigService.backup"))
