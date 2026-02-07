/**
 * @internal
 */
import { FileSystem, Path } from "@effect/platform"
import { Array as Arr, Effect, HashMap, pipe } from "effect"
import { ConfigPaths, parseAwsConfig } from "./internal.js"

export const detectProfiles = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const paths = yield* ConfigPaths
  const home = yield* paths.homePath
  const configPath = path.join(home, ".aws", "config")
  const credsPath = path.join(home, ".aws", "credentials")

  const read = (p: string) => fs.readFileString(p).pipe(Effect.catchAll(() => Effect.succeed("")))

  const [configContent, credsContent] = yield* Effect.all([read(configPath), read(credsPath)])

  const profiles = [...parseAwsConfig(configContent), ...parseAwsConfig(credsContent)]

  return pipe(
    profiles,
    Arr.reduce(
      HashMap.empty<string, typeof profiles[number]>(),
      (map, p) =>
        HashMap.has(map, p.name) && p.region === "us-east-1"
          ? map
          : HashMap.set(map, p.name, p)
    ),
    HashMap.values,
    Arr.fromIterable
  )
}).pipe(Effect.withSpan("ConfigService.detectProfiles"))
