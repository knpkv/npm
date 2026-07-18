/**
 * @internal
 */
import { Array as Arr, Effect, HashMap, pipe } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ConfigPaths, type DetectedProfile, parseAwsConfig } from "./internal.js"

/** Discover AWS CLI profiles from one explicit home directory. */
export const discoverAwsProfiles = Effect.fn("ConfigService.discoverAwsProfiles")(function*(
  home: string
): Effect.fn.Return<ReadonlyArray<DetectedProfile>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const configPath = path.join(home, ".aws", "config")
  const credsPath = path.join(home, ".aws", "credentials")

  const read = (p: string) => fs.readFileString(p).pipe(Effect.catchCause(() => Effect.succeed("")))

  const [configContent, credsContent] = yield* Effect.all([read(configPath), read(credsPath)])

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
