/**
 * @internal
 */
import { Effect, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import { ConfigError } from "../Errors.js"
import { ConfigPaths, TuiConfig } from "./internal.js"

const emptyErrors: Array<string> = []

export class ConfigValidationResult extends Schema.Class<ConfigValidationResult>("ConfigValidationResult")({
  status: Schema.Literals(["valid", "missing", "corrupted"]),
  path: Schema.String,
  errors: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(emptyErrors)))
}) {}

export const validate = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* ConfigPaths
  const configPath = yield* paths.configPath

  const exists = yield* fs.exists(configPath).pipe(
    Effect.mapError((e) => new ConfigError({ message: "FS Error", cause: e }))
  )
  if (!exists) {
    return new ConfigValidationResult({ status: "missing", path: configPath, errors: [] })
  }

  const content = yield* fs.readFileString(configPath).pipe(
    Effect.mapError((e) => new ConfigError({ message: "Failed to read config file", cause: e }))
  )

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TuiConfig))(content).pipe(
    Effect.match({
      onFailure: (error) =>
        new ConfigValidationResult({
          status: "corrupted",
          path: configPath,
          errors: [error.message]
        }),
      onSuccess: () => new ConfigValidationResult({ status: "valid", path: configPath, errors: [] })
    })
  )
}).pipe(Effect.withSpan("ConfigService.validate"))
