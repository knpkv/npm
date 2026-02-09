/**
 * @internal
 */
import { FileSystem } from "@effect/platform"
import { Effect, Either, ParseResult, Schema } from "effect"
import { ConfigError } from "../Errors.js"
import { ConfigPaths, TuiConfig } from "./internal.js"

export class ConfigValidationResult extends Schema.Class<ConfigValidationResult>("ConfigValidationResult")({
  status: Schema.Literal("valid", "missing", "corrupted"),
  path: Schema.String,
  errors: Schema.Array(Schema.String).pipe(Schema.optionalWith({ default: () => [] as Array<string> }))
}) {}

export const validate = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* ConfigPaths
  const configPath = yield* paths.configPath

  const exists = yield* fs.exists(configPath).pipe(
    Effect.mapError((e) => new ConfigError({ message: "FS Error", cause: e }))
  )
  if (!exists) {
    return new ConfigValidationResult({ status: "missing", path: configPath })
  }

  const content = yield* fs.readFileString(configPath).pipe(
    Effect.mapError((e) => new ConfigError({ message: "Failed to read config file", cause: e }))
  )

  const result = Schema.decodeUnknownEither(Schema.parseJson(TuiConfig))(content)
  return Either.match(result, {
    onLeft: (e) =>
      new ConfigValidationResult({
        status: "corrupted",
        path: configPath,
        errors: [ParseResult.TreeFormatter.formatErrorSync(e)]
      }),
    onRight: () => new ConfigValidationResult({ status: "valid", path: configPath })
  })
}).pipe(Effect.withSpan("ConfigService.validate"))
