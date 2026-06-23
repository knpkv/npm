/**
 * @internal
 */
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ConfigError } from "../Errors.js"
import { ConfigPaths, type TuiConfig } from "./internal.js"

export const save = (config: TuiConfig) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const paths = yield* ConfigPaths
    const configPath = yield* paths.configPath
    const configDir = path.dirname(configPath)
    yield* fs.makeDirectory(configDir, { recursive: true }).pipe(
      Effect.mapError((e) => new ConfigError({ message: "Failed to create config directory", cause: e }))
    )
    const content = JSON.stringify(config, null, 2)
    yield* fs.writeFileString(configPath, content).pipe(
      Effect.mapError((e) => new ConfigError({ message: "Failed to save config", cause: e }))
    )
  }).pipe(Effect.withSpan("ConfigService.save"))
