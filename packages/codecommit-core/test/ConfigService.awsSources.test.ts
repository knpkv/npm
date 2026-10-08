import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { awsProfileSourcesIn, discoverAwsProfiles } from "../src/ConfigService/index.js"

/** Runs an effect with exactly these environment variables visible to `Config`. */
const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))

describe("AWS profile sources", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("reads ~/.aws/config and ~/.aws/credentials when the AWS file variables are unset", () =>
      Effect.gen(function*() {
        expect(yield* awsProfileSourcesIn("/home/someone").pipe(withEnv({}))).toEqual({
          config: "/home/someone/.aws/config",
          credentials: "/home/someone/.aws/credentials"
        })
      }))

    it.effect("follows AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE like the AWS CLI; empty means unset", () =>
      Effect.gen(function*() {
        const sources = yield* awsProfileSourcesIn("/home/someone").pipe(
          withEnv({ AWS_CONFIG_FILE: "/etc/aws/shared-config", AWS_SHARED_CREDENTIALS_FILE: "/dev/null" })
        )
        expect(sources).toEqual({ config: "/etc/aws/shared-config", credentials: "/dev/null" })
        const empty = yield* awsProfileSourcesIn("/home/someone").pipe(withEnv({ AWS_CONFIG_FILE: "" }))
        expect(empty.config).toBe("/home/someone/.aws/config")
      }))

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
          withEnv({ AWS_CONFIG_FILE: elsewhere, AWS_SHARED_CREDENTIALS_FILE: "/dev/null" })
        )
        expect(profiles.map((profile) => [profile.name, profile.region])).toEqual([["dev", "eu-central-1"]])
      }).pipe(Effect.scoped))
  })
})
