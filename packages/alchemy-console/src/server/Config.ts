import { Config, Effect, Path, Schema } from "effect"
import { readText } from "../internal/files.js"

export const Port = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65535 }))

export class StartupError extends Schema.TaggedError<StartupError>()("StartupError", {
  reason: Schema.Literals(["config", "invalid-port", "package"])
}) {}

/** Resolve the manifest beside the built executable; release version edits need no source change. */
export const readPackageVersion = Effect.fn("AlchemyConsole.readPackageVersion")(function*() {
  const path = yield* Path.Path
  const file = yield* path.fromFileUrl(new URL("../../package.json", import.meta.url)).pipe(
    Effect.mapError(() => new StartupError({ reason: "package" }))
  )
  return yield* readText(file).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString })))
    ),
    Effect.map(({ version }) => version),
    Effect.mapError(() => new StartupError({ reason: "package" }))
  )
})

/** Read paths once at executable startup. None of this configuration crosses HTTP or browser storage. */
export const loadConfig = Effect.fn("AlchemyConsole.loadConfig")(function*(home: string) {
  const path = yield* Path.Path
  return {
    root: yield* Config.String("ALCHEMY_CONSOLE_ROOT").pipe(Config.withDefault(path.join(home, "Work", "dev"))),
    awsConfigFile: yield* Config.String("AWS_CONFIG_FILE").pipe(Config.withDefault(path.join(home, ".aws", "config"))),
    directory: yield* Config.String("ALCHEMY_CONSOLE_HOME").pipe(
      Config.withDefault(path.join(home, ".cache", "alchemy-console"))
    )
  }
})
