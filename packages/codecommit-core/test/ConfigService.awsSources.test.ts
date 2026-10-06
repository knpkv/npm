import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { awsProfileSourcesIn, discoverAwsProfiles } from "../src/ConfigService/index.js"

const withEnv = (env: Record<string, string>) =>
  Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

describe("AWS profile sources", () => {
  it.effect("reads ~/.aws/config and ~/.aws/credentials when the AWS file variables are unset", () =>
    Effect.gen(function*() {
      expect(yield* awsProfileSourcesIn("/home/someone")).toEqual({
        config: "/home/someone/.aws/config",
        credentials: "/home/someone/.aws/credentials"
      })
    }).pipe(Effect.provide(withEnv({}))))

  it.effect("follows AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE like the AWS CLI", () =>
    Effect.gen(function*() {
      expect(yield* awsProfileSourcesIn("/home/someone")).toEqual({
        config: "/etc/aws/shared-config",
        credentials: "/dev/null"
      })
    }).pipe(
      Effect.provide(
        withEnv({ AWS_CONFIG_FILE: "/etc/aws/shared-config", AWS_SHARED_CREDENTIALS_FILE: "/dev/null" })
      )
    ))

  it.effect("detects profiles from AWS_CONFIG_FILE outside the home directory", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const home = path.join(root, "home")
      const elsewhere = path.join(root, "elsewhere-config")
      yield* fs.makeDirectory(home)
      yield* fs.writeFileString(elsewhere, "[profile dev]\nregion = eu-central-1\n")
      const profiles = yield* discoverAwsProfiles(home).pipe(
        Effect.provide(withEnv({ AWS_CONFIG_FILE: elsewhere, AWS_SHARED_CREDENTIALS_FILE: "/dev/null" }))
      )
      expect(profiles.map((profile) => [profile.name, profile.region])).toEqual([["dev", "eu-central-1"]])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
