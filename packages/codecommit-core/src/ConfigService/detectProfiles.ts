/**
 * @internal
 */
import { Array as Arr, Config, Effect, HashMap, Option, pipe } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ProfileDetectionError } from "../Errors.js"
import { ConfigPaths, type DetectedProfile, parseAwsConfig } from "./internal.js"

/** The two files AWS profiles are read from. */
export interface AwsProfileSources {
  readonly config: string
  readonly credentials: string
}

/**
 * Where AWS profiles come from, resolved as the AWS CLI and SDK do: `AWS_CONFIG_FILE` and
 * `AWS_SHARED_CREDENTIALS_FILE` when set, else `~/.aws/config` and `~/.aws/credentials` under `home`.
 */
export const awsProfileSourcesIn = Effect.fn("ConfigService.awsProfileSourcesIn")(function*(
  home: string
): Effect.fn.Return<AwsProfileSources, never, Path.Path> {
  const path = yield* Path.Path
  // An empty variable counts as unset, as it does for the AWS CLI. Config.String fails only when the
  // config provider itself is broken, which is a defect rather than "no profiles".
  const fromEnv = (name: string) =>
    Config.option(Config.String(name)).pipe(
      Effect.orDie,
      Effect.map((value) => Option.getOrUndefined(Option.filter(value, (path) => path.length > 0)))
    )
  const config = yield* fromEnv("AWS_CONFIG_FILE")
  const credentials = yield* fromEnv("AWS_SHARED_CREDENTIALS_FILE")
  return {
    config: config ?? path.join(home, ".aws", "config"),
    credentials: credentials ?? path.join(home, ".aws", "credentials")
  }
})

/** {@link awsProfileSourcesIn} for the current home directory (`HOME`, else `USERPROFILE`). */
export const awsProfileSources: Effect.Effect<AwsProfileSources, ProfileDetectionError, Path.Path> = Config.String(
  "HOME"
).pipe(
  Config.orElse(() => Config.String("USERPROFILE")),
  Effect.catchIf(
    (_error): _error is Config.ConfigError => true,
    () => Effect.fail(new ProfileDetectionError({ message: "Could not determine home directory" }))
  ),
  Effect.flatMap(awsProfileSourcesIn)
)

/** Discover AWS CLI profiles for one explicit home directory, honouring the AWS file variables. */
export const discoverAwsProfiles = Effect.fn("ConfigService.discoverAwsProfiles")(function*(
  home: string
): Effect.fn.Return<ReadonlyArray<DetectedProfile>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const sources = yield* awsProfileSourcesIn(home)

  const read = (p: string) => fs.readFileString(p).pipe(Effect.catch(() => Effect.succeed("")))

  const [configContent, credsContent] = yield* Effect.all([read(sources.config), read(sources.credentials)])

  const profiles = [...parseAwsConfig(configContent), ...parseAwsConfig(credsContent)]

  return pipe(
    profiles,
    Arr.reduce(
      HashMap.empty<string, typeof profiles[number]>(),
      (map, p) =>
        HashMap.has(map, p.name) && (p.region === undefined || p.region === "us-east-1")
          ? map
          : HashMap.set(map, p.name, p)
    ),
    HashMap.values,
    Arr.fromIterable
  )
})

export const detectProfiles = Effect.gen(function*() {
  const paths = yield* ConfigPaths
  const home = yield* paths.homePath
  return yield* discoverAwsProfiles(home)
}).pipe(Effect.withSpan("ConfigService.detectProfiles"))
